export function unifiedDiff(before, after, beforeName = "previous/codex.md", afterName = "current/codex.md") {
  if (before === after) return "";
  const oldLines = before.replace(/\n$/, "").split("\n");
  const newLines = after.replace(/\n$/, "").split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines.at(-1 - suffix) === newLines.at(-1 - suffix)) suffix += 1;
  const contextStart = Math.max(0, prefix - 3);
  const oldEnd = Math.min(oldLines.length, oldLines.length - suffix + 3);
  const newEnd = Math.min(newLines.length, newLines.length - suffix + 3);
  const oldChunk = oldLines.slice(contextStart, oldEnd);
  const newChunk = newLines.slice(contextStart, newEnd);
  const leading = prefix - contextStart;
  const trailing = Math.min(3, suffix);
  const lines = [`--- ${beforeName}`, `+++ ${afterName}`, `@@ -${contextStart + 1},${oldChunk.length} +${contextStart + 1},${newChunk.length} @@`];
  lines.push(...oldChunk.slice(0, leading).map((line) => ` ${line}`));
  lines.push(...oldChunk.slice(leading, oldChunk.length - trailing).map((line) => `-${line}`));
  lines.push(...newChunk.slice(leading, newChunk.length - trailing).map((line) => `+${line}`));
  if (trailing) lines.push(...newChunk.slice(-trailing).map((line) => ` ${line}`));
  return `${lines.join("\n")}\n`;
}
