import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collect } from "../src/cli.js";
import { codexMarkdown, extractDocument, extractJsonCandidates, prepareScripts } from "../src/extract.js";

const fixturePath = new URL("./fixtures/page.html", import.meta.url);
const html = await readFile(fixturePath, "utf8");

test("extracts readable text, headings, and codex Markdown", () => {
  const document = extractDocument(html, "https://example.test/codex/");
  assert.deepEqual(document.headings.map(({ text }) => text), ["Creatures of the North", "Glass Wolves"]);
  assert.match(document.visibleText, /Travelers record unusual creatures/);
  assert.doesNotMatch(document.visibleText, /must not be visible/);
  assert.doesNotMatch(document.visibleText, /window\.mapData/);
  const markdown = codexMarkdown(html);
  assert.match(markdown, /^# Creatures of the North/m);
  assert.match(markdown, /\| Name\s+\| Region\s+\|/);
  assert.match(markdown, /\[Read more\]\(\/codex\/wolf\)/);
});

test("extracts each inline script and inventories external scripts", async () => {
  const document = extractDocument(html, "https://example.test/");
  const prepared = await prepareScripts(document.scripts);
  assert.deepEqual(prepared.files.map(({ outputFile }) => outputFile), ["001.js", "002.js"]);
  assert.equal(prepared.index.length, 3);
  assert.equal(prepared.index[2].inline, false);
  assert.equal(prepared.index[2].src, "https://example.test/assets/app.js");
  assert.match(prepared.index[0].sha256, /^[a-f0-9]{64}$/);
});

test("does not report large data URIs as map identifiers", async () => {
  const { findMapIdentifiers } = await import("../src/extract.js");
  const identifiers = findMapIdentifiers('<img id="map" src="data:image/png;base64,d29ybGR3b3JsZA==">');
  assert.deepEqual(identifiers, [{ source: "img attribute", value: "id=map" }]);
});

test("extracts parseable named and JSON script candidates", () => {
  const scripts = extractDocument(html, "https://example.test/").scripts;
  const candidates = extractJsonCandidates(scripts);
  assert.equal(candidates.length, 2);
  assert.ok(candidates.every(({ parsed }) => parsed));
  assert.deepEqual(candidates[0].value.regions[0], { name: "North" });
  assert.deepEqual(candidates[1].value, { locations: ["ridge"] });
});

test("writes the expected capture and current artifact structure", async (context) => {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", etag: '"fixture"' });
    response.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const { port } = server.address();
  const output = await mkdtemp(join(tmpdir(), "collector-test-"));
  const result = await collect({ output, mapUrl: `http://127.0.0.1:${port}/map`, codexUrl: `http://127.0.0.1:${port}/codex` });

  for (const relative of [
    "manifest.json", "map/raw.html", "map/document.md", "map/document.txt", "map/document.json",
    "map/scripts/index.json", "map/json-candidates/index.json", "codex/raw.html", "codex/document.md",
    "codex/document.txt", "codex/document.json", "codex/scripts/index.json",
  ]) {
    assert.ok((await stat(join(result.current, relative))).isFile(), `${relative} should exist`);
  }
  const manifest = JSON.parse(await readFile(join(result.current, "manifest.json"), "utf8"));
  assert.equal(manifest.pages.map.status, 200);
  assert.match(manifest.pages.codex.sha256, /^[a-f0-9]{64}$/);
});
