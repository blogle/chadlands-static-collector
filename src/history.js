import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export function captureIdentity(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error(`Invalid capture time: ${value}`);
  const iso = date.toISOString();
  return {
    attemptedAt: iso,
    captureDate: iso.slice(0, 10),
    captureId: `${iso.slice(0, 19).replace(/:/g, "-")}Z`,
  };
}

async function directories(path) {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function validCapture(path) {
  try {
    const manifest = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
    if (manifest.schemaVersion !== 2 || !manifest.captureId || !manifest.completedAt) return null;
    if (!manifest.pages?.map?.sha256 || !manifest.pages?.codex?.sha256) return null;
    return { captureId: manifest.captureId, captureDate: manifest.captureDate, path, manifest, timestamp: Date.parse(manifest.startedAt) };
  } catch {
    return null;
  }
}

export async function discoverSuccessfulCaptures(output) {
  const root = join(output, "captures");
  const candidates = [];
  for (const dateEntry of await directories(root)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateEntry.name)) continue;
    for (const captureEntry of await directories(join(root, dateEntry.name))) {
      const candidate = await validCapture(join(root, dateEntry.name, captureEntry.name));
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates.sort((left, right) => left.timestamp - right.timestamp || left.captureId.localeCompare(right.captureId));
}

export async function discoverPreviousCapture(output, attemptedAt) {
  const timestamp = Date.parse(attemptedAt);
  const captures = await discoverSuccessfulCaptures(output);
  return captures.filter((capture) => capture.timestamp < timestamp).at(-1) || null;
}
