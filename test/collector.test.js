import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collect } from "../src/cli.js";
import { codexMarkdown, extractDocument, extractJsonCandidates, prepareScripts, rewriteCodexReferences } from "../src/extract.js";

const fixturePath = new URL("./fixtures/page.html", import.meta.url);
const html = await readFile(fixturePath, "utf8");

const ONE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const OTHER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADIgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function codexFixtureHtml(imgSrc) {
  return `<!doctype html><html><head><title>Codex Fixture</title></head><body>
<h1>THE CODEX OF BRANDON</h1>
<img src="${imgSrc}" alt="avatar">
<a href="../">🗺 Open your living map</a>
<h2>YOUR PEOPLE</h2><p>The realm endures.</p>
</body></html>`;
}

function routedServer(routes) {
  return createServer((request, response) => {
    const handler = routes[request.url] || routes["default"];
    if (!handler) { response.writeHead(404); response.end("not found"); return; }
    handler(request, response);
  });
}

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
    "codex/document.json", "codex/structure.json", "codex/scripts/index.json",
  ]) {
    assert.ok((await stat(join(result.current, relative))).isFile(), `${relative} should exist`);
  }
  const manifest = JSON.parse(await readFile(join(result.current, "manifest.json"), "utf8"));
  assert.equal(manifest.pages.map.status, 200);
  assert.match(manifest.pages.codex.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(stat(join(result.current, "codex/document.txt")), { code: "ENOENT" });
  await assert.rejects(stat(join(result.current, "codex/aggregate.md")), { code: "ENOENT" });
});

