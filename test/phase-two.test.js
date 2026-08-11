import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collect } from "../src/cli.js";
import { fragmentCodex } from "../src/fragments.js";
import { discoverPreviousCapture, discoverSuccessfulCaptures } from "../src/history.js";
import { diffMaps, normalizeMap } from "../src/map.js";
import { deduplicateVault } from "../src/storage.js";

const mapCandidate = JSON.parse(await readFile(new URL("./fixtures/map-candidate.json", import.meta.url), "utf8"));

function page(title, body, candidate = null) {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}${candidate ? `<script type="application/json">${JSON.stringify(candidate)}</script>` : ""}</body></html>`;
}

async function fixtureServer(initialCodex, initialMap) {
  const state = { codex: initialCodex, map: initialMap };
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(request.url.includes("codex") ? state.codex : state.map);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, state, mapUrl: `http://127.0.0.1:${port}/map`, codexUrl: `http://127.0.0.1:${port}/codex` };
}

test("fragments headings, preserves catch-all content, and emits transclusions", () => {
  const html = page("Field Guide", "Introductory text without a heading.<h1>Overview</h1><p>Overview prose.</p><h2>Details</h2><p>Detailed prose.</p>");
  const result = fragmentCodex(html, { captureId: "2026-07-25T17-30-00Z", captureDate: "2026-07-25" });
  const ids = result.structure.fragments.map(({ id }) => id);
  assert.ok(ids.includes("preamble"));
  assert.ok(ids.includes("overview"));
  assert.ok(ids.includes("overview__details"));
  assert.match(Object.values(result.files).join("\n"), /Introductory text without a heading/);
  assert.match(result.aggregate, /!\[\[fragments\/\d{3}-preamble\.md\]\]/);
  assert.match(Object.values(result.files).join("\n"), /!\[\[\d{3}-details\.md\]\]/);
});

test("splits oversized sections only at block boundaries", () => {
  const paragraphs = Array.from({ length: 10 }, (_, index) => `<p>Paragraph ${index}: ${"word ".repeat(80)}</p>`).join("");
  const result = fragmentCodex(page("Large", `<h1>Large Section</h1>${paragraphs}`), {
    targetCharacters: 900,
    maximumCharacters: 1200,
    minimumCharacters: 100,
  });
  const parts = result.structure.fragments.filter(({ partOf }) => partOf === "large-section");
  assert.ok(parts.length > 1);
  for (const part of parts) assert.match(result.files[part.file], /Paragraph \d+:/);
  assert.equal((Object.values(result.files).join("\n").match(/Paragraph \d+:/g) || []).length, 10);
});

test("fragment logical IDs survive unrelated appended content", () => {
  const original = fragmentCodex(page("Guide", "<h1>Alpha</h1><p>A</p><h1>Beta</h1><p>B</p>"));
  const appended = fragmentCodex(page("Guide", "<h1>Alpha</h1><p>A</p><h1>Beta</h1><p>B</p><h1>Gamma</h1><p>C</p>"));
  assert.deepEqual(original.structure.fragments.map(({ id }) => id), appended.structure.fragments.slice(0, 2).map(({ id }) => id));
  assert.deepEqual(original.structure.fragments.map(({ contentHash }) => contentHash), appended.structure.fragments.slice(0, 2).map(({ contentHash }) => contentHash));
});

test("normalizes observed map records without dropping unknown fields", () => {
  const normalized = normalizeMap(mapCandidate, { captureId: "capture", imageSha256: "image-hash", sourceCandidatePath: "json-candidates/001.json" });
  assert.equal(normalized.coordinateSystem.type, "image-pixel");
  assert.equal(normalized.settlements.length, 2);
  assert.equal(normalized.markers.length, 1);
  assert.equal(normalized.labels.length, 1);
  assert.equal(normalized.settlements[0].sourcePath, "$.settlements[0]");
  assert.equal(normalized.settlements[0].extra.unknownFlag, true);
  assert.equal(normalized.settlements[0].original.unknownFlag, true);
  assert.ok(normalized.unclassified.some(({ collection }) => collection === "routes"));
  assert.ok(normalized.unclassified.some(({ field }) => field === "renderVersion"));
  assert.equal(normalized.validation.omittedSourceRecords, 0);
});

