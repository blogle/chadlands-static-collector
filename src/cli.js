#!/usr/bin/env node

import { appendFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unifiedDiff } from "./diff.js";
import { buildMapAnnotation, renderAnnotatedPng } from "./annotate.js";
import { codexMarkdown, extractDocument, extractJsonCandidates, findMapIdentifiers, mapMarkdown as inspectionMarkdown, prepareScripts, serializeCandidates, sha256 } from "./extract.js";
import { diffCodexStructures, fragmentCodex } from "./fragments.js";
import { captureIdentity, discoverPreviousCapture } from "./history.js";
import { diffMaps, mapMarkdown, normalizeMap } from "./map.js";

const DEFAULT_MAP_URL = "https://mud.3zr4.com/maps/dv6uOmmTkKxKVJmmSU-tGA/";
const DEFAULT_CODEX_URL = "https://mud.3zr4.com/maps/dv6uOmmTkKxKVJmmSU-tGA/codex/";
const packageJson = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));

function usage() {
  return `Usage: chadlands-static-collector [options]\n\nOptions:\n  --output <directory>      Output root (default: /output in OCI, otherwise ./artifacts)\n  --map-url <url>           Override the map URL\n  --codex-url <url>         Override the codex URL\n  --fragment-target <chars> Preferred fragment size (default: 6000)\n  --fragment-max <chars>    Maximum fragment size at block boundaries (default: 10000)\n  --fragment-min <chars>    Minimum preferred fragment size (default: 800)\n  --help                    Show this help\n`;
}

