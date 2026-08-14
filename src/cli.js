#!/usr/bin/env node

import { appendFile, cp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { unifiedDiff } from "./diff.js";
import { buildMapAnnotation, renderAnnotatedPng } from "./annotate.js";
import { absoluteUrl, codexImageUrls, codexMarkdown, extractDocument, extractJsonCandidates, findMapIdentifiers, mapMarkdown as inspectionMarkdown, prepareScripts, rewriteCodexReferences, serializeCandidates, sha256 } from "./extract.js";
import { diffCodexStructures, fragmentCodex } from "./fragments.js";
import { materializeCurrentCodex, writeSparseCodex } from "./codex.js";
import { migrateCodexSnapshots } from "./migrate.js";
import { captureIdentity, discoverPreviousCapture } from "./history.js";
import { diffMaps, mapMarkdown, normalizeMap } from "./map.js";

const DEFAULT_MAP_URL = "https://mud.3zr4.com/maps/dv6uOmmTkKxKVJmmSU-tGA/";
const DEFAULT_CODEX_URL = "https://mud.3zr4.com/maps/dv6uOmmTkKxKVJmmSU-tGA/codex/";
const packageJson = JSON.parse(await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));

function usage() {
  return `Usage: chadlands-static-collector [options]\n\nOptions:\n  --output <directory>      Output root (default: /output in OCI, otherwise ./artifacts)\n  --map-url <url>           Override the map URL\n  --codex-url <url>         Override the codex URL\n  --fragment-target <chars> Preferred fragment size (default: 6000)\n  --fragment-max <chars>    Maximum fragment size at block boundaries (default: 10000)\n  --fragment-min <chars>    Minimum preferred fragment size (default: 800)\n  --migrate-codex-snapshots Migrate existing captures only (dry-run by default)\n  --apply                   Apply a migration (requires --migrate-codex-snapshots)\n  --help                    Show this help\n`;
}

