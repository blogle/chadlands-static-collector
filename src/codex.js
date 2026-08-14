import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { sha256 } from "./extract.js";

const posix = (value) => value.split(sep).join("/");

async function atomicWrite(path, value) {
  const temporary = `${path}.write-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, value, { flag: "wx" });
  await rename(temporary, path);
}

function inside(root, path) {
  const result = relative(root, path);
  return result === "" || (!result.startsWith(`..${sep}`) && result !== ".." && !isAbsolute(result));
}

async function safeExistingPath(root, relativePath) {
  if (typeof relativePath !== "string" || isAbsolute(relativePath)) throw new Error(`Invalid materialized fragment path: ${relativePath}`);
  const lexicalRoot = resolve(root);
  const lexical = resolve(lexicalRoot, relativePath);
  if (!inside(lexicalRoot, lexical)) throw new Error(`Materialized fragment path escapes output root: ${relativePath}`);
  const [actualRoot, actual] = await Promise.all([realpath(lexicalRoot), realpath(lexical)]);
  if (!inside(actualRoot, actual)) throw new Error(`Materialized fragment symlink escapes output root: ${relativePath}`);
  return actual;
}

async function safeNewPath(root, relativePath) {
  if (typeof relativePath !== "string" || isAbsolute(relativePath)) throw new Error(`Invalid new fragment path: ${relativePath}`);
  const lexicalRoot = resolve(root);
  const lexical = resolve(lexicalRoot, relativePath);
  if (!inside(lexicalRoot, lexical)) throw new Error(`New fragment path escapes output root: ${relativePath}`);
  const [actualRoot, actualParent] = await Promise.all([realpath(lexicalRoot), realpath(dirname(lexical))]);
  if (!inside(actualRoot, actualParent)) throw new Error(`New fragment parent symlink escapes output root: ${relativePath}`);
  return lexical;
}

const pointer = (from, to) => `![[${posix(relative(dirname(from), to))}]]`;
const effectiveHash = (record) => record.fragmentKind === "table-chunk" ? record.rowContentHash : record.fragmentKind === "list-chunk" ? record.itemContentHash : record.contentHash;

function fingerprint(record, childPaths, dependencyHash = record.dependencyHash || null) {
  return sha256(JSON.stringify({
    id: record.id,
    kind: record.kind,
    fragmentKind: record.fragmentKind || null,
    heading: record.heading,
    headingLevel: record.headingLevel,
    parentId: record.parentId,
    partOf: record.partOf || null,
    contentHash: effectiveHash(record),
    childIds: record.childIds || [],
    childPaths,
    dependencyHash,
  }));
}

function header(value) {
  const match = value.match(/^---\n[\s\S]*?\n---\n/);
  if (!match) throw new Error("Generated Codex fragment has no frontmatter");
  return match[0];
}

function body(value) {
  const match = value.match(/^---\n[\s\S]*?\n---\n\n?([\s\S]*)$/);
  return (match ? match[1] : value).trimEnd();
}

function ownBody(value, childCount) {
  const lines = body(value).split("\n");
  for (let count = 0; count < childCount; count += 1) {
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    if (!lines.length || !/^!\[\[[^\n]+\]\]$/.test(lines.at(-1).trim())) throw new Error("Generated child transclusion is missing from materialized fragment");
    lines.pop();
  }
  return lines.join("\n").trim();
}

function fallbackLocation(outputRoot, previous, record) {
  const absolute = join(previous.path, "codex", record.file);
  const relativePath = posix(relative(outputRoot, absolute));
  return { capture: previous.captureId, relative: relativePath, path: absolute };
}

function previousLocation(outputRoot, previous, record) {
  if (record.materializedPath && record.materializedCapture) {
    return { capture: record.materializedCapture, relative: record.materializedPath, path: resolve(outputRoot, record.materializedPath), hash: record.materializedHash };
  }
  return fallbackLocation(outputRoot, previous, record);
}

function compositeFrontmatter(captureId, captureDate) {
  return `---\ngenerated: true\ncapture_id: ${JSON.stringify(captureId)}\ncapture_date: ${JSON.stringify(captureDate)}\nsource_key: "codex"\ntype: "codex-composite"\n---\n\n`;
}

export async function writeSparseCodex({ fragmented, captureDirectory, outputRoot, previous = null, dependencies = {} }) {
  const codexDirectory = join(captureDirectory, "codex");
  const fragmentsDirectory = join(codexDirectory, "fragments");
  await mkdir(fragmentsDirectory, { recursive: true });
  const records = fragmented.structure.fragments;
  const byId = new Map(records.map((record) => [record.id, record]));
  const previousRecords = previous?.structure?.fragments || [];
  const previousById = new Map(previousRecords.map((record) => [record.id, record]));
  const previousLocations = new Map();
  if (previous) {
    for (const record of previousRecords) {
      const location = previousLocation(outputRoot, previous, record);
      location.path = await safeExistingPath(outputRoot, location.relative);
      previousLocations.set(record.id, location);
    }
  }
  const resolved = new Map();

  for (const record of [...records].reverse()) {
    const before = previousById.get(record.id);
    const childPaths = (record.childIds || []).map((id) => resolved.get(id)?.relative);
    if (childPaths.some((path) => !path)) throw new Error(`Fragment ${record.id} references an unresolved child`);
    const dependencyState = {
      images: record.directContent?.includes("../images/") ? dependencies.imageDigest || null : null,
      map: record.directContent?.includes("map/map.md") ? dependencies.mapHash || null : null,
    };
    record.dependencyHash = dependencyState.images || dependencyState.map ? sha256(JSON.stringify(dependencyState)) : null;
    const signature = fingerprint(record, childPaths, record.dependencyHash);
    let location;
    if (before) {
      const previousChildPaths = (before.childIds || []).map((id) => {
        const child = previousById.get(id);
        return child ? previousLocations.get(child.id)?.relative : null;
      });
      const previousSignature = before.renderSignature || fingerprint(before, previousChildPaths);
      if (signature === previousSignature) location = previousLocations.get(before.id);
    }
    if (!location) {
      const relativePath = posix(join("captures", fragmented.structure.captureDate, fragmented.structure.captureId, "codex", record.file));
      location = { capture: fragmented.structure.captureId, relative: relativePath, path: await safeNewPath(outputRoot, relativePath) };
    }
    record.renderSignature = signature;
    record.materializedCapture = location.capture;
    record.materializedPath = location.relative;
    resolved.set(record.id, location);
  }

  const written = [];
  for (const record of records) {
    const location = resolved.get(record.id);
    if (location.capture !== fragmented.structure.captureId) {
      location.path = await safeExistingPath(outputRoot, location.relative);
      record.materializedHash = location.hash || sha256(await readFile(location.path));
      continue;
    }
    const generated = fragmented.files[record.file];
    const childPointers = (record.childIds || []).map((id) => pointer(location.path, resolved.get(id).path));
    const rendered = [record.heading ? `${"#".repeat(Math.max(1, Math.min(6, record.headingLevel)))} ${record.heading}` : "", record.directContent, ...childPointers].filter(Boolean).join("\n\n");
    const value = `${header(generated)}\n${rendered}\n`;
    await atomicWrite(location.path, value);
    record.materializedHash = sha256(value);
    written.push(record.file);
  }

  const roots = records.filter((record) => record.parentId === null && !record.partOf);
  const documentPath = join(codexDirectory, "document.md");
  const document = `${compositeFrontmatter(fragmented.structure.captureId, fragmented.structure.captureDate)}# ${fragmented.structure.title}\n\n${roots.map((record) => pointer(documentPath, resolved.get(record.id).path)).join("\n\n")}\n`;
  await atomicWrite(documentPath, document);

  for (const record of records) delete record.directContent;
  await atomicWrite(join(codexDirectory, "structure.json"), `${JSON.stringify(fragmented.structure, null, 2)}\n`);
  return { written };
}

