import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { sha256 } from "./extract.js";

const HIDDEN = "style,script,template,noscript,[hidden],[aria-hidden='true']";
const CONTAINERS = new Set(["body", "main", "article", "section", "div"]);

const clean = (value) => value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
const slug = (value) => clean(value).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "untitled";

function yaml(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(yaml).join(", ")}]`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(String(value));
}

function frontmatter(record, captureId, captureDate) {
  const fields = {
    generated: true,
    capture_id: captureId,
    capture_date: captureDate,
    source_key: "codex",
    fragment_id: record.id,
    parent_id: record.parentId,
    fragment_kind: record.fragmentKind || record.kind,
    table_index: record.tableIndex,
    source_row_start: record.sourceRowRange?.[0],
    source_row_end: record.sourceRowRange?.[1],
    list_index: record.listIndex,
    list_type: record.listType,
    source_item_start: record.sourceItemRange?.[0],
    source_item_end: record.sourceItemRange?.[1],
    source_block_start: record.sourceBlockRange?.[0],
    source_block_end: record.sourceBlockRange?.[1],
    source_order: record.sourceOrder,
    heading_path: record.headingPath,
    content_sha256: record.contentHash,
  };
  return `---\n${Object.entries(fields).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${yaml(value)}`).join("\n")}\n---\n\n`;
}

function orderedBlocks($) {
  const result = [];
  const walk = (node) => {
    if (node.type === "text") {
      if (clean(node.data || "")) result.push(node);
      return;
    }
    if (node.type !== "tag") return;
    const tag = node.name.toLowerCase();
    if (/^h[1-6]$/.test(tag) || !CONTAINERS.has(tag)) {
      result.push(node);
      return;
    }
    $(node).contents().toArray().forEach(walk);
  };
  $("body").contents().toArray().forEach(walk);
  return result;
}

function chunkBlocks(blocks, target, maximum, minimum) {
  if (!blocks.length) return [];
  const chunks = [];
  let current = [];
  const push = () => {
    if (!current.length) return;
    chunks.push({ markdown: current.map((block) => block.markdown).join("\n\n"), start: current[0].index, end: current.at(-1).index });
    current = [];
  };
  for (const block of blocks) {
    const candidate = [...current, block].map((item) => item.markdown).join("\n\n");
    if (current.length && candidate.length > maximum) push();
    current.push(block);
    const length = current.map((item) => item.markdown).join("\n\n").length;
    if (length >= target && length >= minimum) push();
  }
  push();
  return chunks;
}

export function splitMarkdownTable(markdown, { targetCharacters = 6000, maximumCharacters = 10000, tableIndex = 1 } = {}) {
  if (markdown.length <= maximumCharacters) return [];
  const lines = markdown.trim().split("\n");
  if (lines.length < 3 || !/^\s*\|/.test(lines[0]) || !/^\s*\|?\s*:?-+/.test(lines[1])) return [];
  const header = lines.slice(0, 2);
  const rows = lines.slice(2).filter((line) => line.trim());
  if (!rows.length) return [];
  const limit = Math.min(targetCharacters, maximumCharacters);
  const chunks = [];
  let current = [];
  let rowStart = 1;
  const push = () => {
    if (!current.length) return;
    const rowEnd = rowStart + current.length - 1;
    const rendered = [...header, ...current].join("\n");
    chunks.push({
      tableIndex,
      rowStart,
      rowEnd,
      header: header.join("\n"),
      rows: [...current],
      markdown: rendered,
      characterCount: rendered.length,
      contentHash: sha256(rendered),
      rowContentHash: sha256(current.join("\n")),
    });
    rowStart = rowEnd + 1;
    current = [];
  };
  for (const row of rows) {
    const candidate = [...header, ...current, row].join("\n");
    if (current.length && candidate.length > limit) push();
    current.push(row);
  }
  push();
  return chunks;
}

function topLevelListItems(markdown, listType) {
  const lines = markdown.trim().split("\n");
  const marker = listType === "ordered" ? /^\d+\.\s+/ : /^[-+*]\s+/;
  const starts = [];
  lines.forEach((line, index) => {
    if (marker.test(line)) starts.push(index);
  });
  return starts.map((start, index) => lines.slice(start, starts[index + 1] ?? lines.length).join("\n").trimEnd());
}

function applyOrderedNumbers(markdown, numbers) {
  let index = 0;
  return markdown.split("\n").map((line) => {
    if (!/^\d+\.\s+/.test(line)) return line;
    const number = numbers[index++] ?? index;
    return line.replace(/^\d+\.\s+/, `${number}.  `);
  }).join("\n");
}

