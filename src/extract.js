import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import prettier from "prettier";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const DATA_NAME = /(map|data|location|region|marker|route|path|feature|geo|world)/i;
const HIDDEN_SELECTOR = [
  "style",
  "script",
  "template",
  "noscript",
  "[hidden]",
  '[aria-hidden="true"]',
  '[style*="display:none"]',
  '[style*="display: none"]',
  '[style*="visibility:hidden"]',
  '[style*="visibility: hidden"]',
].join(",");

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function cleanText(value) {
  return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function absoluteUrl(value, base) {
  if (!value) return null;
  try {
    return new URL(value, base).href;
  } catch {
    return value;
  }
}

function tableData($, table) {
  return $(table)
    .find("tr")
    .toArray()
    .map((row) =>
      $(row)
        .find("th, td")
        .toArray()
        .map((cell) => cleanText($(cell).text())),
    )
    .filter((row) => row.length);
}

function elementCounts($) {
  const counts = {};
  $("*").each((_, element) => {
    const tag = element.tagName?.toLowerCase();
    if (tag) counts[tag] = (counts[tag] ?? 0) + 1;
  });
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function metadata($) {
  const values = {};
  $("meta").each((_, element) => {
    const key = $(element).attr("name") || $(element).attr("property") || $(element).attr("http-equiv");
    const content = $(element).attr("content");
    if (key && content) values[key] = content;
  });
  return values;
}

export function extractDocument(html, url) {
  const $ = cheerio.load(html);
  const visible = cheerio.load($.html());
  visible(HIDDEN_SELECTOR).remove();

  const scripts = $("script")
    .toArray()
    .map((element, index) => ({
      sourceOrder: index + 1,
      type: $(element).attr("type") || "text/javascript",
      inline: !$(element).attr("src"),
      src: absoluteUrl($(element).attr("src"), url),
      originalSrc: $(element).attr("src") || null,
      content: $(element).html() || "",
    }));

  return {
    url,
    title: cleanText($("title").first().text()),
    metadata: metadata($),
    headings: $("h1, h2, h3, h4, h5, h6")
      .toArray()
      .map((element) => ({ level: Number(element.tagName.slice(1)), text: cleanText($(element).text()), id: $(element).attr("id") || null }))
      .filter(({ text }) => text),
    paragraphs: $("p")
      .toArray()
      .map((element) => cleanText($(element).text()))
      .filter(Boolean),
    lists: $("ul, ol")
      .toArray()
      .filter((element) => $(element).parents("ul, ol").length === 0)
      .map((element) => ({
        ordered: element.tagName === "ol",
        items: $(element)
          .children("li")
          .toArray()
          .map((item) => cleanText($(item).clone().children("ul, ol").remove().end().text()))
          .filter(Boolean),
      })),
    tables: $("table").toArray().map((table) => tableData($, table)),
    links: $("a[href]")
      .toArray()
      .map((element) => ({ text: cleanText($(element).text()), href: absoluteUrl($(element).attr("href"), url), originalHref: $(element).attr("href") })),
    images: $("img")
      .toArray()
      .map((element) => ({ src: absoluteUrl($(element).attr("src"), url), originalSrc: $(element).attr("src") || null, alt: $(element).attr("alt") || "", title: $(element).attr("title") || null })),
    svg: $("svg")
      .toArray()
      .map((element, index) => ({ index: index + 1, id: $(element).attr("id") || null, classes: $(element).attr("class") || null, viewBox: $(element).attr("viewBox") || null, text: cleanText($(element).text()), childCount: $(element).find("*").length })),
    scripts,
    elementCounts: elementCounts($),
    visibleText: cleanText(visible("body").text()),
  };
}

export function codexMarkdown(html) {
  const $ = cheerio.load(html);
  $(HIDDEN_SELECTOR).remove();
  const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-" });
  turndown.use(gfm);
  return `${turndown.turndown($("body").html() || "").trim()}\n`;
}

// Ordered, de-duplicated list of absolute HTTP(S) codex image URLs. Embedded
// `data:` URIs are handled separately by the caller and excluded here.
export function codexImageUrls(html, baseUrl) {
  const $ = cheerio.load(html);
  const seen = new Set();
  const urls = [];
  $("img").each((_, element) => {
    const original = $(element).attr("src");
    if (!original || /^data:/i.test(original)) return;
    const absolute = absoluteUrl(original, baseUrl);
    if (!absolute || !/^https?:/i.test(absolute)) return;
    if (!seen.has(absolute)) {
      seen.add(absolute);
      urls.push(absolute);
    }
  });
  return urls;
}

// Rewrite Codex DOM references so generated Markdown points at materialized
// local assets and the collected map note, while preserving raw.html verbatim.
// srcMap maps an absolute image URL to a fetch entry (with outputFile). Images
// that could not be materialized keep their absolute URL so the link still
// resolves upstream. The map `../` link is rewritten to mapHref only when the
// page is the Codex (caller controls mapHref depth).
export function rewriteCodexReferences(html, baseUrl, srcMap, { imagePrefix, mapHref }) {
  const $ = cheerio.load(html);
  $("img").each((_, element) => {
    const original = $(element).attr("src");
    if (!original || /^data:/i.test(original)) return;
    const absolute = absoluteUrl(original, baseUrl);
    const entry = srcMap.get(absolute);
    if (entry && entry.outputFile) {
      $(element).attr("src", `${imagePrefix}/${entry.outputFile}`);
    } else if (absolute && /^https?:/i.test(absolute)) {
      $(element).attr("src", absolute);
    }
  });
  if (mapHref) {
    $('a[href="../"]').each((_, element) => {
      $(element).attr("href", mapHref);
    });
  }
  return $.html();
}

function formatList(title, values, render) {
  const lines = [`## ${title}`, ""];
  if (!values.length) return [...lines, "None found.", ""];
  return [...lines, ...values.map(render), ""];
}

export function mapMarkdown(document, identifiers, scriptIndex, candidateIndex) {
  const lines = [
    `# Map inspection: ${document.title || "Untitled page"}`,
    "",
    `- Source: ${document.url}`,
    `- Visible text length: ${Buffer.byteLength(document.visibleText, "utf8")} bytes`,
    "",
    "## Visible text and labels",
    "",
    document.visibleText || "No visible text found.",
    "",
    ...formatList("Links", document.links, (item) => `- [${item.text || item.href}](${item.href})`),
    ...formatList("Images", document.images, (item, index) => `- Image ${index + 1}: ${item.outputFile ? `[${item.outputFile}](images/${item.outputFile})` : item.src || "no source"}; alt: ${item.alt || "(empty)"}${item.embedded ? `; embedded ${item.mimeType}, ${item.byteLength} bytes, SHA-256 ${item.sha256}` : ""}`),
    ...formatList("SVG inventory", document.svg, (item) => `- SVG ${item.index}: id=${item.id || "(none)"}, class=${item.classes || "(none)"}, viewBox=${item.viewBox || "(none)"}, descendants=${item.childCount}, text=${item.text || "(empty)"}`),
    "## DOM element counts",
    "",
    "| Element | Count |",
    "| --- | ---: |",
    ...Object.entries(document.elementCounts).map(([tag, count]) => `| ${tag} | ${count} |`),
    "",
    ...formatList("Script inventory", scriptIndex, (item) => item.inline
      ? `- ${item.sourceOrder}: inline ${item.type}, ${item.byteLength} bytes, [${item.outputFile}](scripts/${item.outputFile})`
      : `- ${item.sourceOrder}: external ${item.type}, [${item.originalSrc}](${item.src})`),
    ...formatList("Potential map-related identifiers", identifiers, (item) => `- \`${item.value.replace(/`/g, "\\`")}\` (${item.source})`),
    ...formatList("JSON candidates", candidateIndex, (item) => `- ${item.candidateName}: ${item.detectionMethod}, ${item.parseStatus}, ${item.approximateSize} bytes${item.outputFile ? `, [${item.outputFile}](json-candidates/${item.outputFile})` : ""}`),
  ];
  return `${lines.join("\n").trim()}\n`;
}

