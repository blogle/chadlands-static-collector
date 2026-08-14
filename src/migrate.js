import { cp, mkdtemp, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { discoverSuccessfulCaptures } from "./history.js";
import { materializeCurrentCodex, writeSparseCodex } from "./codex.js";
import { sha256 } from "./extract.js";

const posix = (value) => value.split("\\").join("/");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
async function exists(path) { try { await stat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
function body(value) { const match = value.match(/^---\n[\s\S]*?\n---\n\n?([\s\S]*)$/); return (match ? match[1] : value).trimEnd(); }

function generatedChildLine(line, child) {
  const match = line.trim().match(/^!\[\[([^\]|#]+)(?:#[^\]|]+)?\]\]$/);
  if (!match) return false;
  return posix(match[1]) === child.file || match[1].split("/").at(-1) === child.file.split("/").at(-1);
}

// Strip only the generated child-link suffix. Authored wikilinks remain intact.
function directContent(value, record, byId) {
  const lines = body(value).split("\n");
  const children = (record.childIds || []).map((id) => byId.get(id));
  for (let index = children.length - 1; index >= 0; index -= 1) {
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    if (!lines.length || !generatedChildLine(lines.at(-1), children[index])) break;
    lines.pop();
  }
  while (lines.length && !lines[0].trim()) lines.shift();
  const heading = record.heading && `${"#".repeat(Math.max(1, Math.min(6, record.headingLevel)))} ${record.heading}`;
  if (heading && lines[0]?.trim() === heading) lines.shift();
  return lines.join("\n").trim();
}

async function localFiles(capturePath) {
  try { return new Set((await readdir(join(capturePath, "codex", "fragments"))).filter((name) => name.endsWith(".md")).map((name) => `fragments/${name}`)); }
  catch (error) { if (error.code === "ENOENT") return new Set(); throw error; }
}

async function sourceFile(root, capture, record) {
  const pathName = record.materializedPath || posix(join("captures", capture.captureDate, capture.captureId, "codex", record.file));
  const path = resolve(root, pathName);
  const relation = relative(resolve(root), path);
  if (relation === ".." || relation.startsWith("..\\") || relation.startsWith("../") || pathName.startsWith("/")) throw new Error(`Materialized fragment path escapes output root: ${pathName}`);
  if (!(await exists(path))) throw new Error(`Missing legacy fragment ${pathName} (${record.id})`);
  return readFile(path, "utf8");
}

async function alreadySparse(capture, structure) {
  if (await exists(join(capture.path, "codex", "aggregate.md")) || await exists(join(capture.path, "codex", "document.txt"))) return false;
  if (!structure.fragments.every((record) => record.materializedCapture && record.materializedPath && record.materializedHash && record.renderSignature !== undefined && record.dependencyHash !== undefined)) return false;
  const local = await localFiles(capture.path);
  const expected = structure.fragments.filter((record) => record.materializedCapture === capture.captureId).map((record) => record.file);
  return local.size === expected.length && [...local].every((file) => expected.includes(file));
}

async function transformCapture(root, capture, previous, report) {
  const structure = await json(join(capture.path, "codex", "structure.json"));
  if (await alreadySparse(capture, structure)) return structure;
  const byId = new Map(structure.fragments.map((record) => [record.id, record]));
  const files = {};
  for (const record of structure.fragments) {
    const value = await sourceFile(root, capture, record);
    files[record.file] = value;
    record.directContent = directContent(value, record, byId);
  }
  const result = await writeSparseCodex({
    fragmented: { structure, files },
    captureDirectory: capture.path,
    outputRoot: root,
    previous: previous ? { ...previous, structure: await json(join(previous.path, "codex", "structure.json")) } : null,
    dependencies: { imageDigest: capture.manifest.pages.codex.imageDigest || null, mapHash: capture.manifest.pages.map.sha256 || null },
  });
  const expected = new Set(structure.fragments.filter((record) => record.materializedCapture === capture.captureId).map((record) => record.file));
  for (const file of await localFiles(capture.path)) {
    if (!expected.has(file)) {
      await rm(join(capture.path, "codex", file), { force: true });
      report.deletedFragments.push(posix(relative(root, join(capture.path, "codex", file))));
    }
  }
  await rm(join(capture.path, "codex", "aggregate.md"), { force: true });
  await rm(join(capture.path, "codex", "document.txt"), { force: true });
  report.rewrittenFragments.push(...result.written.map((file) => posix(relative(root, join(capture.path, "codex", file)))));
  return structure;
}

async function validateCapture(root, capture, fullCurrent = false) {
  const errors = [];
  const codex = join(capture.path, "codex");
  const structure = await json(join(codex, "structure.json"));
  const byId = new Map(structure.fragments.map((record) => [record.id, record]));
  if (await exists(join(codex, "aggregate.md"))) errors.push(`${capture.captureId}: aggregate.md remains`);
  if (await exists(join(codex, "document.txt"))) errors.push(`${capture.captureId}: document.txt remains`);
  for (const record of structure.fragments) {
    const path = record.materializedPath && resolve(root, record.materializedPath);
    if (!path || !(await exists(path))) { errors.push(`${capture.captureId}: missing materialized ${record.id}`); continue; }
    if (sha256(await readFile(path)) !== record.materializedHash) errors.push(`${capture.captureId}: hash mismatch ${record.id}`);
    const links = [...(await readFile(path, "utf8")).matchAll(/^!\[\[([^\]|#]+)(?:#[^\]|]+)?\]\]$/gm)].map((match) => match[1]);
    for (const childId of record.childIds || []) {
      const child = byId.get(childId);
      if (!child) { errors.push(`${capture.captureId}: missing child ${childId}`); continue; }
      const expected = posix(relative(dirname(record.materializedPath), child.materializedPath));
      if (!links.includes(expected) && !links.includes(child.file.split("/").at(-1))) errors.push(`${capture.captureId}: missing direct link ${record.id} -> ${childId}`);
    }
  }
  const local = await localFiles(capture.path);
  const expected = new Set(fullCurrent ? structure.fragments.map((record) => record.file) : structure.fragments.filter((record) => record.materializedCapture === capture.captureId).map((record) => record.file));
  if (local.size !== expected.size || [...local].some((file) => !expected.has(file))) errors.push(`${capture.captureId}: local fragment set mismatch`);
  return { structure, errors };
}

async function rebuildCurrent(root, latest) {
  const staging = join(root, `.migration-current-${process.pid}.tmp`);
  await rm(staging, { recursive: true, force: true });
  await cp(latest.path, staging, { recursive: true });
  await materializeCurrentCodex(staging, latest.path, root);
  await rm(join(staging, "codex", "aggregate.md"), { force: true });
  await rm(join(staging, "codex", "document.txt"), { force: true });
  if ((await localFiles(staging)).size !== (await json(join(staging, "codex", "structure.json"))).fragments.length) throw new Error("current fragment count does not match latest structure");
  return staging;
}

async function installDirectory(source, target) {
  const temporary = `${target}.migration-${process.pid}.tmp`;
  const backup = `${target}.migration-${process.pid}.old`;
  await rm(temporary, { recursive: true, force: true }); await rm(backup, { recursive: true, force: true });
  await cp(source, temporary, { recursive: true });
  try {
    try { await rename(target, backup); } catch (error) { if (error.code !== "ENOENT") throw error; }
    await rename(temporary, target); await rm(backup, { recursive: true, force: true });
  } catch (error) { await rm(temporary, { recursive: true, force: true }); if (await exists(backup)) await rename(backup, target); throw error; }
}

export async function migrateCodexSnapshots({ output, apply = false }) {
  const root = resolve(output);
  const captures = await discoverSuccessfulCaptures(root);
  const report = { mode: apply ? "apply" : "dry-run", captures: [], rewrittenFragments: [], deletedFragments: [], bytesRemoved: 0, errors: [] };
  if (!captures.length) { report.errors.push("No successful captures found"); return report; }
  const staging = await mkdtemp(join(tmpdir(), "codex-migration-"));
  try {
    await cp(root, staging, { recursive: true });
    const stagedCaptures = await discoverSuccessfulCaptures(staging);
    let previous = null;
    for (const capture of stagedCaptures) {
      const oldBytes = (await Promise.all(["aggregate.md", "document.txt"].map(async (name) => { try { return (await readFile(join(capture.path, "codex", name))).length; } catch (error) { if (error.code === "ENOENT") return 0; throw error; } }))).reduce((sum, value) => sum + value, 0);
      const structure = await transformCapture(staging, capture, previous, report);
      const validation = await validateCapture(staging, capture); report.errors.push(...validation.errors);
      report.captures.push({ captureId: capture.captureId, fragmentCount: structure.fragments.length }); report.bytesRemoved += oldBytes;
      previous = { ...capture, structure };
    }
    const latest = stagedCaptures.at(-1);
    const currentStaging = await rebuildCurrent(staging, latest);
    report.errors.push(...(await validateCapture(staging, { ...latest, path: currentStaging }, true)).errors);
    if (!report.errors.length && apply) {
      for (const capture of stagedCaptures) await installDirectory(join(capture.path, "codex"), join(root, "captures", capture.captureDate, capture.captureId, "codex"));
      await installDirectory(join(currentStaging, "codex"), join(root, "current", "codex"));
    }
  } catch (error) { report.errors.push(error.message); }
  finally { await rm(staging, { recursive: true, force: true }); }
  return report;
}
