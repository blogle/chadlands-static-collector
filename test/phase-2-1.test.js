import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";
import { buildMapAnnotation, renderAnnotatedPng } from "../src/annotate.js";
import { diffCodexStructures, fragmentCodex, splitMarkdownList, splitMarkdownTable } from "../src/fragments.js";
import { normalizeMap } from "../src/map.js";

const mapCandidate = JSON.parse(await readFile(new URL("./fixtures/map-candidate.json", import.meta.url), "utf8"));

function markdownTable(rowCount, rowSize = 70) {
  const rows = Array.from({ length: rowCount }, (_, index) => `| ${index + 1} | row-${index + 1}-${"x".repeat(rowSize)} |`);
  return ["| Index | Event |", "| ---: | --- |", ...rows].join("\n");
}

function htmlTable(rowCount, rowSize = 70) {
  const rows = Array.from({ length: rowCount }, (_, index) => `<tr><td>${index + 1}</td><td>row-${index + 1}-${"x".repeat(rowSize)}</td></tr>`).join("");
  return `<html><head><title>Rows</title></head><body><h1>Chronicle</h1><table><thead><tr><th>Index</th><th>Event</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
}

test("splits oversized Markdown tables at complete ordered rows", () => {
  const source = markdownTable(7);
  const chunks = splitMarkdownTable(source, { targetCharacters: 220, maximumCharacters: 260, tableIndex: 3 });
  assert.ok(chunks.length > 1);
  const sourceRows = source.split("\n").slice(2);
  assert.deepEqual(chunks.flatMap(({ rows }) => rows), sourceRows);
  for (const chunk of chunks) {
    assert.equal(chunk.markdown.split("\n")[0], "| Index | Event |");
    assert.equal(chunk.markdown.split("\n")[1], "| ---: | --- |");
    assert.equal(chunk.tableIndex, 3);
  }
});

test("retains a single oversized table row intact", () => {
  const source = markdownTable(1, 500);
  const [chunk] = splitMarkdownTable(source, { targetCharacters: 100, maximumCharacters: 150 });
  assert.equal(chunk.rows.length, 1);
  assert.equal(chunk.rows[0], source.split("\n")[2]);
  assert.ok(chunk.characterCount > 150);
});

test("table fragments use stable row-range IDs, hierarchy, and diffs", () => {
  const options = { targetCharacters: 220, maximumCharacters: 260, minimumCharacters: 50 };
  const before = fragmentCodex(htmlTable(4), options);
  const after = fragmentCodex(htmlTable(6), options);
  const beforeChunks = before.structure.fragments.filter(({ fragmentKind }) => fragmentKind === "table-chunk");
  const afterChunks = after.structure.fragments.filter(({ fragmentKind }) => fragmentKind === "table-chunk");
  assert.ok(beforeChunks.length > 1);
  assert.deepEqual(beforeChunks.map(({ id }) => id), afterChunks.slice(0, beforeChunks.length).map(({ id }) => id));
  assert.ok(beforeChunks.every(({ id, tableIndex, sourceRowRange, parentId }) => id.includes(`table-${tableIndex}__rows-${sourceRowRange[0]}-${sourceRowRange[1]}`) && parentId === "chronicle"));
  const parent = before.structure.fragments.find(({ id }) => id === "chronicle");
  assert.equal(parent.kind, "aggregate");
  assert.equal(before.structure.fragmentation.oversizedTables, 1);
  assert.equal(before.structure.fragmentation.splitTables, 1);
  assert.equal(before.structure.fragmentation.tableChunks, beforeChunks.length);
  assert.deepEqual(parent.childIds, beforeChunks.map(({ id }) => id));
  const parentMarkdown = before.files[parent.file];
  let lastPosition = -1;
  for (const chunk of beforeChunks) {
    const filename = chunk.file.split("/").at(-1);
    const position = parentMarkdown.indexOf(`![[${filename}]]`);
    assert.ok(position > lastPosition);
    lastPosition = position;
    assert.equal(chunk.tableIndex, 1);
    assert.ok(chunk.sourceRowRange[0] <= chunk.sourceRowRange[1]);
  }
  const diff = diffCodexStructures(after.structure, before.structure);
  assert.ok(beforeChunks.every(({ id }) => diff.unchanged.includes(id)));
  assert.ok(diff.added.some((id) => id.includes("__table-1__rows-")));
});

test("annotates valid records with escaped labels and distinct SVG symbols", async () => {
  const candidate = structuredClone(mapCandidate);
  candidate.markers[0].x = candidate.seat.x;
  candidate.markers[0].y = candidate.seat.y;
  candidate.markers[0].name = '<script>alert("x")</script> & observer';
  candidate.markers.push({ name: "Invalid", x: "10", y: 10 });
  candidate.settlements[1].x = 5000;
  candidate.points = [{ name: "Unknown Point", x: 100, y: 120, custom: true }];
  const normalized = normalizeMap(candidate);
  const annotation = buildMapAnnotation(normalized);

  assert.match(annotation.svg, /<image href="overview\.png"/);
  assert.match(annotation.svg, /<polygon data-kind="seat"/);
  assert.match(annotation.svg, /<circle data-kind="settlement"/);
  assert.match(annotation.svg, /<rect data-kind="marker"/);
  assert.match(annotation.svg, /<g data-kind="label"/);
  assert.match(annotation.svg, /<polygon data-kind="unclassified"/);
  assert.doesNotMatch(annotation.svg, /<script>/);
  assert.match(annotation.svg, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; observer/);
  assert.equal(annotation.validation.recordsWithInvalidCoordinates, 1);
  assert.equal(annotation.validation.recordsOutsideImageBounds, 1);
  assert.equal(annotation.validation.duplicateCoordinateCount, 1);
  assert.ok(annotation.validation.labelOffsetCount >= 1);
  assert.equal(annotation.legend.records.filter(({ rendered }) => rendered).length, annotation.validation.renderedRecordCount);
  assert.ok(annotation.legend.records.some(({ name, rendered }) => name === "Unknown Point" && rendered));

  const base = await sharp({ create: { width: 1024, height: 768, channels: 4, background: "white" } }).png().toBuffer();
  const png = await renderAnnotatedPng(annotation.svg, base);
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.width, 1024);
  assert.equal(metadata.height, 768);
  assert.equal(metadata.format, "png");
});

test("reports unsupported coordinate systems without rendering", () => {
  const normalized = normalizeMap(mapCandidate);
  normalized.coordinateSystem = { type: "geographic", origin: "unknown", width: 1024, height: 768 };
  const annotation = buildMapAnnotation(normalized);
  assert.equal(annotation.svg, null);
  assert.equal(annotation.validation.unsupportedCoordinateSystem, true);
  assert.equal(annotation.validation.renderedRecordCount, 0);
  assert.equal(annotation.validation.skippedRecordCount, annotation.legend.records.length);
});

function unorderedList(itemCount, itemSize = 80) {
  return Array.from({ length: itemCount }, (_, index) => [
    `* item-${index + 1}-${"x".repeat(itemSize)}`,
    "",
    `    continuation-${index + 1}`,
    "",
    `    * nested-${index + 1}`,
  ].join("\n")).join("\n");
}

function orderedListHtml(itemCount) {
  return `<html><head><title>Ordered</title></head><body><h1>Guide</h1><h2>Steps</h2><ol start="41">${Array.from({ length: itemCount }, (_, index) => `<li${index === 2 ? ' value="47"' : ""}>step-${index + 1}-${"x".repeat(90)}<p>continued-${index + 1}</p><ul><li>nested-${index + 1}</li></ul></li>`).join("")}</ol></body></html>`;
}

test("splits oversized unordered lists without detaching nested content", () => {
  const source = unorderedList(7);
  const chunks = splitMarkdownList(source, { targetCharacters: 300, maximumCharacters: 350, listIndex: 2, listType: "unordered" });
  assert.ok(chunks.length > 1);
  assert.equal(chunks.reduce((count, chunk) => count + chunk.items.length, 0), 7);
  assert.deepEqual(chunks.flatMap(({ items }) => items).map((item) => item.match(/item-(\d+)/)[1]), ["1", "2", "3", "4", "5", "6", "7"]);
  for (const chunk of chunks) {
    for (const item of chunk.items) {
      const number = item.match(/item-(\d+)/)[1];
      assert.match(item, new RegExp(`continuation-${number}`));
      assert.match(item, new RegExp(`nested-${number}`));
    }
  }
});

test("keeps one oversized list item intact", () => {
  const source = unorderedList(1, 600);
  const [chunk] = splitMarkdownList(source, { targetCharacters: 100, maximumCharacters: 150, listType: "unordered" });
  assert.equal(chunk.items.length, 1);
  assert.match(chunk.markdown, /continuation-1/);
  assert.match(chunk.markdown, /nested-1/);
  assert.ok(chunk.characterCount > 150);
});

test("ordered list chunks preserve numbering, stable IDs, hierarchy, and diffs", () => {
  const options = { targetCharacters: 260, maximumCharacters: 300, minimumCharacters: 50 };
  const before = fragmentCodex(orderedListHtml(5), options);
  const after = fragmentCodex(orderedListHtml(7), options);
  const beforeChunks = before.structure.fragments.filter(({ fragmentKind }) => fragmentKind === "list-chunk");
  const afterChunks = after.structure.fragments.filter(({ fragmentKind }) => fragmentKind === "list-chunk");
  assert.ok(beforeChunks.length > 1);
  assert.deepEqual(beforeChunks.map(({ id }) => id), afterChunks.slice(0, beforeChunks.length).map(({ id }) => id));
  assert.ok(beforeChunks.every(({ id, listType, listIndex, sourceItemRange, sourceBlockRange, parentId }) => id.includes(`list-${listIndex}__items-${sourceItemRange[0]}-${sourceItemRange[1]}`) && listType === "ordered" && sourceBlockRange.every(Number.isInteger) && parentId === "guide__steps"));
  const rendered = beforeChunks.map((chunk) => before.files[chunk.file]).join("\n");
  assert.match(rendered, /^41\.\s+/m);
  assert.match(rendered, /^42\.\s+/m);
  assert.match(rendered, /^47\.\s+/m);
  assert.match(rendered, /^48\.\s+/m);
  const parent = before.structure.fragments.find(({ id }) => id === "guide__steps");
  assert.equal(parent.kind, "aggregate");
  assert.deepEqual(parent.childIds, beforeChunks.map(({ id }) => id));
  let position = -1;
  for (const chunk of beforeChunks) {
    const next = before.files[parent.file].indexOf(`![[${chunk.file.split("/").at(-1)}]]`);
    assert.ok(next > position);
    position = next;
  }
  assert.equal(before.structure.fragmentation.oversizedLists, 1);
  assert.equal(before.structure.fragmentation.splitLists, 1);
  assert.equal(before.structure.fragmentation.listChunks, beforeChunks.length);
  assert.equal(before.structure.fragmentation.listSourceItems, 5);
  assert.equal(before.structure.fragmentation.omittedListItems, 0);
  assert.equal(before.structure.fragmentation.duplicatedListItems, 0);
  assert.equal(before.structure.fragmentation.reorderedListItems, 0);
  assert.equal(before.structure.fragmentation.detachedNestedChildren, 0);
  const diff = diffCodexStructures(after.structure, before.structure);
  assert.ok(beforeChunks.every(({ id }) => diff.unchanged.includes(id)));
  assert.ok(diff.added.some((id) => id.includes("__list-1__items-")));
});

test("ordered numbering rewrite leaves nested ordered lists unchanged", () => {
  const html = `<html><body><h1>Steps</h1><ol start="9"><li>${"outer-a ".repeat(30)}<ol><li>nested-a</li><li>nested-b</li></ol></li><li>${"outer-b ".repeat(30)}</li></ol></body></html>`;
  const result = fragmentCodex(html, { targetCharacters: 200, maximumCharacters: 250, minimumCharacters: 50 });
  const content = Object.values(result.files).join("\n");
  assert.match(content, /^9\.\s+/m);
  assert.match(content, /^10\.\s+/m);
  assert.match(content, /^\s+1\.\s+nested-a/m);
  assert.match(content, /^\s+2\.\s+nested-b/m);
});