export function findMapIdentifiers(html) {
  const $ = cheerio.load(html);
  const found = new Map();
  $("*").each((_, element) => {
    for (const [name, value] of Object.entries(element.attribs || {})) {
      if (/^data:/i.test(value) || value.length > 500) continue;
      if (DATA_NAME.test(name) || DATA_NAME.test(value)) {
        const key = `${name}=${value}`;
        if (!found.has(key)) found.set(key, { source: `${element.tagName} attribute`, value: key });
      }
    }
  });
  return [...found.values()].slice(0, 500);
}

export async function prepareScripts(scripts) {
  const files = [];
  const index = [];
  for (const script of scripts) {
    let outputFile = null;
    let formatted = false;
    let content = script.content;
    if (script.inline) {
      outputFile = `${String(script.sourceOrder).padStart(3, "0")}.js`;
      if (content.trim() && /javascript|ecmascript|module/i.test(script.type)) {
        try {
          content = await prettier.format(content, { parser: "babel" });
          formatted = true;
        } catch {
          content = script.content;
        }
      }
      files.push({ outputFile, content });
    }
    index.push({
      sourceOrder: script.sourceOrder,
      type: script.type,
      inline: script.inline,
      src: script.src,
      originalSrc: script.originalSrc,
      byteLength: Buffer.byteLength(script.content, "utf8"),
      sha256: sha256(script.content),
      outputFile,
      formatted,
    });
  }
  return { files, index };
}