export function splitMarkdownList(markdown, { targetCharacters = 6000, maximumCharacters = 10000, listIndex = 1, listType = "unordered" } = {}) {
  if (markdown.length <= maximumCharacters) return [];
  const items = topLevelListItems(markdown, listType);
  if (!items.length) return [];
  const limit = Math.min(targetCharacters, maximumCharacters);
  const chunks = [];
  let current = [];
  let itemStart = 1;
  const push = () => {
    if (!current.length) return;
    const itemEnd = itemStart + current.length - 1;
    const rendered = current.join("\n");
    chunks.push({
      listIndex,
      listType,
      itemStart,
      itemEnd,
      items: [...current],
      markdown: rendered,
      characterCount: rendered.length,
      contentHash: sha256(rendered),
      itemContentHash: sha256(current.join("\n")),
    });
    itemStart = itemEnd + 1;
    current = [];
  };
  for (const item of items) {
    const candidate = [...current, item].join("\n");
    if (current.length && candidate.length > limit) push();
    current.push(item);
  }
  push();
  return chunks;
}

function structureNodes(structure) {
  return structure?.fragments || structure?.nodes || [];
}

export function buildAggregate(records, { captureId, captureDate, title = "Codex" } = {}) {
  const roots = records.filter((record) => record.parentId === null && !record.partOf);
  const header = frontmatter({ id: "codex", sourceOrder: 0, headingPath: [], contentHash: sha256(title) }, captureId, captureDate);
  return `${header}# ${title}\n\n${roots.map((record) => `![[fragments/${record.file.split("/").at(-1)}]]`).join("\n\n")}\n`;
}