export function parseArgs(argv, env = process.env) {
  const options = {
    output: env.COLLECTOR_OUTPUT || "./artifacts",
    mapUrl: DEFAULT_MAP_URL,
    codexUrl: DEFAULT_CODEX_URL,
    fragmentTarget: 6000,
    fragmentMax: 10000,
    fragmentMin: 800,
  };
  const keys = {
    "--output": "output",
    "--map-url": "mapUrl",
    "--codex-url": "codexUrl",
    "--fragment-target": "fragmentTarget",
    "--fragment-max": "fragmentMax",
    "--fragment-min": "fragmentMin",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { ...options, help: true };
    const key = keys[argument];
    if (!key || !argv[index + 1]) throw new Error(`Unknown or incomplete argument: ${argument}`);
    options[key] = key.startsWith("fragment") ? Number(argv[++index]) : argv[++index];
  }
  for (const key of ["fragmentTarget", "fragmentMax", "fragmentMin"]) {
    if (!Number.isInteger(options[key]) || options[key] < 1) throw new Error(`${key} must be a positive integer`);
  }
  if (options.fragmentMin > options.fragmentMax) throw new Error("fragmentMin cannot exceed fragmentMax");
  return options;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function appendFetch(output, record) {
  await appendFile(join(output, "fetches.jsonl"), `${JSON.stringify(record)}\n`);
}

async function fetchPage(name, url) {
  const response = await fetch(url, { headers: { "user-agent": `chadlands-static-collector/${packageJson.version}` }, redirect: "follow" });
  if (!response.ok) throw new Error(`${name} fetch failed: HTTP ${response.status} ${response.statusText}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (!body.length) throw new Error(`${name} fetch returned an empty body`);
  return { name, url: response.url, requestedUrl: url, response, body, html: body.toString("utf8"), sha256: sha256(body) };
}

async function writePage(page, captureDirectory, context) {
  const directory = join(captureDirectory, page.name);
  const scriptsDirectory = join(directory, "scripts");
  await mkdir(scriptsDirectory, { recursive: true });
  await writeFile(join(directory, "raw.html"), page.body);

  const document = { ...extractDocument(page.html, page.url), fetchedAt: context.attemptedAt };
  const sourceScripts = document.scripts;
  const embeddedImages = [];
  for (let index = 0; index < document.images.length; index += 1) {
    const image = document.images[index];
    const match = image.originalSrc?.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!match) continue;
    const mimeType = match[1] || "application/octet-stream";
    const bytes = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]), "utf8");
    const extension = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/svg+xml": "svg", "image/webp": "webp" }[mimeType] || "bin";
    const outputFile = `${String(index + 1).padStart(3, "0")}.${extension}`;
    embeddedImages.push({ outputFile, bytes, sha256: sha256(bytes) });
    Object.assign(image, {
      src: `data:${mimeType};${match[2] ? "base64," : ""}[embedded data omitted]`,
      originalSrc: null,
      embedded: true,
      mimeType,
      byteLength: bytes.length,
      sha256: embeddedImages.at(-1).sha256,
      outputFile,
    });
  }
  if (embeddedImages.length) {
    const imagesDirectory = join(directory, "images");
    await mkdir(imagesDirectory, { recursive: true });
    await Promise.all(embeddedImages.map(({ outputFile, bytes }) => writeFile(join(imagesDirectory, outputFile), bytes)));
  }

  const preparedScripts = await prepareScripts(sourceScripts);
  document.scripts = preparedScripts.index;
  await Promise.all(preparedScripts.files.map(({ outputFile, content }) => writeFile(join(scriptsDirectory, outputFile), content)));
  await writeJson(join(scriptsDirectory, "index.json"), preparedScripts.index);
  await writeFile(join(directory, "document.txt"), `${document.visibleText}\n`);

  if (page.name === "codex") {
    const markdown = codexMarkdown(page.html);
    await writeFile(join(directory, "document.md"), markdown);
    const fragmented = fragmentCodex(page.html, {
      captureId: context.captureId,
      captureDate: context.captureDate,
      targetCharacters: context.fragmentTarget,
      maximumCharacters: context.fragmentMax,
      minimumCharacters: context.fragmentMin,
      maximumHeadingDepth: 4,
    });
    await mkdir(join(directory, "fragments"), { recursive: true });
    await Promise.all(Object.entries(fragmented.files).map(([file, content]) => writeFile(join(directory, file), content)));
    await writeFile(join(directory, "aggregate.md"), fragmented.aggregate);
    await writeJson(join(directory, "structure.json"), fragmented.structure);
    await writeJson(join(directory, "document.json"), document);
    const sizes = fragmented.structure.fragments.map((fragment) => fragment.characterCount);
    return {
      scriptCount: preparedScripts.files.length,
      candidateCount: 0,
      markdown,
      structure: fragmented.structure,
      fragmentCount: sizes.length,
      smallestFragment: sizes.length ? Math.min(...sizes) : 0,
      largestFragment: sizes.length ? Math.max(...sizes) : 0,
      aggregateCount: fragmented.structure.fragments.filter(({ kind }) => kind === "aggregate").length,
      leafCount: fragmented.structure.fragments.filter(({ kind }) => kind === "leaf").length,
      oversizedTables: fragmented.structure.fragmentation.oversizedTables,
      splitTables: fragmented.structure.fragmentation.splitTables,
      tableChunks: fragmented.structure.fragmentation.tableChunks,
      oversizedLists: fragmented.structure.fragmentation.oversizedLists,
      splitLists: fragmented.structure.fragmentation.splitLists,
      listChunks: fragmented.structure.fragmentation.listChunks,
      listSourceItems: fragmented.structure.fragmentation.listSourceItems,
    };
  }

  const candidatesDirectory = join(directory, "json-candidates");
  await mkdir(candidatesDirectory, { recursive: true });
  const candidates = extractJsonCandidates(sourceScripts);
  const serialized = serializeCandidates(candidates);
  await Promise.all(serialized.files.map(({ outputFile, content }) => writeFile(join(candidatesDirectory, outputFile), content)));
  await writeJson(join(candidatesDirectory, "index.json"), serialized.index);
  const identifiers = findMapIdentifiers(page.html);
  document.mapRelatedIdentifiers = identifiers;
  document.jsonCandidates = serialized.index;
  await writeFile(join(directory, "document.md"), inspectionMarkdown(document, identifiers, preparedScripts.index, serialized.index));
  await writeJson(join(directory, "document.json"), document);

  const selectedIndex = candidates.findIndex((candidate) => candidate.parsed && candidate.value && typeof candidate.value === "object");
  const sourceCandidate = selectedIndex >= 0 ? candidates[selectedIndex].value : null;
  const candidatePath = selectedIndex >= 0 ? `json-candidates/${serialized.index[selectedIndex].outputFile}` : null;
  await writeJson(join(directory, "source-candidate.json"), sourceCandidate);
  if (embeddedImages[0]) await writeFile(join(directory, "overview.png"), embeddedImages[0].bytes);
  const normalized = normalizeMap(sourceCandidate, {
    captureId: context.captureId,
    imageSha256: embeddedImages[0]?.sha256 || null,
    sourceCandidatePath: candidatePath,
  });
  const annotation = buildMapAnnotation(normalized, { baseImageAvailable: Boolean(embeddedImages[0]) });
  if (annotation.svg && embeddedImages[0]) {
    await writeFile(join(directory, "annotated.svg"), annotation.svg);
    const annotatedPng = await renderAnnotatedPng(annotation.svg, embeddedImages[0].bytes);
    await writeFile(join(directory, "annotated.png"), annotatedPng);
    annotation.validation.annotatedPngGenerated = true;
    annotation.pngByteLength = annotatedPng.length;
  }
  Object.assign(normalized.validation, annotation.validation);
  await writeJson(join(directory, "normalized.json"), normalized);
  await writeJson(join(directory, "markers.json"), normalized.markers);
  await writeJson(join(directory, "settlements.json"), normalized.settlements);
  await writeJson(join(directory, "labels.json"), normalized.labels);
  await writeJson(join(directory, "unclassified.json"), normalized.unclassified);
  await writeJson(join(directory, "legend.json"), annotation.legend);
  await writeJson(join(directory, "validation.json"), normalized.validation);
  await writeFile(join(directory, "map.md"), mapMarkdown(normalized, candidatePath || "source-candidate.json"));
  return {
    scriptCount: preparedScripts.files.length,
    candidateCount: serialized.index.length,
    normalized,
    annotation,
    recordCounts: {
      settlements: normalized.settlements.length,
      markers: normalized.markers.length,
      labels: normalized.labels.length,
      unclassified: normalized.validation.unclassifiedRecords,
    },
  };
}

async function writeDiff(captureDirectory, currentManifest, currentStats, previous) {
  const directory = join(captureDirectory, "diff");
  await mkdir(directory, { recursive: true });
  const previousCodexStructure = previous ? await readJson(join(previous.path, "codex", "structure.json"), { fragments: [] }) : { fragments: [] };
  const previousMap = previous ? await readJson(join(previous.path, "map", "normalized.json"), {}) : {};
  const previousCodexMarkdown = previous ? await readFile(join(previous.path, "codex", "document.md"), "utf8").catch(() => "") : "";
  const codex = diffCodexStructures(currentStats.codex.structure, previousCodexStructure);
  const map = diffMaps(currentStats.map.normalized, previousMap);
  const codexTextChanged = currentStats.codex.markdown !== previousCodexMarkdown;
  const codexStructureChanged = codex.added.length + codex.removed.length + codex.changed.length + codex.headingChanges.length + codex.parentChanges.length > 0;
  const mapDataChanged = map.added.length + map.removed.length + map.changed.length > 0 || map.seatChanged || map.unclassified !== null;
  const manifest = {
    currentCaptureId: currentManifest.captureId,
    previousCaptureId: previous?.captureId || null,
    changed: true,
    sources: {
      codex: {
        rawChanged: !previous || currentManifest.pages.codex.sha256 !== previous.manifest.pages.codex.sha256,
        textChanged: !previous || codexTextChanged,
        structureChanged: !previous || codexStructureChanged,
      },
      map: {
        rawChanged: !previous || currentManifest.pages.map.sha256 !== previous.manifest.pages.map.sha256,
        dataChanged: !previous || mapDataChanged,
        imageChanged: !previous || map.imageHashChanged,
        annotatedSvgGenerated: currentStats.map.annotation.validation.annotatedSvgGenerated,
        annotatedPngGenerated: currentStats.map.annotation.validation.annotatedPngGenerated,
      },
    },
  };
  const summary = previous ? [
    "# Capture Diff",
    "",
    `Current capture: \`${currentManifest.captureId}\``,
    `Previous capture: \`${previous.captureId}\``,
    "",
    "## Codex",
    "",
    `- ${codex.added.length} fragments added`,
    `- ${codex.removed.length} fragments removed`,
    `- ${codex.changed.length} fragments changed`,
    `- ${codex.headingChanges.length} headings changed`,
    "",
    "## Map",
    "",
    `- ${map.added.length} records added`,
    `- ${map.removed.length} records removed`,
    `- ${map.changed.length} records changed`,
    `- ${map.moved.length} records moved`,
    `- Seat ${map.seatChanged ? "changed" : "unchanged"}`,
  ].join("\n") : `# Capture Diff\n\nCurrent capture: \`${currentManifest.captureId}\`\n\nNo previous successful capture exists.\n`;
  await writeFile(join(directory, "summary.md"), `${summary.trim()}\n`);
  await writeJson(join(directory, "manifest.json"), manifest);
  await writeFile(join(directory, "codex-text.patch"), previous ? unifiedDiff(previousCodexMarkdown, currentStats.codex.markdown, `${previous.captureId}/codex/document.md`, `${currentManifest.captureId}/codex/document.md`) : "");
  await writeJson(join(directory, "codex-structure.json"), codex);
  await writeJson(join(directory, "map-structure.json"), map);
  await writeJson(join(directory, "raw-hashes.json"), {
    previous: previous ? { map: previous.manifest.pages.map.sha256, codex: previous.manifest.pages.codex.sha256 } : null,
    current: { map: currentManifest.pages.map.sha256, codex: currentManifest.pages.codex.sha256 },
  });
  return { manifest, codex, map };
}

export async function collect(options) {
  const identity = captureIdentity(options.now || new Date());
  const output = resolve(options.output);
  await mkdir(output, { recursive: true });
  const previous = await discoverPreviousCapture(output, identity.attemptedAt);
  let map;
  let codex;
  try {
    [map, codex] = await Promise.all([fetchPage("map", options.mapUrl), fetchPage("codex", options.codexUrl)]);
    if (previous && map.sha256 === previous.manifest.pages.map.sha256 && codex.sha256 === previous.manifest.pages.codex.sha256) {
      await appendFetch(output, {
        attemptedAt: identity.attemptedAt,
        captureId: identity.captureId,
        status: "unchanged",
        mapSha256: map.sha256,
        codexSha256: codex.sha256,
        previousCaptureId: previous.captureId,
      });
      return { status: "unchanged", captureId: identity.captureId, previousCaptureId: previous.captureId, manifest: previous.manifest, captureDirectory: previous.path, current: join(output, "current") };
    }

    const dateDirectory = join(output, "captures", identity.captureDate);
    const captureDirectory = join(dateDirectory, identity.captureId);
    await mkdir(dateDirectory, { recursive: true });
    await mkdir(captureDirectory);
    const context = {
      ...identity,
      fragmentTarget: options.fragmentTarget ?? 6000,
      fragmentMax: options.fragmentMax ?? 10000,
      fragmentMin: options.fragmentMin ?? 800,
    };
    const stats = {};
    for (const page of [map, codex]) stats[page.name] = await writePage(page, captureDirectory, context);

    const manifest = {
      schemaVersion: 2,
      captureId: identity.captureId,
      captureDate: identity.captureDate,
      startedAt: identity.attemptedAt,
      completedAt: new Date().toISOString(),
      previousCaptureId: previous?.captureId || null,
      collectorVersion: packageJson.version,
      nodeVersion: process.version,
      pages: Object.fromEntries([map, codex].map((page) => [page.name, {
        url: page.url,
        requestedUrl: page.requestedUrl,
        status: page.response.status,
        contentType: page.response.headers.get("content-type"),
        byteLength: page.body.length,
        sha256: page.sha256,
        etag: page.response.headers.get("etag"),
        lastModified: page.response.headers.get("last-modified"),
        artifactDirectory: page.name,
        inlineScriptCount: stats[page.name].scriptCount,
        jsonCandidateCount: stats[page.name].candidateCount,
      }])),
      artifacts: {
        codexFragments: stats.codex.fragmentCount,
        codexAggregates: stats.codex.aggregateCount,
        codexLeaves: stats.codex.leafCount,
        oversizedTables: stats.codex.oversizedTables,
        splitTables: stats.codex.splitTables,
        tableChunks: stats.codex.tableChunks,
        oversizedLists: stats.codex.oversizedLists,
        splitLists: stats.codex.splitLists,
        listChunks: stats.codex.listChunks,
        listSourceItems: stats.codex.listSourceItems,
        mapRecords: stats.map.recordCounts,
        mapAnnotation: {
          rendered: stats.map.annotation.validation.renderedRecordCount,
          skipped: stats.map.annotation.validation.skippedRecordCount,
          annotatedSvgGenerated: stats.map.annotation.validation.annotatedSvgGenerated,
          annotatedPngGenerated: stats.map.annotation.validation.annotatedPngGenerated,
        },
      },
    };
    const diff = await writeDiff(captureDirectory, manifest, stats, previous);
    await writeJson(join(captureDirectory, "manifest.json"), manifest);
    const current = join(output, "current");
    await rm(current, { recursive: true, force: true });
    await cp(captureDirectory, current, { recursive: true });
    await appendFetch(output, {
      attemptedAt: identity.attemptedAt,
      captureId: identity.captureId,
      status: "captured",
      mapSha256: map.sha256,
      codexSha256: codex.sha256,
      previousCaptureId: previous?.captureId || null,
    });
    return { status: "captured", captureId: identity.captureId, previousCaptureId: previous?.captureId || null, manifest, captureDirectory, current, stats, diff };
  } catch (error) {
    try {
      await appendFetch(output, {
        attemptedAt: identity.attemptedAt,
        captureId: identity.captureId,
        status: "failed",
        mapSha256: map?.sha256 || null,
        codexSha256: codex?.sha256 || null,
        previousCaptureId: previous?.captureId || null,
        error: error.message,
      });
    } catch {
      // Preserve the collection failure when recording the attempt also fails.
    }
    throw error;
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
      return;
    }
    const result = await collect(options);
    if (result.status === "unchanged") {
      process.stdout.write(`Capture attempt ${result.captureId}: sources unchanged\nPrevious capture: ${result.previousCaptureId}\nCurrent copy: ${result.current}\n`);
      return;
    }
    process.stdout.write([
      `Capture ${result.captureId} written to ${result.captureDirectory}`,
      `Previous capture: ${result.previousCaptureId || "none"}`,
      `Codex fragments: ${result.stats.codex.fragmentCount}`,
      `Split tables: ${result.stats.codex.splitTables}`,
      `Table chunks: ${result.stats.codex.tableChunks}`,
      `Split lists: ${result.stats.codex.splitLists}`,
      `List chunks: ${result.stats.codex.listChunks}`,
      `Map records: ${result.stats.map.normalized.validation.normalizedRecords}`,
      `Map records rendered: ${result.stats.map.annotation.validation.renderedRecordCount}`,
      `Map records skipped: ${result.stats.map.annotation.validation.skippedRecordCount}`,
      `Annotated SVG: ${result.stats.map.annotation.validation.annotatedSvgGenerated ? "map/annotated.svg" : "not generated"}`,
      `Annotated PNG: ${result.stats.map.annotation.validation.annotatedPngGenerated ? "map/annotated.png" : "not generated"}`,
      `Diff summary: ${join(result.captureDirectory, "diff", "summary.md")}`,
      `Current copy: ${result.current}`,
    ].join("\n") + "\n");
  } catch (error) {
    process.stderr.write(`Collector failed: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