function matchingClose(source, start) {
  const pairs = { "{": "}", "[": "]" };
  const stack = [];
  let quote = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") quote = character;
    else if (pairs[character]) stack.push(pairs[character]);
    else if (character === stack.at(-1)) {
      stack.pop();
      if (!stack.length) return index;
    }
  }
  return -1;
}

function decodeStringLiteral(literal) {
  if (literal.startsWith('"')) return JSON.parse(literal);
  if (!literal.startsWith("'") || !literal.endsWith("'")) throw new Error("Unsupported string literal");
  const inner = literal.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"');
  return JSON.parse(`"${inner}"`);
}

function addCandidate(candidates, seen, script, method, name, raw, parsedHint) {
  const key = `${script.sourceOrder}:${raw}`;
  if (seen.has(key)) return;
  seen.add(key);
  let value = parsedHint;
  let error = null;
  if (value === undefined) {
    try {
      value = JSON.parse(raw);
    } catch (caught) {
      error = caught.message;
    }
  }
  candidates.push({ sourceScript: script.sourceOrder, detectionMethod: method, candidateName: name, raw, parsed: error === null, value, error });
}

export function extractJsonCandidates(scripts) {
  const candidates = [];
  const seen = new Set();
  for (const script of scripts.filter(({ inline }) => inline)) {
    const source = script.content.trim();
    if (!source) continue;
    if (/^(application|text)\/(json|ld\+json)$/i.test(script.type)) {
      addCandidate(candidates, seen, script, "JSON script block", `script-${script.sourceOrder}`, source);
    }

    const jsonParse = /JSON\.parse\(\s*((?:"(?:\\.|[^"\\])*")|(?:'(?:\\.|[^'\\])*'))\s*\)/g;
    for (const match of source.matchAll(jsonParse)) {
      try {
        const decoded = decodeStringLiteral(match[1]);
        addCandidate(candidates, seen, script, "JSON.parse argument", `json-parse-${match.index}`, decoded);
      } catch {
        addCandidate(candidates, seen, script, "JSON.parse argument", `json-parse-${match.index}`, match[1]);
      }
    }

    const assignment = /(?:\b(?:const|let|var)\s+|\bwindow\.|\bglobalThis\.)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*=\s*/g;
    for (const match of source.matchAll(assignment)) {
      const start = match.index + match[0].length;
      if (source[start] !== "{" && source[start] !== "[") continue;
      const end = matchingClose(source, start);
      if (end < 0) continue;
      const raw = source.slice(start, end + 1);
      if (DATA_NAME.test(match[1]) || Buffer.byteLength(raw, "utf8") >= 500) {
        addCandidate(candidates, seen, script, DATA_NAME.test(match[1]) ? "named assignment" : "large object or array assignment", match[1], raw);
      }
    }
  }
  return candidates;
}

export function serializeCandidates(candidates) {
  const files = [];
  const index = candidates.map((candidate, index) => {
    const stem = `${String(index + 1).padStart(3, "0")}-${candidate.candidateName.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 60) || "candidate"}`;
    const outputFile = `${stem}.${candidate.parsed ? "json" : "txt"}`;
    files.push({ outputFile, content: candidate.parsed ? `${JSON.stringify(candidate.value, null, 2)}\n` : candidate.raw });
    return {
      sourceScript: `../scripts/${String(candidate.sourceScript).padStart(3, "0")}.js`,
      detectionMethod: candidate.detectionMethod,
      candidateName: candidate.candidateName,
      parseStatus: candidate.parsed ? "parsed" : `unparsed: ${candidate.error}`,
      outputFile,
      approximateSize: Buffer.byteLength(candidate.raw, "utf8"),
    };
  });
  return { files, index };
}