test("materializes Codex images and rewrites references at both depths", async (context) => {
  const codexHtml = codexFixtureHtml("/img/avatar.jpg");
  const server = routedServer({
    "/map": (_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8", etag: '"map"' }); res.end(html); },
    "/codex": (_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8", etag: '"codex"' }); res.end(codexHtml); },
    "/img/avatar.jpg": (_req, res) => { res.writeHead(200, { "content-type": "image/jpeg" }); res.end(ONE_PNG); },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const { port } = server.address();
  const output = await mkdtemp(join(tmpdir(), "collector-images-"));
  const result = await collect({ output, mapUrl: `http://127.0.0.1:${port}/map`, codexUrl: `http://127.0.0.1:${port}/codex` });

  assert.equal(result.status, "captured");
  const imageFile = join(result.current, "codex/images/001.jpg");
  assert.equal((await stat(imageFile)).isFile(), true, "codex/images/001.jpg should exist");
  assert.deepEqual(await readFile(imageFile), ONE_PNG, "materialized bytes must match the fetched PNG");

  const documentMd = await readFile(join(result.current, "codex/document.md"), "utf8");
  assert.match(documentMd, /!\[\[fragments\//, "document.md is the composite fragment entry point");

  const fragmentsDir = join(result.current, "codex/fragments");
  const fragmentFiles = (await readdir(fragmentsDir)).filter((name) => name.endsWith(".md")).sort();
  assert.ok(fragmentFiles.length, "fragments should be generated");
  const fragmentBodies = await Promise.all(fragmentFiles.map((name) => readFile(join(fragmentsDir, name), "utf8")));
  const fragmentWithImage = fragmentBodies.find((body) => body.includes("001.jpg"));
  assert.ok(fragmentWithImage, "some fragment should reference the materialized image");
  assert.match(fragmentWithImage, /\.\.\/images\/001\.jpg/, "fragments reference the image at fragment depth");
  const fragmentWithMap = fragmentBodies.find((body) => body.includes("map/map.md"));
  assert.ok(fragmentWithMap, "some fragment should reference the map note");
  assert.match(fragmentWithMap, /\]\(\.\.\/\.\.\/map\/map\.md\)/, "fragments rewrite the living-map link at fragment depth");
  assert.doesNotMatch(fragmentBodies.join("\n"), /\/img\/avatar\.jpg/, "no dangling source-relative image reference remains");

  const document = JSON.parse(await readFile(join(result.current, "codex/document.json"), "utf8"));
  const avatar = document.images.find((image) => image.originalSrc === "/img/avatar.jpg");
  assert.ok(avatar && avatar.materialized, "document.json records a materialized image entry");
  assert.equal(avatar.outputFile, "001.jpg");
  assert.equal(avatar.contentType, "image/jpeg");

  const manifest = JSON.parse(await readFile(join(result.current, "manifest.json"), "utf8"));
  assert.equal(manifest.pages.codex.imageCount, 1);
  assert.match(manifest.pages.codex.imageDigest, /^[a-f0-9]{64}$/);
  assert.equal(manifest.pages.codex.images[0].outputFile, "001.jpg");
});

test("non-image responses keep the absolute URL and are not materialized", async (context) => {
  const codexHtml = codexFixtureHtml("/img/not-an-image");
  const server = routedServer({
    "/map": (_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); },
    "/codex": (_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(codexHtml); },
    "/img/not-an-image": (_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end("<html></html>"); },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const { port } = server.address();
  const output = await mkdtemp(join(tmpdir(), "collector-image-fail-"));
  const result = await collect({ output, mapUrl: `http://127.0.0.1:${port}/map`, codexUrl: `http://127.0.0.1:${port}/codex` });

  const imagesDir = join(result.current, "codex/images");
  await assert.rejects(stat(imagesDir), "codex/images/ should not be created when no image materializes");

  const fragmentText = (await Promise.all((await readdir(join(result.current, "codex/fragments"))).map((name) => readFile(join(result.current, "codex/fragments", name), "utf8")))).join("\n");
  assert.match(fragmentText, /http:\/\/127\.0\.0\.1:\d+\/img\/not-an-image/, "failed image keeps the absolute upstream URL");

  const manifest = JSON.parse(await readFile(join(result.current, "manifest.json"), "utf8"));
  assert.equal(manifest.pages.codex.imageCount, 0);
  assert.equal(manifest.pages.codex.imageFailedCount, 1);
});

test("image-only changes produce a new capture even when raw HTML is unchanged", async (context) => {
  let imageBytes = ONE_PNG;
  const codexHtml = codexFixtureHtml("/img/avatar.jpg");
  const server = routedServer({
    "/map": (_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8", etag: '"map"' }); res.end(html); },
    "/codex": (_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8", etag: '"codex"' }); res.end(codexHtml); },
    "/img/avatar.jpg": (_req, res) => { res.writeHead(200, { "content-type": "image/jpeg" }); res.end(imageBytes); },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const { port } = server.address();
  const output = await mkdtemp(join(tmpdir(), "collector-image-digest-"));

  const first = await collect({ now: new Date("2026-07-26T12:00:00Z"), output, mapUrl: `http://127.0.0.1:${port}/map`, codexUrl: `http://127.0.0.1:${port}/codex` });
  assert.equal(first.status, "captured");

  // Same HTML + same image bytes => unchanged.
  const second = await collect({ now: new Date("2026-07-26T12:00:01Z"), output, mapUrl: `http://127.0.0.1:${port}/map`, codexUrl: `http://127.0.0.1:${port}/codex` });
  assert.equal(second.status, "unchanged", "identical HTML and images should be unchanged");

  // Same HTML but the avatar image bytes change => must capture.
  imageBytes = OTHER_PNG;
  const third = await collect({ now: new Date("2026-07-26T12:00:02Z"), output, mapUrl: `http://127.0.0.1:${port}/map`, codexUrl: `http://127.0.0.1:${port}/codex` });
  assert.equal(third.status, "captured", "image-only changes must trigger a new capture");
  assert.notEqual(third.captureId, first.captureId);
  const newImage = await readFile(join(third.current, "codex/images/001.jpg"));
  assert.deepEqual(newImage, OTHER_PNG, "the new capture materializes the changed image");
});

test("rewriteCodexReferences rewrites images and map links for a single depth", () => {
  const srcMap = new Map([["https://host.test/img/a.jpg", { outputFile: "001.jpg" }]]);
  const rewritten = rewriteCodexReferences(
    '<a href="../">map</a><img src="/img/a.jpg"><img src="/img/missing.jpg">',
    "https://host.test/codex/",
    srcMap,
    { imagePrefix: "images", mapHref: "../map/map.md" },
  );
  assert.match(rewritten, /src="images\/001\.jpg"/);
  assert.match(rewritten, /href="\.\.\/map\/map\.md"/);
  assert.match(rewritten, /src="https:\/\/host\.test\/img\/missing\.jpg"/, "unmapped images keep the absolute URL");
  assert.doesNotMatch(rewritten, /href="\.\.\/"/, "the raw ../ map link is no longer present");
});
