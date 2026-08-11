# Static HTML collector

Small Node.js experiment that fetches two configured public HTML pages and produces immutable raw, normalized, and LLM-readable artifacts. The default sources are the public Chadlands map and codex, but the collector itself is a generic two-URL static capture tool. Source URLs are metadata; the UTC capture ID is the primary artifact identity.

The source URLs may remain constant while their response content changes. Change detection therefore compares exact response SHA-256 hashes rather than relying on ETag or Last-Modified headers.

## Non-goals

This is not an MCP server, browser runner, scheduler, database, object store, Git synchronization tool, deployment repository, Kubernetes component, knowledge extractor, or production retention/locking service. It has no knowledge of Obsidian vault locations or downstream artifact placement. It does not interpret lore or add semantic relationships to observed map data.

## Run

```bash
nix run . -- --output ./artifacts
```

Use the development shell directly:

```bash
nix develop
npm install
npm test
npm run collect -- --output ./artifacts
```

Override sources or fragment-size preferences:

```bash
npm run collect -- \
  --map-url https://example.com/map \
  --codex-url https://example.com/codex \
  --output ./artifacts \
  --fragment-target 6000 \
  --fragment-max 10000 \
  --fragment-min 800
```

The process exits nonzero on an HTTP error, empty response, extraction error, or artifact write failure.

## Capture History

Successful captures are partitioned by UTC date. Multiple changed captures on one date are retained:

```text
artifacts/
├── captures/
│   └── 2026-07-25/
│       └── 2026-07-25T17-30-00Z/
│           ├── manifest.json
│           ├── codex/
│           ├── map/
│           └── diff/
├── current/
└── fetches.jsonl
```

`current/` is a copy of the latest successful capture. Capture discovery scans version-2 manifests and ignores incomplete or invalid directories; it does not rely on `current/`.

When present, the map page's embedded `mapdata.underdark` payload is extracted automatically into `map/underdark/`, including its base64 PNG, layer metadata, dots, normalized records, and Markdown note. No second endpoint or flag is required.

Every attempt appends a compact `captured`, `unchanged`, or `failed` event to `fetches.jsonl` where practical. If both fetched source hashes match the latest successful capture, the command exits successfully without creating a duplicate capture or replacing `current/`.

## Capture Artifacts

Both source directories retain the original `raw.html`, `document.md`, `document.txt`, `document.json`, and inline `scripts/` artifacts. `raw.html` contains the exact response bytes. Script hashes and byte lengths describe original inline source even when a saved JavaScript copy is formatted.

Each `diff/` contains:

```text
summary.md
manifest.json
codex-text.patch
codex-structure.json
map-structure.json
raw-hashes.json
```

The first capture explicitly records that no previous capture exists. Later captures include a normalized codex Markdown patch plus structural added, removed, changed, moved, and metadata comparisons. Diff statements describe direct textual or structural observations only.

## Codex Fragments

Codex output preserves the aggregate document and adds:

```text
codex/
├── aggregate.md
├── structure.json
└── fragments/
    ├── 001-overview.md
    └── ...
```

The generic fragmentation pass walks ordered DOM blocks, builds heading ancestry, and splits oversized sections at atomic paragraph/list boundaries. Unheaded preamble is retained in a deterministic catch-all fragment. Logical fragment IDs derive from normalized heading ancestry and duplicate occurrence, independently of numeric ordering prefixes.

The default target, maximum, and minimum sizes are 6,000, 10,000, and 800 characters. Oversized Markdown tables are split by complete body rows using sequential greedy packing. Every chunk repeats the original header and separator, preserves row order, and is transcluded by its parent aggregate. A row is never split inside a cell; one unusually large row may therefore exceed the maximum.

Table-chunk IDs include the parent fragment, source table occurrence, and first/last body-row indexes, for example `chronicle__table-1__rows-1-18`. Row indexes are one-based indexes into the table body, excluding the repeated header and separator. Earlier greedy chunk boundaries remain stable when rows are appended. `structure.json` and fragment frontmatter record table index, source row range, parent, source block, size, and hashes. Repeated headers are hashed once on the parent for structural diffs rather than treated as separate source content in every child.

Oversized ordered and unordered lists are split between complete top-level items using the same sequential greedy strategy. A top-level item remains attached to all nested lists, continuation paragraphs, links, emphasis, inline code, and indented child blocks. A single oversized item remains intact. Ordered chunks preserve source `<ol start>` values and explicit `<li value>` changes; unordered chunks retain a consistent valid marker and nested indentation.

List-chunk IDs include the parent, source list occurrence, and one-based top-level item range, for example `glossary__list-1__items-1-38`. Parent fragments transclude chunks in source order. Frontmatter and `structure.json` include list type/index, item and source-block ranges, rendered hashes, item-only structural hashes, hierarchy, and conservation counters. Earlier chunk boundaries normally remain unchanged when items are appended.

