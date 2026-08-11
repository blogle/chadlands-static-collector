import { link, lstat, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "./extract.js";

async function filesUnder(directory) {
  const result = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return result;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

// Keep every logical artifact path, but make byte-identical files share one
// inode. This works for both historical captures and the current copy.
export async function deduplicateVault(output) {
  const files = await filesUnder(output);
  const byDigest = new Map();
  let deduplicatedFiles = 0;
  let savedBytes = 0;
  for (const path of files.sort()) {
    const file = await lstat(path);
    if (file.nlink > 1) continue;
    const bytes = await readFile(path);
    const digest = sha256(bytes);
    const existing = byDigest.get(digest);
    if (!existing) {
      byDigest.set(digest, { path, size: bytes.length });
      continue;
    }
    await unlink(path);
    try {
      await link(existing.path, path);
    } catch (error) {
      // Restore a normal file if the output filesystem cannot hard-link.
      await writeFile(path, bytes);
      if (error.code !== "EXDEV" && error.code !== "EPERM" && error.code !== "EOPNOTSUPP") throw error;
      continue;
    }
    deduplicatedFiles += 1;
    savedBytes += bytes.length;
  }
  return { deduplicatedFiles, savedBytes };
}