export async function materializeCurrentCodex(currentDirectory, sourceCaptureDirectory, outputRoot) {
  const structure = JSON.parse(await readFile(join(sourceCaptureDirectory, "codex", "structure.json"), "utf8"));
  const records = structure.fragments || [];
  const byId = new Map(records.map((record) => [record.id, record]));
  const fragmentsDirectory = join(currentDirectory, "codex", "fragments");
  await mkdir(fragmentsDirectory, { recursive: true });

  for (const record of records) {
    const materializedPath = record.materializedPath || posix(relative(outputRoot, join(sourceCaptureDirectory, "codex", record.file)));
    const source = await safeExistingPath(outputRoot, materializedPath);
    if (record.materializedHash && sha256(await readFile(source)) !== record.materializedHash) throw new Error(`Materialized fragment hash mismatch: ${record.id}`);
    const sourceValue = await readFile(source, "utf8");
    const currentCodexRoot = join(currentDirectory, "codex");
    const targetRelative = posix(record.file);
    const target = await safeNewPath(currentCodexRoot, targetRelative);
    const childPointers = (record.childIds || []).map((id) => {
      const child = byId.get(id);
      if (!child) throw new Error(`Fragment ${record.id} references missing child ${id}`);
      return `![[${basename(child.file)}]]`;
    });
    const rendered = [ownBody(sourceValue, (record.childIds || []).length), ...childPointers].filter(Boolean).join("\n\n");
    await atomicWrite(target, `${header(sourceValue)}\n${rendered}\n`);
  }

  const roots = records.filter((record) => record.parentId === null && !record.partOf);
  const documentPath = join(currentDirectory, "codex", "document.md");
  await atomicWrite(documentPath, `${compositeFrontmatter(structure.captureId, structure.captureDate)}# ${structure.title}\n\n${roots.map((record) => `![[fragments/${basename(record.file)}]]`).join("\n\n")}\n`);
  return records.length;
}