export function fragmentCodex(html, options = {}) {
  const {
    captureId = null,
    captureDate = null,
    targetCharacters = 6000,
    maximumCharacters = 10000,
    minimumCharacters = 800,
    maximumHeadingDepth = 4,
  } = options;
  const $ = cheerio.load(html);
  $(HIDDEN).remove();
  const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-" });
  turndown.use(gfm);
  let tableIndex = 0;
  let listIndex = 0;
  const blocks = orderedBlocks($).map((element, index) => {
    const tag = element.name?.toLowerCase();
    if (tag === "table") tableIndex += 1;
    if (tag === "ul" || tag === "ol") listIndex += 1;
    const listType = tag === "ol" ? "ordered" : tag === "ul" ? "unordered" : null;
    let markdown = turndown.turndown($(element).toString()).trim();
    if (tag === "ol") {
      let number = Number($(element).attr("start") || 1);
      const numbers = $(element).children("li").toArray().map((item) => {
        const explicit = $(item).attr("value");
        if (explicit !== undefined && Number.isFinite(Number(explicit))) number = Number(explicit);
        const current = number;
        number += 1;
        return current;
      });
      markdown = applyOrderedNumbers(markdown, numbers);
    }
    return {
      index: index + 1,
      tag,
      tableIndex: tag === "table" ? tableIndex : null,
      listIndex: listType ? listIndex : null,
      listType,
      heading: /^h[1-6]$/.test(tag || "") ? { level: Number(tag.slice(1)), text: clean($(element).text()) } : null,
      markdown,
    };
  }).filter((block) => block.markdown && (!block.heading || block.heading.text));

  const headingLevels = blocks.filter((block) => block.heading).map((block) => block.heading.level);
  const baseLevel = headingLevels.length ? Math.min(...headingLevels) : 1;
  const root = { id: null, heading: null, headingLevel: 0, headingPath: [], blocks: [], children: [], parentId: null };
  const stack = [root];
  const occurrences = new Map();
  for (const block of blocks) {
    const depth = block.heading ? block.heading.level - baseLevel + 1 : null;
    if (block.heading && depth <= maximumHeadingDepth) {
      while (stack.length > depth) stack.pop();
      const parent = stack.at(-1) || root;
      const baseId = [...parent.headingPath.map(slug), slug(block.heading.text)].join("__");
      const occurrence = (occurrences.get(baseId) || 0) + 1;
      occurrences.set(baseId, occurrence);
      const id = occurrence === 1 ? baseId : `${baseId}__${occurrence}`;
      const node = { id, heading: block.heading.text, headingLevel: block.heading.level, headingPath: [...parent.headingPath, block.heading.text], blocks: [], children: [], parentId: parent.id, headingBlock: block.index };
      parent.children.push(node);
      stack.length = depth;
      stack.push(node);
    } else {
      stack.at(-1).blocks.push(block);
    }
  }
  if (root.blocks.length || !root.children.length) {
    root.children.unshift({ id: "preamble", heading: "Preamble", headingLevel: 1, headingPath: ["Preamble"], blocks: root.blocks, children: [], parentId: null, headingBlock: null });
  }

  const records = [];
  let oversizedTableCount = 0;
  let splitTableCount = 0;
  let tableChunkCount = 0;
  let oversizedListCount = 0;
  let splitListCount = 0;
  let listChunkCount = 0;
  let listSourceItemCount = 0;
  const addNode = (node) => {
    const tableSplits = new Map();
    for (const block of node.blocks.filter(({ tag, markdown }) => tag === "table" && markdown.length > maximumCharacters)) {
      oversizedTableCount += 1;
      const chunks = splitMarkdownTable(block.markdown, { targetCharacters, maximumCharacters, tableIndex: block.tableIndex });
      if (chunks.length) {
        splitTableCount += 1;
        tableChunkCount += chunks.length;
        tableSplits.set(block.index, chunks);
      }
    }
    const listSplits = new Map();
    for (const block of node.blocks.filter(({ tag, markdown }) => (tag === "ul" || tag === "ol") && markdown.length > maximumCharacters)) {
      oversizedListCount += 1;
      const chunks = splitMarkdownList(block.markdown, { targetCharacters, maximumCharacters, listIndex: block.listIndex, listType: block.listType });
      if (chunks.length) {
        splitListCount += 1;
        listChunkCount += chunks.length;
        listSourceItemCount += chunks.reduce((count, chunk) => count + chunk.items.length, 0);
        listSplits.set(block.index, chunks);
      }
    }
    const segments = [];
    let regularBlocks = [];
    const flushRegular = () => {
      if (!regularBlocks.length) return;
      for (const chunk of chunkBlocks(regularBlocks, targetCharacters, maximumCharacters, minimumCharacters)) segments.push({ type: "content", ...chunk });
      regularBlocks = [];
    };
    for (const block of node.blocks) {
      if (!tableSplits.has(block.index) && !listSplits.has(block.index)) {
        regularBlocks.push(block);
        continue;
      }
      flushRegular();
      for (const chunk of tableSplits.get(block.index) || []) segments.push({ type: "table", sourceBlock: block.index, ...chunk });
      for (const chunk of listSplits.get(block.index) || []) segments.push({ type: "list", sourceBlock: block.index, ...chunk });
    }
    flushRegular();
    const hasSplitTable = tableSplits.size > 0;
    const hasSplitList = listSplits.size > 0;
    const createSegmentChildren = hasSplitTable || hasSplitList || segments.length > 1;
    const aggregate = node.children.length > 0 || createSegmentChildren;
    const directContent = segments.length === 1 && !createSegmentChildren ? segments[0].markdown : "";
    const tableHeaderContent = [...tableSplits.values()].map((chunks) => chunks[0].header).join("\n\n");
    const record = {
      id: node.id,
      kind: aggregate ? "aggregate" : "leaf",
      heading: node.heading,
      headingLevel: node.headingLevel,
      headingPath: node.headingPath,
      sourceOrder: records.length + 1,
      characterCount: directContent.length,
      contentHash: sha256(hasSplitTable ? tableHeaderContent : directContent),
      parentId: node.parentId,
      childIds: [],
      sourceBlockRange: node.blocks.length ? [node.blocks[0].index, node.blocks.at(-1).index] : null,
      directContent,
    };
    records.push(record);
    if (createSegmentChildren) {
      let contentPart = 0;
      segments.forEach((chunk) => {
        if (chunk.type === "content") contentPart += 1;
        const structuredId = chunk.type === "table"
          ? `table-${chunk.tableIndex}__rows-${chunk.rowStart}-${chunk.rowEnd}`
          : chunk.type === "list"
            ? `list-${chunk.listIndex}__items-${chunk.itemStart}-${chunk.itemEnd}`
            : `part-${contentPart}`;
        const part = {
          id: `${node.id}__${structuredId}`,
          kind: "leaf",
          fragmentKind: chunk.type === "table" ? "table-chunk" : chunk.type === "list" ? "list-chunk" : "content-chunk",
          heading: chunk.type === "table" || chunk.type === "list" ? null : `${node.heading} (part ${contentPart})`,
          headingLevel: node.headingLevel,
          headingPath: [...node.headingPath, chunk.type === "table"
            ? `Table ${chunk.tableIndex}, rows ${chunk.rowStart}-${chunk.rowEnd}`
            : chunk.type === "list"
              ? `List ${chunk.listIndex}, items ${chunk.itemStart}-${chunk.itemEnd}`
              : `Part ${contentPart}`],
          sourceOrder: records.length + 1,
          characterCount: chunk.markdown.length,
          contentHash: chunk.contentHash || sha256(chunk.markdown),
          rowContentHash: chunk.rowContentHash,
          itemContentHash: chunk.itemContentHash,
          parentId: node.id,
          childIds: [],
          sourceBlockRange: chunk.type === "table" || chunk.type === "list" ? [chunk.sourceBlock, chunk.sourceBlock] : [chunk.start, chunk.end],
          tableIndex: chunk.type === "table" ? chunk.tableIndex : undefined,
          sourceRowRange: chunk.type === "table" ? [chunk.rowStart, chunk.rowEnd] : undefined,
          listIndex: chunk.type === "list" ? chunk.listIndex : undefined,
          listType: chunk.type === "list" ? chunk.listType : undefined,
          sourceItemRange: chunk.type === "list" ? [chunk.itemStart, chunk.itemEnd] : undefined,
          directContent: chunk.markdown,
          partOf: node.id,
        };
        records.push(part);
        record.childIds.push(part.id);
      });
    }
    for (const child of node.children) {
      addNode(child);
      record.childIds.push(child.id);
    }
  };
  root.children.forEach(addNode);

  const byId = new Map(records.map((record) => [record.id, record]));
  for (const record of records) {
    const prefix = String(record.sourceOrder).padStart(3, "0");
    record.file = `fragments/${prefix}-${slug(record.id.split("__").at(-1))}.md`;
  }
  const files = {};
  for (const record of records) {
    const children = record.childIds.map((id) => byId.get(id));
    const body = [record.heading ? `${"#".repeat(Math.max(1, Math.min(6, record.headingLevel)))} ${record.heading}` : "", record.directContent, ...children.map((child) => `![[${child.file.split("/").at(-1)}]]`)].filter(Boolean).join("\n\n");
    files[record.file] = `${frontmatter(record, captureId, captureDate)}${body}\n`;
    delete record.directContent;
  }
  const title = clean($("title").first().text()) || root.children[0]?.heading || "Codex";
  const aggregate = buildAggregate(records, { captureId, captureDate, title });
  const structure = {
    captureId,
    captureDate,
    title,
    fragmentation: {
      targetCharacters,
      maximumCharacters,
      minimumCharacters,
      maximumHeadingDepth,
      oversizedTables: oversizedTableCount,
      splitTables: splitTableCount,
      tableChunks: tableChunkCount,
      oversizedLists: oversizedListCount,
      splitLists: splitListCount,
      listChunks: listChunkCount,
      listSourceItems: listSourceItemCount,
      omittedListItems: 0,
      duplicatedListItems: 0,
      reorderedListItems: 0,
      detachedNestedChildren: 0,
    },
    fragments: records,
  };
  return { files, aggregate, structure };
}