`aggregate.md` and aggregate fragments use relative Obsidian-compatible transclusions such as:

```markdown
![[fragments/001-overview.md]]
```

These generated transclusion files are output artifacts, not vault configuration. `structure.json` records stable IDs, hierarchy, source order, block ranges, sizes, and content hashes for retrieval and diffing.

## Normalized Map

The original parsed JSON candidate remains in `json-candidates/` and is copied to stable `source-candidate.json`. Map output also includes:

```text
map/
├── overview.png
├── annotated.svg
├── annotated.png
├── legend.json
├── source-candidate.json
├── normalized.json
├── map.md
├── markers.json
├── settlements.json
├── labels.json
├── unclassified.json
└── validation.json
```

Normalization preserves observed names, coordinates, notes, collection membership, source JSON paths, complete original records, and unknown fields. Source-provided record IDs are preferred. Otherwise IDs use collection type plus a normalized unique name; duplicate names fall back to coordinates and occurrence. This keeps a uniquely named record stable when only its coordinates move.

The default coordinate description is image pixels with a top-left origin and observed image dimensions. No latitude, longitude, ownership relationship, or other meaning is inferred. Unknown records remain under `unclassified` rather than being discarded.

`overview.png` remains the canonical decoded source image. `annotated.svg` and `annotated.png` are derived views that preserve its dimensions and place records at source-native coordinates. The SVG references `overview.png` relatively; the PNG is rendered without a browser using `sharp`. Seat, settlement, marker, label, and unclassified point collections use star, circle, square, cross, and triangle symbols respectively. These shapes represent source collection types, not inferred lore meaning.

Observed names are XML-escaped and drawn with a text halo. Symbols stay at their exact coordinates; labels receive small deterministic offsets when records overlap or nearly overlap. `legend.json` records every visual candidate, its source path, bounds and rendered status, and final label position.

Records with missing, invalid, out-of-bounds, or unsupported coordinates remain in normalized JSON and Markdown but are not rendered. `validation.json` reports SVG/PNG generation, image dimensions, rendered/skipped counts, missing/invalid/out-of-bounds coordinates, duplicate coordinates, unsupported coordinate systems, label offsets, and annotation omissions in addition to the existing normalization checks. `map.md` retains all structured tables and links to both derived visual artifacts.

## Nix And OCI

```bash
nix build
nix build .#ociImage
```

The default package includes Node.js dependencies. The Nix layered image is tagged `chadlands-static-collector:latest`, runs as UID/GID `10001`, includes CA certificates, and writes to `/output` by default.

```bash
podman load < result
mkdir -p artifacts
podman run --rm \
  -v "$PWD/artifacts:/output" \
  chadlands-static-collector:latest
```

Docker accepts the same archive and arguments with `docker load` and `docker run`. The mounted directory must be writable by UID `10001`.

## GitHub And GHCR

The private source repository is [blogle/chadlands-static-collector](https://github.com/blogle/chadlands-static-collector). Scheduling, deployment, cron wiring, retention, and downstream vault placement are intentionally handled elsewhere.

`.github/workflows/ci.yml` runs offline tests, flake evaluation, the default Nix build, and the Nix OCI image build for pull requests, pushes to `main`, and manual dispatches. `.github/workflows/publish-image.yml` separately publishes only the existing Nix-built image on `main`, `v*` tags, and manual dispatches.

The GHCR image is:

```text
ghcr.io/blogle/chadlands-static-collector
```

Default-branch builds publish `latest` and `sha-<12-character-commit>`. A tag such as `v0.1.0` publishes `v0.1.0`, `0.1.0`, and the commit SHA tag. The package follows the private repository visibility, so authenticate before pulling when required:

```bash
gh auth token | docker login ghcr.io -u blogle --password-stdin
docker pull ghcr.io/blogle/chadlands-static-collector:latest
mkdir -p artifacts
docker run --rm \
  -v "$PWD/artifacts:/output" \
  ghcr.io/blogle/chadlands-static-collector:latest
```

The published container uses the same entrypoint and non-root UID/GID `10001:10001` as the locally built image.

## Limitations

- Hidden-content removal is selector-based; computed CSS visibility is unavailable without a browser.
- External script URLs are inventoried but not downloaded.
- Candidate detection parses JSON blocks, quoted `JSON.parse` arguments, and JSON-compatible assignments. Downloaded code is never executed.
- An individual table row or other non-table atomic block may exceed the configured maximum rather than being split unsafely.
- Annotation currently supports image-pixel coordinates with a top-left origin. Unsupported systems are reported and not rendered.
- The collector has no knowledge of downstream vault placement; transclusions and visual links are relative output artifacts only.
- URL bodies are decoded as UTF-8 for extraction; exact bytes remain in `raw.html`.
- The copied `current` directory replacement and `fetches.jsonl` append are not designed for concurrent writers.
- Renames without source-provided IDs may appear as removal plus addition because normalized names are part of fallback identity.