test("deduplicates identical vault files without changing their paths", async () => {
  const output = await mkdtemp(join(tmpdir(), "collector-dedupe-"));
  const first = join(output, "captures", "one.txt");
  const second = join(output, "current", "two.txt");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(output, "captures"), { recursive: true });
  await mkdir(join(output, "current"), { recursive: true });
  await writeFile(first, "same content\n");
  await writeFile(second, "same content\n");
  const result = await deduplicateVault(output);
  assert.equal(result.deduplicatedFiles, 1);
  assert.equal((await stat(first)).ino, (await stat(second)).ino);
  assert.equal(await readFile(second, "utf8"), "same content\n");
});

test("map IDs are stable across movement and movement is reported", () => {
  const movedCandidate = structuredClone(mapCandidate);
  movedCandidate.settlements[0].x += 20;
  movedCandidate.settlements[0].y += 4;
  const before = normalizeMap(mapCandidate);
  const after = normalizeMap(movedCandidate);
  assert.equal(before.settlements[0].id, after.settlements[0].id);
  const diff = diffMaps(after, before);
  assert.deepEqual(diff.moved[0], {
    id: "settlement__north-village",
    before: { x: 420, y: 240 },
    after: { x: 440, y: 244 },
  });
});

test("creates dated captures, discovers history, suppresses unchanged copies, and writes changed diffs", async (context) => {
  const largeList = `<h2>Entries</h2><ul>${Array.from({ length: 40 }, (_, index) => `<li>entry-${index + 1}-${"x".repeat(300)}<ul><li>nested-${index + 1}</li></ul></li>`).join("")}</ul>`;
  const codex = page("Guide", `<h1>Overview</h1><p>First version.</p>${largeList}`);
  const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const map = page("Map", `<h1>Static map</h1><img src="data:image/png;base64,${pixel}" alt="map">`, mapCandidate);
  const fixture = await fixtureServer(codex, map);
  context.after(() => fixture.server.close());
  const output = await mkdtemp(join(tmpdir(), "collector-phase-two-"));
  const options = { output, mapUrl: fixture.mapUrl, codexUrl: fixture.codexUrl, fragmentTarget: 6000, fragmentMax: 10000, fragmentMin: 800 };

  const first = await collect({ ...options, now: "2026-07-25T17:30:00.000Z" });
  assert.equal(first.status, "captured");
  assert.equal(first.captureId, "2026-07-25T17-30-00Z");
  assert.equal(first.captureDirectory, join(output, "captures", "2026-07-25", first.captureId));
  assert.match(await readFile(join(first.captureDirectory, "diff", "summary.md"), "utf8"), /No previous successful capture/);

  const incomplete = join(output, "captures", "2026-07-25", "2026-07-25T18-00-00Z");
  await (await import("node:fs/promises")).mkdir(incomplete);
  await writeFile(join(incomplete, "manifest.json"), "{}\n");
  const previous = await discoverPreviousCapture(output, "2026-07-25T19:00:00.000Z");
  assert.equal(previous.captureId, first.captureId);

  const second = await collect({ ...options, now: "2026-07-25T20:15:42.000Z" });
  assert.equal(second.status, "unchanged");
  assert.equal(second.previousCaptureId, first.captureId);
  assert.equal((await discoverSuccessfulCaptures(output)).length, 1);
  assert.equal((await readFile(join(output, "fetches.jsonl"), "utf8")).trim().split("\n").length, 2);

  fixture.state.codex = page("Guide", `<h1>Overview</h1><p>Second version.</p>${largeList}<h2>Appendix</h2><p>New material.</p>`);
  const third = await collect({ ...options, now: "2026-07-26T08:00:00.000Z" });
  assert.equal(third.status, "captured");
  assert.equal(third.previousCaptureId, first.captureId);
  assert.ok(third.diff.codex.added.includes("overview__appendix"));
  assert.ok(third.diff.codex.changed.includes("overview"));
  assert.match(await readFile(join(third.captureDirectory, "diff", "codex-text.patch"), "utf8"), /^--- /);

  for (const relative of [
    "manifest.json", "diff/summary.md", "diff/manifest.json", "diff/codex-text.patch", "diff/codex-structure.json",
    "diff/map-structure.json", "diff/raw-hashes.json", "codex/aggregate.md", "codex/structure.json",
    "map/source-candidate.json", "map/normalized.json", "map/map.md", "map/markers.json", "map/settlements.json",
    "map/labels.json", "map/unclassified.json", "map/validation.json", "map/annotated.svg", "map/annotated.png", "map/legend.json",
  ]) assert.ok((await stat(join(third.current, relative))).isFile(), `${relative} should exist`);
  assert.ok((await readdir(join(third.current, "codex", "fragments"))).length > 0);
  assert.equal(JSON.parse(await readFile(join(third.current, "manifest.json"), "utf8")).artifacts.splitLists, 1);
});