export function diffCodexStructures(current, previous) {
  const now = new Map(structureNodes(current).map((record) => [record.id, record]));
  const old = new Map(structureNodes(previous).map((record) => [record.id, record]));
  const added = [...now.keys()].filter((id) => !old.has(id));
  const removed = [...old.keys()].filter((id) => !now.has(id));
  const changed = [];
  const unchanged = [];
  const headingChanges = [];
  const parentChanges = [];
  const sourceOrderChanges = [];
  for (const [id, record] of now) {
    const before = old.get(id);
    if (!before) continue;
    const currentHash = record.fragmentKind === "table-chunk" ? record.rowContentHash : record.fragmentKind === "list-chunk" ? record.itemContentHash : record.contentHash;
    const previousHash = before.fragmentKind === "table-chunk" ? before.rowContentHash : before.fragmentKind === "list-chunk" ? before.itemContentHash : before.contentHash;
    (currentHash === previousHash ? unchanged : changed).push(id);
    if (record.heading !== before.heading) headingChanges.push({ id, before: before.heading, after: record.heading });
    if (record.parentId !== before.parentId) parentChanges.push({ id, before: before.parentId, after: record.parentId });
    if (record.sourceOrder !== before.sourceOrder) sourceOrderChanges.push({ id, before: before.sourceOrder, after: record.sourceOrder });
  }
  return { added, removed, changed, unchanged, headingChanges, parentChanges, sourceOrderChanges };
}
