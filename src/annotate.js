import sharp from "sharp";

const SYMBOLS = {
  seat: "star",
  settlement: "circle",
  marker: "square",
  label: "cross",
  unclassified: "triangle",
};

function escapeXml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function rawCoordinates(record) {
  if (!record || typeof record !== "object") return null;
  const nested = record.coordinates ?? record.coords ?? record.position ?? record.point;
  if (Array.isArray(nested)) return { x: nested[0], y: nested[1] };
  if (nested && typeof nested === "object") return { x: nested.x, y: nested.y };
  return record.x !== undefined || record.y !== undefined ? { x: record.x, y: record.y } : null;
}

function annotationRecords(normalized) {
  const records = [];
  if (normalized.seat) records.push({ ...normalized.seat, kind: "seat" });
  for (const kind of ["settlement", "marker", "label"]) {
    for (const record of normalized[`${kind}s`] || []) records.push({ ...record, kind });
  }
  for (const item of normalized.unclassified || []) {
    if (Array.isArray(item.records)) {
      item.records.forEach((record, index) => records.push({
        id: `unclassified__${item.collection || "records"}__${index + 1}`,
        kind: "unclassified",
        name: record?.name ?? record?.title ?? record?.label ?? null,
        coordinates: rawCoordinates(record),
        sourcePath: `$.${item.collection}[${index}]`,
      }));
    } else {
      records.push({
        id: `unclassified__${item.field || "field"}`,
        kind: "unclassified",
        name: item.value?.name ?? item.value?.title ?? item.field ?? null,
        coordinates: rawCoordinates(item.value),
        sourcePath: item.field ? `$.${item.field}` : null,
      });
    }
  }
  return records;
}

function starPoints(x, y, outer = 8, inner = 3.5) {
  return Array.from({ length: 10 }, (_, index) => {
    const radius = index % 2 ? inner : outer;
    const angle = -Math.PI / 2 + index * Math.PI / 5;
    return `${(x + Math.cos(angle) * radius).toFixed(2)},${(y + Math.sin(angle) * radius).toFixed(2)}`;
  }).join(" ");
}

function symbol(record) {
  const { x, y } = record.coordinates;
  const common = `data-kind="${record.kind}" stroke="#111827" stroke-width="2"`;
  if (record.kind === "seat") return `<polygon ${common} points="${starPoints(x, y)}" fill="#facc15"/>`;
  if (record.kind === "settlement") return `<circle ${common} cx="${x}" cy="${y}" r="6" fill="#38bdf8"/>`;
  if (record.kind === "marker") return `<rect ${common} x="${x - 5}" y="${y - 5}" width="10" height="10" rx="1" fill="#fb7185"/>`;
  if (record.kind === "label") return `<g ${common}><line x1="${x - 5}" y1="${y}" x2="${x + 5}" y2="${y}"/><line x1="${x}" y1="${y - 5}" x2="${x}" y2="${y + 5}"/></g>`;
  return `<polygon ${common} points="${x},${y - 7} ${x - 6},${y + 5} ${x + 6},${y + 5}" fill="#a78bfa"/>`;
}

function legendSymbol(kind, x, y) {
  return symbol({ kind, coordinates: { x, y } }).replace(`data-kind="${kind}"`, `data-legend-kind="${kind}"`);
}

