import { sha256 } from "./extract.js";

const COLLECTIONS = new Set(["settlements", "markers", "labels"]);
const META_FIELDS = new Set(["img", "seat", "coordinateSystem", "source", "path", "captureId", "imageSha256"]);
const RECORD_FIELDS = new Set([
  "id", "name", "title", "label", "type", "kind", "x", "y", "lat", "lon", "lng", "coords", "coordinates",
  "position", "point", "notes", "note", "description", "source", "path", "collection",
]);

const copy = (value) => {
  if (value === undefined) return undefined;
  return structuredClone(value);
};

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

function normalizedName(value) {
  return text(value)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, "-");
}

function coordinates(record) {
  if (!record || typeof record !== "object") return null;
  const value = record.coords ?? record.coordinates ?? record.position ?? record.point;
  if (Array.isArray(value)) return value.length >= 2 ? { x: value[0], y: value[1] } : copy(value);
  if (value && typeof value === "object") return copy(value);
  const result = {};
  for (const key of ["x", "y", "lat", "lon", "lng"]) if (record[key] !== undefined) result[key] = copy(record[key]);
  return Object.keys(result).length ? result : null;
}

function sourceOf(record, candidate, collection, sourcePath) {
  const source = record?.source ?? candidate.source;
  const result = {};
  if (source && typeof source === "object") Object.assign(result, copy(source));
  else if (source !== undefined) result.value = copy(source);
  const path = record?.path ?? sourcePath ?? candidate.path;
  if (path !== undefined) result.path = copy(path);
  if (result.collection === undefined) result.collection = record?.collection ?? collection;
  return result;
}

function makeRecord(value, collection, candidate, sourcePath) {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value : { value };
  const name = text(record.name ?? record.title ?? record.label);
  const notes = record.notes ?? record.note ?? record.description ?? null;
  const extra = {};
  for (const [key, item] of Object.entries(record)) if (!RECORD_FIELDS.has(key)) extra[key] = copy(item);
  return {
    id: null,
    kind: collection.endsWith("s") ? collection.slice(0, -1) : collection,
    type: text(record.type ?? record.kind) || null,
    name: name || null,
    coordinates: coordinates(record),
    notes: copy(notes),
    sourcePath,
    source: sourceOf(record, candidate, collection, sourcePath),
    extra,
    original: copy(value),
    _sourceId: record.id === undefined || record.id === null || text(record.id) === "" ? null : text(record.id),
  };
}

function coordinateKey(coords) {
  return coords === null ? "no-coordinates" : JSON.stringify(coords, Object.keys(coords).sort());
}

function assignIds(records) {
  const bases = records.map((record) => record._sourceId || `${normalizedName(record.kind) || "record"}__${normalizedName(record.name) || "unnamed"}`);
  const groups = new Map();
  bases.forEach((base, index) => groups.set(base, [...(groups.get(base) || []), index]));
  const used = new Set();
  const duplicateIds = [];
  for (const [base, indexes] of groups) {
    for (const [occurrence, index] of indexes.entries()) {
      const record = records[index];
      let id = indexes.length === 1 ? base : `${base}__${coordinateKey(record.coordinates)}`;
      if (used.has(id)) id = `${id}#${occurrence + 1}`;
      if (indexes.length > 1 || used.has(base)) duplicateIds.push(base);
      while (used.has(id)) id = `${id}#${occurrence + 1}`;
      used.add(id);
      record.id = id;
      delete record._sourceId;
    }
  }
  return [...new Set(duplicateIds)];
}

function comparable(record) {
  const result = copy(record);
  delete result.original;
  return result;
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function normalizeMap(candidate, { captureId, imageSha256, sourceCandidatePath = "json-candidates/unknown.json" } = {}) {
  const input = candidate && typeof candidate === "object" ? candidate : {};
  const image = input.img && typeof input.img === "object" ? copy(input.img) : {};
  const arrays = {};
  const unclassified = [];
  const discoveredCollections = [];
  const records = [];
  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      if (COLLECTIONS.has(key) || key) {
        discoveredCollections.push(key);
        if (COLLECTIONS.has(key)) {
          arrays[key] = value.map((item, index) => makeRecord(item, key, input, `$.${key}[${index}]`));
          records.push(...arrays[key]);
        } else unclassified.push({ collection: key, records: copy(value) });
      }
    } else if (!META_FIELDS.has(key)) unclassified.push({ field: key, value: copy(value) });
  }
  for (const key of COLLECTIONS) if (!arrays[key]) arrays[key] = [];
  const duplicateIds = assignIds(records);
  const seat = input.seat && typeof input.seat === "object" ? makeRecord(input.seat, "seat", input, "$.seat") : null;
  if (seat) {
    assignIds([seat]);
    seat.id = seat._sourceId || seat.id || "seat";
    delete seat._sourceId;
  }
  const validation = {
    parsed: Boolean(candidate && typeof candidate === "object"),
    discoveredCollections: [...new Set(discoveredCollections)],
    imageDimensionsKnown: image.w != null && image.h != null,
    dimensions: { width: image.w ?? image.width ?? null, height: image.h ?? image.height ?? null },
    normalizedRecords: records.length + (seat ? 1 : 0),
    counts: Object.fromEntries(Object.entries(arrays).map(([key, value]) => [key, value.length])),
    missingNames: records.filter((record) => !record.name).length,
    missingCoordinates: records.filter((record) => !record.coordinates).length,
    unclassifiedRecords: unclassified.reduce((count, item) => count + (item.records?.length || 1), 0),
    duplicateIds: [...new Set(duplicateIds)],
    omittedSourceRecords: 0,
  };
  const normalized = {
    captureId: captureId ?? input.captureId ?? null,
    coordinateSystem: copy(input.coordinateSystem ?? { type: "image-pixel", origin: "top-left", width: image.w ?? image.width ?? null, height: image.h ?? image.height ?? null }),
    image: { width: image.w ?? image.width ?? null, height: image.h ?? image.height ?? null, sha256: imageSha256 ?? input.imageSha256 ?? image.sha256 ?? null, original: image },
    sourceCandidatePath,
    seat,
    ...arrays,
    unclassified,
    validation,
  };
  return normalized;
}

