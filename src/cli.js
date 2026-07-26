#!/usr/bin/env node

import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { codexMarkdown, extractDocument, extractJsonCandidates, findMapIdentifiers, mapMarkdown, prepareScripts, serializeCandidates, sha256 } from "./extract.js";

const DEFAULT_MAP_URL = "https://mud.3zr4.com/maps/dv6uOmmTkKxKVJmmSU-tGA/";
const DEFAULT_CODEX_URL = "https://mud.3zr4.com/maps/dv6uOmmTkKxKVJmmSU-tGA/codex/";
const packageJson = JSON.parse(await (await import("node:fs/promises")).readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"));

function usage() {
  return `Usage: chadlands-static-collector [options]\n\nOptions:\n  --output <directory>   Output root (default: /output in the OCI image, otherwise ./artifacts)\n  --map-url <url>        Override the map URL\n  --codex-url <url>      Override the codex URL\n  --help                 Show this help\n`;
}

export function parseArgs(argv, env = process.env) {
  const options = { output: env.COLLECTOR_OUTPUT || "./artifacts", mapUrl: DEFAULT_MAP_URL, codexUrl: DEFAULT_CODEX_URL };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { ...options, help: true };
    const key = { "--output": "output", "--map-url": "mapUrl", "--codex-url": "codexUrl" }[argument];
    if (!key || !argv[index + 1]) throw new Error(`Unknown or incomplete argument: ${argument}`);
    options[key] = argv[++index];
  }
  return options;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function fetchPage(name, url) {
  const response = await fetch(url, { headers: { "user-agent": `chadlands-static-collector/${packageJson.version}` }, redirect: "follow" });
  if (!response.ok) throw new Error(`${name} fetch failed: HTTP ${response.status} ${response.statusText}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (!body.length) throw new Error(`${name} fetch returned an empty body`);
  return { name, url: response.url, requestedUrl: url, response, body, html: body.toString("utf8") };
}

async function writePage(page, captureDirectory, fetchedAt) {
  const directory = join(captureDirectory, page.name);
  const scriptsDirectory = join(directory, "scripts");
  await mkdir(scriptsDirectory, { recursive: true });
  await writeFile(join(directory, "raw.html"), page.body);

  const document = { ...extractDocument(page.html, page.url), fetchedAt };
  const embeddedImages = [];
  for (let index = 0; index < document.images.length; index += 1) {
    const image = document.images[index];
    const match = image.originalSrc?.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!match) continue;
    const mimeType = match[1] || "application/octet-stream";
    const bytes = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]), "utf8");
    const extension = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/svg+xml": "svg", "image/webp": "webp" }[mimeType] || "bin";
    const outputFile = `${String(index + 1).padStart(3, "0")}.${extension}`;
    embeddedImages.push({ outputFile, bytes });
    Object.assign(image, {
      src: `data:${mimeType};${match[2] ? "base64," : ""}[embedded data omitted]`,
      originalSrc: null,
      embedded: true,
      mimeType,
      byteLength: bytes.length,
      sha256: sha256(bytes),
      outputFile,
    });
  }
  if (embeddedImages.length) {
    const imagesDirectory = join(directory, "images");
    await mkdir(imagesDirectory, { recursive: true });
    await Promise.all(embeddedImages.map(({ outputFile, bytes }) => writeFile(join(imagesDirectory, outputFile), bytes)));
  }
  const preparedScripts = await prepareScripts(document.scripts);
  document.scripts = preparedScripts.index;
  await Promise.all(preparedScripts.files.map(({ outputFile, content }) => writeFile(join(scriptsDirectory, outputFile), content)));
  await writeJson(join(scriptsDirectory, "index.json"), preparedScripts.index);
  await writeFile(join(directory, "document.txt"), `${document.visibleText}\n`);

  let candidateIndex = [];
  if (page.name === "map") {
    const candidatesDirectory = join(directory, "json-candidates");
    await mkdir(candidatesDirectory, { recursive: true });
    const serialized = serializeCandidates(extractJsonCandidates(extractDocument(page.html, page.url).scripts));
    candidateIndex = serialized.index;
    await Promise.all(serialized.files.map(({ outputFile, content }) => writeFile(join(candidatesDirectory, outputFile), content)));
    await writeJson(join(candidatesDirectory, "index.json"), candidateIndex);
    const identifiers = findMapIdentifiers(page.html);
    document.mapRelatedIdentifiers = identifiers;
    document.jsonCandidates = candidateIndex;
    await writeFile(join(directory, "document.md"), mapMarkdown(document, identifiers, preparedScripts.index, candidateIndex));
  } else {
    await writeFile(join(directory, "document.md"), codexMarkdown(page.html));
  }
  await writeJson(join(directory, "document.json"), document);
  return { scriptCount: preparedScripts.files.length, candidateCount: candidateIndex.length };
}

export async function collect(options) {
  const startedAt = new Date().toISOString();
  const captureId = startedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const output = resolve(options.output);
  const captureDirectory = join(output, "captures", captureId);
  await mkdir(captureDirectory, { recursive: true });

  const [map, codex] = await Promise.all([fetchPage("map", options.mapUrl), fetchPage("codex", options.codexUrl)]);
  const stats = {};
  for (const page of [map, codex]) stats[page.name] = await writePage(page, captureDirectory, startedAt);

  const completedAt = new Date().toISOString();
  const manifest = {
    captureId,
    startedAt,
    completedAt,
    collectorVersion: packageJson.version,
    nodeVersion: process.version,
    pages: Object.fromEntries([map, codex].map((page) => [page.name, {
      url: page.url,
      requestedUrl: page.requestedUrl,
      status: page.response.status,
      contentType: page.response.headers.get("content-type"),
      byteLength: page.body.length,
      sha256: sha256(page.body),
      etag: page.response.headers.get("etag"),
      lastModified: page.response.headers.get("last-modified"),
      artifactDirectory: page.name,
      inlineScriptCount: stats[page.name].scriptCount,
      jsonCandidateCount: stats[page.name].candidateCount,
    }]))
  };
  await writeJson(join(captureDirectory, "manifest.json"), manifest);

  const current = join(output, "current");
  await rm(current, { recursive: true, force: true });
  await cp(captureDirectory, current, { recursive: true });
  return { manifest, captureDirectory, current };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
      return;
    }
    const result = await collect(options);
    process.stdout.write(`Capture ${result.manifest.captureId} written to ${result.captureDirectory}\nCurrent copy: ${result.current}\n`);
  } catch (error) {
    process.stderr.write(`Collector failed: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