export function parseArgs(argv, env = process.env) {
  const options = {
    output: env.COLLECTOR_OUTPUT || "./artifacts",
    mapUrl: DEFAULT_MAP_URL,
    codexUrl: DEFAULT_CODEX_URL,
    fragmentTarget: 6000,
    fragmentMax: 10000,
    fragmentMin: 800,
    migrateCodexSnapshots: false,
    apply: false,
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
    if (argument === "--migrate-codex-snapshots") { options.migrateCodexSnapshots = true; continue; }
    if (argument === "--apply") { options.apply = true; continue; }
    const key = keys[argument];
    if (!key || !argv[index + 1]) throw new Error(`Unknown or incomplete argument: ${argument}`);
    options[key] = key.startsWith("fragment") ? Number(argv[++index]) : argv[++index];
  }
  for (const key of ["fragmentTarget", "fragmentMax", "fragmentMin"]) {
    if (!Number.isInteger(options[key]) || options[key] < 1) throw new Error(`${key} must be a positive integer`);
  }
  if (options.fragmentMin > options.fragmentMax) throw new Error("fragmentMin cannot exceed fragmentMax");
  if (options.apply && !options.migrateCodexSnapshots) throw new Error("--apply requires --migrate-codex-snapshots");
  return options;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeUnderdarkLayer(layer, mapDirectory, context) {
  if (!layer || typeof layer !== "object") return null;
  const directory = join(mapDirectory, "underdark");
  await mkdir(directory, { recursive: true });
  await writeJson(join(directory, "source.json"), layer);
  const imageMatch = typeof layer.img === "string" && layer.img.match(/^data:([^;,]+)?;base64,(.*)$/s);
  if (!imageMatch) return { layer: layer.layer ?? null, imageCount: 0, dotCount: layer.dots?.length || 0 };
  const image = Buffer.from(imageMatch[2], "base64");
  await writeFile(join(directory, "overview.png"), image);
  const candidate = { markers: layer.dots || [], img: { layer: layer.layer ?? null } };
  const normalized = normalizeMap(candidate, { captureId: context.captureId, imageSha256: sha256(image), sourceCandidatePath: "source.json" });
  await writeJson(join(directory, "normalized.json"), normalized);
  await writeJson(join(directory, "markers.json"), normalized.markers);
  await writeJson(join(directory, "validation.json"), normalized.validation);
  await writeFile(join(directory, "map.md"), mapMarkdown(normalized, "source.json"));
  return { layer: layer.layer ?? null, imageCount: 1, imageSha256: sha256(image), dotCount: layer.dots?.length || 0 };
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

async function requireManagedDirectory(root, path) {
  const [actualRoot, actualPath] = await Promise.all([realpath(root), realpath(path)]);
  const relation = relative(actualRoot, actualPath);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) throw new Error(`Managed output path escapes output root: ${path}`);
}

async function publishCurrent(output, captureDirectory) {
  const current = join(output, "current");
  const staging = join(output, `.current-${Date.now()}-${process.pid}.tmp`);
  const backup = join(output, `.current-${Date.now()}-${process.pid}.previous`);
  await rm(staging, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });
  await cp(captureDirectory, staging, { recursive: true });
  await materializeCurrentCodex(staging, captureDirectory, output);
  let backedUp = false;
  try {
    try { await rename(current, backup); backedUp = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
    await rename(staging, current);
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (backedUp) {
      await rm(current, { recursive: true, force: true });
      await rename(backup, current);
    }
    throw error;
  }
  return current;
}

async function fetchPage(name, url) {
  const response = await fetch(url, { headers: { "user-agent": `chadlands-static-collector/${packageJson.version}` }, redirect: "follow" });
  if (!response.ok) throw new Error(`${name} fetch failed: HTTP ${response.status} ${response.statusText}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (!body.length) throw new Error(`${name} fetch returned an empty body`);
  return { name, url: response.url, requestedUrl: url, response, body, html: body.toString("utf8"), sha256: sha256(body) };
}

const IMAGE_EXTENSION = { "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/gif": "gif", "image/svg+xml": "svg", "image/webp": "webp" };
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// Fetch every HTTP(S) Codex image once, in source order, with content-type and
// size validation. Successful downloads are returned with their bytes so the
// caller writes them under codex/images/. Failures keep the absolute URL so
// generated Markdown still resolves upstream. The returned digest lets the
// unchanged check detect image-only updates.
async function fetchCodexImages(page) {
  const urls = codexImageUrls(page.html, page.url);
  const entries = [];
  for (let index = 0; index < urls.length; index += 1) {
    const originalUrl = urls[index];
    try {
      const response = await fetch(originalUrl, { headers: { "user-agent": `chadlands-static-collector/${packageJson.version}` }, redirect: "follow" });
      if (!response.ok) {
        entries.push({ originalUrl, sourceOrder: index + 1, status: "failed", httpStatus: response.status, outputFile: null });
        continue;
      }
      const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length) {
        entries.push({ originalUrl, sourceOrder: index + 1, status: "failed", httpStatus: response.status, contentType, reason: "empty body", outputFile: null });
        continue;
      }
      if (bytes.length > MAX_IMAGE_BYTES) {
        entries.push({ originalUrl, sourceOrder: index + 1, status: "failed", httpStatus: response.status, contentType, reason: `exceeds ${MAX_IMAGE_BYTES} bytes`, byteLength: bytes.length, outputFile: null });
        continue;
      }
      if (!contentType || !/^image\//i.test(contentType)) {
        entries.push({ originalUrl, sourceOrder: index + 1, status: "failed", httpStatus: response.status, contentType, reason: "non-image content-type", byteLength: bytes.length, outputFile: null });
        continue;
      }
      const extension = IMAGE_EXTENSION[contentType] || "bin";
      const outputFile = `${String(index + 1).padStart(3, "0")}.${extension}`;
      entries.push({ originalUrl, sourceOrder: index + 1, status: "ok", httpStatus: response.status, contentType, byteLength: bytes.length, sha256: sha256(bytes), outputFile, bytes });
    } catch (error) {
      entries.push({ originalUrl, sourceOrder: index + 1, status: "failed", error: error.message, outputFile: null });
    }
  }
  const srcMap = new Map(entries.filter((entry) => entry.status === "ok").map((entry) => [entry.originalUrl, entry]));
  const digest = sha256(entries.map((entry) => `${entry.originalUrl}\0${entry.status}\0${entry.sha256 || ""}\0${entry.httpStatus || ""}\0${entry.contentType || ""}\0${entry.byteLength || ""}\0${entry.reason || ""}\0${entry.error || ""}`).join("\n"));
  const materialized = entries.filter((entry) => entry.status === "ok").length;
  return { entries, srcMap, digest, materialized };
}

async function writePage(page, captureDirectory, context) {
  const directory = join(captureDirectory, page.directory || page.name);
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
  if (page.name === "codex") {
    // Materialize HTTP(S) Codex images so generated Markdown references local
    // files instead of dangling source-relative URLs. Raw HTML stays verbatim.
    const codexImages = context.codexImages || { entries: [], srcMap: new Map(), digest: null, materialized: 0 };
    if (codexImages.materialized) {
      const imagesDirectory = join(directory, "images");
      await mkdir(imagesDirectory, { recursive: true });
      await Promise.all(codexImages.entries.filter((entry) => entry.status === "ok").map((entry) => writeFile(join(imagesDirectory, entry.outputFile), entry.bytes)));
    }
    for (const image of document.images) {
      if (!image.originalSrc || /^data:/i.test(image.originalSrc)) continue;
      const absolute = absoluteUrl(image.originalSrc, page.url);
      const entry = codexImages.srcMap.get(absolute);
      if (entry) {
        image.materialized = entry.status === "ok";
        image.outputFile = entry.outputFile;
        image.byteLength = entry.byteLength;
        image.sha256 = entry.sha256;
        image.contentType = entry.contentType;
        image.fetchStatus = entry.status;
        image.httpStatus = entry.httpStatus;
        image.fetchError = entry.error || entry.reason || null;
      } else {
        image.materialized = false;
        image.fetchStatus = "not-attempted";
      }
    }

    // Rewrite references for each depth: document.md lives in codex/, fragments
    // live in codex/fragments/. The collected map note is a sibling at map/map.md.
    const documentHtml = rewriteCodexReferences(page.html, page.url, codexImages.srcMap, { imagePrefix: "images", mapHref: "../map/map.md" });
    const fragmentsHtml = rewriteCodexReferences(page.html, page.url, codexImages.srcMap, { imagePrefix: "../images", mapHref: "../../map/map.md" });

    const markdown = codexMarkdown(documentHtml);
    const fragmented = fragmentCodex(fragmentsHtml, {
      captureId: context.captureId,
      captureDate: context.captureDate,
      targetCharacters: context.fragmentTarget,
      maximumCharacters: context.fragmentMax,
      minimumCharacters: context.fragmentMin,
      maximumHeadingDepth: 4,
    });
    await mkdir(join(directory, "fragments"), { recursive: true });
    await writeJson(join(directory, "document.json"), document);
    const sizes = fragmented.structure.fragments.map((fragment) => fragment.characterCount);
    return {
      scriptCount: preparedScripts.files.length,
      candidateCount: 0,
      markdown,
      visibleText: document.visibleText,
      structure: fragmented.structure,
      fragmentedFiles: fragmented.files,
      fragmentCount: sizes.length,
      smallestFragment: sizes.length ? Math.min(...sizes) : 0,
      largestFragment: sizes.length ? Math.max(...sizes) : 0,
      leafCount: fragmented.structure.fragments.filter(({ kind }) => kind === "leaf").length,
      oversizedTables: fragmented.structure.fragmentation.oversizedTables,
      splitTables: fragmented.structure.fragmentation.splitTables,
      tableChunks: fragmented.structure.fragmentation.tableChunks,
      oversizedLists: fragmented.structure.fragmentation.oversizedLists,
      splitLists: fragmented.structure.fragmentation.splitLists,
      listChunks: fragmented.structure.fragmentation.listChunks,
      listSourceItems: fragmented.structure.fragmentation.listSourceItems,
      imageCount: codexImages.materialized,
      imageFailedCount: codexImages.entries.filter((entry) => entry.status === "failed").length,
      imageDigest: codexImages.digest,
      images: codexImages.entries.map(({ bytes, ...entry }) => entry),
    };
  }

  await writeFile(join(directory, "document.txt"), `${document.visibleText}\n`);

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
  const underdark = await writeUnderdarkLayer(sourceCandidate?.underdark, directory, context);
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
    underdark,
  };
}

async function writeDiff(captureDirectory, currentManifest, currentStats, previous) {
  const directory = join(captureDirectory, "diff");
  await mkdir(directory, { recursive: true });
  const previousCodexStructure = previous ? await readJson(join(previous.path, "codex", "structure.json"), { fragments: [] }) : { fragments: [] };
  const previousMap = previous ? await readJson(join(previous.path, "map", "normalized.json"), {}) : {};
  const previousCodexText = previous ? (await readJson(join(previous.path, "codex", "document.json"), {})).visibleText || "" : "";
  const codex = diffCodexStructures(currentStats.codex.structure, previousCodexStructure);
  const map = diffMaps(currentStats.map.normalized, previousMap);
  const codexTextChanged = currentStats.codex.visibleText !== previousCodexText;
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
        imagesChanged: !previous || currentManifest.pages.codex.imageDigest !== (previous.manifest.pages.codex?.imageDigest ?? undefined),
        imageCount: currentManifest.pages.codex.imageCount ?? 0,
        imageFailedCount: currentManifest.pages.codex.imageFailedCount ?? 0,
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
  await writeFile(join(directory, "codex-text.patch"), previous ? unifiedDiff(previousCodexText, currentStats.codex.visibleText, `${previous.captureId}/codex/visible-text`, `${currentManifest.captureId}/codex/visible-text`) : "");
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
  const capturesRoot = join(output, "captures");
  await mkdir(capturesRoot, { recursive: true });
  await requireManagedDirectory(output, capturesRoot);
  const previous = await discoverPreviousCapture(output, identity.attemptedAt);
  let map;
  let codex;
  try {
    [map, codex] = await Promise.all([fetchPage("map", options.mapUrl), fetchPage("codex", options.codexUrl)]);
    map.directory = "map";
    // Fetch Codex images up front so image-only updates are detected even when
    // the raw HTML is unchanged, and so writePage can reuse the bytes.
    const codexImages = await fetchCodexImages(codex);
    const previousImageDigest = previous?.manifest?.pages?.codex?.imageDigest;
    const imageUnchanged = previousImageDigest !== undefined && codexImages.digest === previousImageDigest;
    if (previous && map.sha256 === previous.manifest.pages.map.sha256 && codex.sha256 === previous.manifest.pages.codex.sha256 && imageUnchanged) {
      const current = await publishCurrent(output, previous.path);
      await appendFetch(output, {
        attemptedAt: identity.attemptedAt,
        captureId: identity.captureId,
        status: "unchanged",
        mapSha256: map.sha256,
        codexSha256: codex.sha256,
        codexImageDigest: codexImages.digest,
        previousCaptureId: previous.captureId,
      });
      return { status: "unchanged", captureId: identity.captureId, previousCaptureId: previous.captureId, manifest: previous.manifest, captureDirectory: previous.path, current };
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
      codexImages,
    };
    const stats = {};
    for (const page of [map, codex]) stats[page.name] = await writePage(page, captureDirectory, context);
    const previousStructure = previous ? await readJson(join(previous.path, "codex", "structure.json"), { fragments: [] }) : null;
    const sparse = await writeSparseCodex({
      fragmented: { structure: stats.codex.structure, files: stats.codex.fragmentedFiles },
      captureDirectory,
      outputRoot: output,
      previous: previous ? { ...previous, structure: previousStructure } : null,
      dependencies: { imageDigest: codexImages.digest, mapHash: map.sha256 },
    });
    stats.codex.writtenFragments = sparse.written.length;

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
        artifactDirectory: page.directory || page.name,
        inlineScriptCount: stats[page.name].scriptCount,
        jsonCandidateCount: stats[page.name].candidateCount,
        ...(page.name === "codex" ? {
          imageCount: stats.codex.imageCount ?? 0,
          imageFailedCount: stats.codex.imageFailedCount ?? 0,
          imageDigest: stats.codex.imageDigest ?? null,
          images: stats.codex.images ?? [],
        } : {}),
      }])),
      artifacts: {
        codexFragments: stats.codex.fragmentCount,
        codexLeaves: stats.codex.leafCount,
        oversizedTables: stats.codex.oversizedTables,
        splitTables: stats.codex.splitTables,
        tableChunks: stats.codex.tableChunks,
        oversizedLists: stats.codex.oversizedLists,
        splitLists: stats.codex.splitLists,
        listChunks: stats.codex.listChunks,
        listSourceItems: stats.codex.listSourceItems,
        mapRecords: stats.map.recordCounts,
        underdark: stats.map.underdark || null,
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
    let current;
    try {
      current = await publishCurrent(output, captureDirectory);
    } catch (error) {
      await rm(join(captureDirectory, "manifest.json"), { force: true });
      throw error;
    }
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
    if (options.migrateCodexSnapshots) {
      const report = await migrateCodexSnapshots(options);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      if (report.errors.length) process.exitCode = 1;
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