export function buildMapAnnotation(normalized, { baseImageHref = "overview.png", baseImageAvailable = true } = {}) {
  const width = Number(normalized.image?.width ?? normalized.coordinateSystem?.width);
  const height = Number(normalized.image?.height ?? normalized.coordinateSystem?.height);
  const supported = normalized.coordinateSystem?.type === "image-pixel" && normalized.coordinateSystem?.origin === "top-left";
  const dimensionsKnown = Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0;
  const canRender = supported && dimensionsKnown && baseImageAvailable;
  const canvasWidth = dimensionsKnown ? width : 1;
  const canvasHeight = dimensionsKnown ? height : 1;
  const candidates = annotationRecords(normalized);
  const rendered = [];
  const legendRecords = [];
  const missing = [];
  const invalid = [];
  const outside = [];
  let labelOffsetCount = 0;

  for (const record of candidates) {
    const x = record.coordinates?.x;
    const y = record.coordinates?.y;
    const base = { id: record.id, kind: record.kind, name: record.name, x: x ?? null, y: y ?? null, sourcePath: record.sourcePath ?? null };
    if (x === undefined || y === undefined || x === null || y === null) {
      missing.push(record.id);
      legendRecords.push({ ...base, inBounds: false, rendered: false });
      continue;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      invalid.push(record.id);
      legendRecords.push({ ...base, inBounds: false, rendered: false });
      continue;
    }
    const coordinates = { x, y };
    const inBounds = dimensionsKnown && coordinates.x >= 0 && coordinates.x < width && coordinates.y >= 0 && coordinates.y < height;
    if (!inBounds || !canRender) {
      if (!inBounds) outside.push(record.id);
      legendRecords.push({ ...base, ...coordinates, inBounds, rendered: false });
      continue;
    }
    const overlapIndex = rendered.filter((other) => Math.hypot(other.coordinates.x - coordinates.x, other.coordinates.y - coordinates.y) <= 36).length;
    const verticalOffset = overlapIndex === 0 ? 0 : (overlapIndex % 2 ? 1 : -1) * Math.ceil(overlapIndex / 2) * 14;
    const labelPosition = {
      x: Math.min(canvasWidth - 4, coordinates.x + 9 + Math.floor(overlapIndex / 5) * 12),
      y: Math.max(12, Math.min(canvasHeight - 4, coordinates.y - 8 + verticalOffset)),
    };
    let collisionShift = 0;
    while (rendered.some((other) => Math.abs(other.labelPosition.x - labelPosition.x) < 220 && Math.abs(other.labelPosition.y - labelPosition.y) < 13) && collisionShift < rendered.length) {
      labelPosition.y = Math.min(canvasHeight - 4, labelPosition.y + 13);
      collisionShift += 1;
    }
    if (overlapIndex > 0 || collisionShift > 0) labelOffsetCount += 1;
    const ready = { ...record, coordinates, labelPosition, overlapIndex };
    rendered.push(ready);
    legendRecords.push({ ...base, ...coordinates, inBounds: true, rendered: true, labelPosition, labelOffset: overlapIndex > 0 || collisionShift > 0 });
  }

  const coordinateCounts = new Map();
  for (const record of rendered) {
    const key = `${record.coordinates.x},${record.coordinates.y}`;
    coordinateCounts.set(key, (coordinateCounts.get(key) || 0) + 1);
  }
  const duplicateCoordinateCount = [...coordinateCounts.values()].reduce((count, value) => count + Math.max(0, value - 1), 0);
  const categoryCounts = new Map();
  for (const record of rendered) categoryCounts.set(record.kind, (categoryCounts.get(record.kind) || 0) + 1);
  const categories = [...categoryCounts].map(([kind, count]) => ({ kind, symbol: SYMBOLS[kind], count }));
  const overlay = rendered.map((record) => {
    const leader = record.overlapIndex > 0 ? `<line x1="${record.coordinates.x}" y1="${record.coordinates.y}" x2="${record.labelPosition.x - 2}" y2="${record.labelPosition.y - 3}" stroke="#ffffff" stroke-width="1"/>` : "";
    const label = record.name ? `<text x="${record.labelPosition.x}" y="${record.labelPosition.y}" font-family="sans-serif" font-size="11" font-weight="600" fill="#111827" stroke="#ffffff" stroke-width="3" paint-order="stroke">${escapeXml(record.name)}</text>` : "";
    return `<g data-record-id="${escapeXml(record.id)}">${symbol(record)}${leader}${label}</g>`;
  }).join("");
  const legendWidth = Math.min(190, Math.max(130, canvasWidth - 16));
  const legendX = Math.max(8, canvasWidth - legendWidth - 8);
  const legendHeight = 28 + categories.length * 22;
  const visualLegend = categories.map((category, index) => {
    const y = 34 + index * 22;
    return `${legendSymbol(category.kind, legendX + 14, y)}<text x="${legendX + 28}" y="${y + 4}" font-family="sans-serif" font-size="11" fill="#111827">${escapeXml(category.kind)} (${category.count})</text>`;
  }).join("");
  const svg = canRender ? `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}">\n<image href="${escapeXml(baseImageHref)}" x="0" y="0" width="${canvasWidth}" height="${canvasHeight}" preserveAspectRatio="none"/>\n<g id="map-overlays">${overlay}</g>\n<g id="legend"><rect x="${legendX}" y="8" width="${legendWidth}" height="${legendHeight}" rx="6" fill="#ffffff" fill-opacity="0.88" stroke="#111827"/><text x="${legendX + 8}" y="22" font-family="sans-serif" font-size="12" font-weight="700">Legend</text>${visualLegend}</g>\n</svg>\n` : null;
  const validation = {
    annotatedSvgGenerated: canRender,
    annotatedPngGenerated: false,
    imageDimensions: { width: dimensionsKnown ? width : null, height: dimensionsKnown ? height : null },
    renderedRecordCount: rendered.length,
    skippedRecordCount: candidates.length - rendered.length,
    recordsMissingCoordinates: missing.length,
    recordsWithInvalidCoordinates: invalid.length,
    recordsOutsideImageBounds: outside.length,
    duplicateCoordinateCount,
    unsupportedCoordinateSystem: !supported,
    labelOffsetCount,
    recordsOmittedFromAnnotatedArtifact: candidates.length - rendered.length,
    skippedRecordIds: legendRecords.filter(({ rendered }) => !rendered).map(({ id }) => id),
  };
  const legend = {
    artifact: "annotated.svg",
    coordinateSystem: normalized.coordinateSystem,
    categories,
    records: legendRecords,
  };
  return { svg, legend, validation, renderedRecords: rendered };
}

export async function renderAnnotatedPng(svg, baseImageBytes) {
  const imagePattern = /(<image\s+href=")[^"]*(")/;
  if (!imagePattern.test(svg)) throw new Error("Annotated SVG does not contain a base image reference");
  const embedded = svg.replace(imagePattern, `$1data:image/png;base64,${baseImageBytes.toString("base64")}$2`);
  return sharp(Buffer.from(embedded)).png().toBuffer();
}