const cell = (value) => text(value).replace(/\|/g, "\\|").replace(/\n/g, " ") || "—";
function table(title, values) {
  return [`## ${title}`, "", "| ID | Name | Type | X | Y | Coordinates | Notes | Source |", "| --- | --- | --- | ---: | ---: | --- | --- | --- |",
    ...values.map((item) => `| ${cell(item.id)} | ${cell(item.name)} | ${cell(item.type || item.kind)} | ${cell(item.coordinates?.x)} | ${cell(item.coordinates?.y)} | ${cell(JSON.stringify(item.coordinates))} | ${cell(typeof item.notes === "string" ? item.notes : JSON.stringify(item.notes))} | ${cell(item.sourcePath)} |`), ""];
}

export function mapMarkdown(normalized, sourceCandidatePath = "json-candidates/...") {
  const lines = ["# Map", "", `- Capture: \`${cell(normalized.captureId)}\``, `- Coordinate system: ${cell(JSON.stringify(normalized.coordinateSystem))}`,
    `- Source candidate: [${sourceCandidatePath}](${sourceCandidatePath})`, "- Overview: [overview.png](overview.png)",
    `- Image: ${cell(normalized.image?.width)} x ${cell(normalized.image?.height)}; SHA-256: ${cell(normalized.image?.sha256)}`, ""];
  lines.push("## Visual Map", "", "- Base image: ![[overview.png]]");
  if (normalized.validation?.annotatedPngGenerated) lines.push("- Annotated image: ![[annotated.png]]");
  if (normalized.validation?.annotatedSvgGenerated) lines.push("- Annotated SVG: [Open annotated SVG](annotated.svg)");
  lines.push("");
  if (normalized.seat) lines.push(...table("Seat", [normalized.seat]));
  for (const key of ["settlements", "markers", "labels"]) lines.push(...table(key, normalized[key] || []));
  lines.push("## Validation", "", "```json", JSON.stringify(normalized.validation, null, 2), "```", "", "## Unclassified", "", "```json", JSON.stringify(normalized.unclassified, null, 2), "```", "");
  return `${lines.join("\n").trim()}\n`;
}

export function diffMaps(current, previous) {
  const currentRecords = [...(current?.settlements || []), ...(current?.markers || []), ...(current?.labels || [])];
  const previousRecords = [...(previous?.settlements || []), ...(previous?.markers || []), ...(previous?.labels || [])];
  const before = new Map(previousRecords.map((item) => [item.id, item]));
  const after = new Map(currentRecords.map((item) => [item.id, item]));
  const added = currentRecords.filter((item) => !before.has(item.id)).map((item) => item.id);
  const removed = previousRecords.filter((item) => !after.has(item.id)).map((item) => item.id);
  const changed = [], moved = [], renamed = [], notes = [];
  for (const item of currentRecords) {
    const old = before.get(item.id);
    if (!old) continue;
    if (stable(item.coordinates) !== stable(old.coordinates)) moved.push({ id: item.id, before: old.coordinates, after: item.coordinates });
    if (text(item.name) !== text(old.name)) renamed.push({ id: item.id, before: old.name, after: item.name });
    if (stable(item.notes) !== stable(old.notes)) notes.push({ id: item.id, before: old.notes, after: item.notes });
    if (stable(comparable(item)) !== stable(comparable(old))) changed.push({ id: item.id, before: comparable(old), after: comparable(item) });
  }
  return { added, removed, changed, moved, renamed, notes,
    seatChanged: stable(current?.seat) !== stable(previous?.seat),
    seat: stable(current?.seat) === stable(previous?.seat) ? null : { before: previous?.seat ?? null, after: current?.seat ?? null },
    imageDimensionsChanged: stable([current?.image?.width, current?.image?.height]) !== stable([previous?.image?.width, previous?.image?.height]),
    imageHashChanged: current?.image?.sha256 !== previous?.image?.sha256,
    image: stable(current?.image) === stable(previous?.image) ? null : { before: previous?.image ?? null, after: current?.image ?? null },
    unclassified: stable(current?.unclassified) === stable(previous?.unclassified) ? null : { current: current?.unclassified || [], previous: previous?.unclassified || [] } };
}
