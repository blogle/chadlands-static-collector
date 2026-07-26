# Phase 2.1 Work Summary

## Scope

Extended the existing collector with two focused refinements:

1. Safe row-based splitting for oversized Markdown tables
2. Annotated SVG and PNG map artifacts generated from normalized map records

The existing capture identity, history, unchanged-source suppression, diff behavior, generic source boundaries, Nix packaging, and OCI execution model were preserved.

## Files Changed

- Added `src/annotate.js`
- Added `test/phase-2-1.test.js`
- Updated `src/fragments.js`
- Updated `src/cli.js`
- Updated `src/map.js`
- Updated `package.json` and `package-lock.json`
- Updated `flake.nix`
- Updated `README.md`
- Updated `.gitignore`

## Dependencies

- Added `sharp@^0.35.3` for browser-free SVG-to-PNG rasterization
- Added DejaVu fonts and a generated Fontconfig configuration to the OCI image
- Production npm audit reports zero vulnerabilities

No browser, Chromium, Playwright, or Puppeteer dependency was added.

## Oversized Table Splitting

Oversized GFM Markdown tables are now split only between complete body rows.

The implementation:

- Preserves the original header and separator
- Repeats the header and separator in every chunk
- Processes rows sequentially without rebalancing earlier chunks
- Aims for the configured target size
- Keeps every row and cell intact
- Allows one unusually large row to exceed the maximum
- Preserves row order
- Uses one-based table body row ranges in metadata
- Generates a parent aggregate that transcludes table chunks in order

Logical chunk IDs include:

- Parent fragment ID
- Source table occurrence index
- First body row index
- Last body row index

Example:

```text
chronicle__table-1__rows-1-18
```

`structure.json` and fragment frontmatter record:

- Table occurrence index
- Source row range
- Source block range
- Parent ID
- Source order
- Character count
- Full rendered content hash
- Row-only hash used for structural comparisons

Repeated headers are represented once by the parent’s structural hash, preventing a header from being treated as a separate source change in every child chunk.

## Table Fixture Results

The deterministic offline fixture produced:

- Oversized tables detected: 1
- Tables split: 1
- Table chunks: 4
- Chunk row ranges: 1–2, 3–4, 5–6, and 7–7
- Smallest chunk: 117 characters
- Largest chunk: 202 characters
- Rows omitted: 0
- Rows duplicated: 0
- Row order changes: 0

Appending rows preserves earlier greedy chunk identities. Table chunks participate in the existing codex structural diff by stable ID.

## Annotated Map Artifacts

Map output now adds:

```text
map/
├── overview.png
├── annotated.svg
├── annotated.png
└── legend.json
```

`overview.png` remains the canonical decoded source image. The annotated files are derived artifacts and do not replace or modify it.

### SVG

`annotated.svg`:

- Uses `overview.png` as a relative background reference
- Preserves the original image dimensions
- Places symbols at source-native coordinates
- Uses observed source names only
- Escapes source text for XML safely
- Includes a visual legend
- Uses text halos and deterministic label offsets
- Adds leader lines for nearby records

Symbol conventions describe source collection types only:

- Seat: star
- Settlement: circle
- Marker: square
- Label: cross
- Unclassified point record: triangle

No lore meaning or inferred relationship is attached to these symbols.

### PNG

`annotated.png` is rasterized from the same SVG using `sharp`, without a browser runtime.

The OCI image includes DejaVu fonts and Fontconfig configuration so labels render correctly in the non-root container. A writable `/tmp` cache is provided for Fontconfig.

## Coordinate Validation

Annotation supports image-pixel coordinates with a top-left origin.

Records are not rendered when coordinates are:

- Missing
- Not finite numeric values
- Outside image bounds
- Associated with an unsupported coordinate system

Skipped records remain available in normalized JSON and Markdown.

Extended validation reports:

- Annotated SVG generated
- Annotated PNG generated
- Image dimensions
- Rendered record count
- Skipped record count
- Missing coordinate count
- Invalid coordinate count
- Out-of-bounds count
- Duplicate coordinate count
- Unsupported coordinate system status
- Label offset count
- Annotation omission count
- Skipped record IDs

`legend.json` includes every annotation candidate with its ID, kind, observed name, coordinates, source path, bounds status, rendered status, and final label position.

## Tests

The complete suite contains 16 passing tests.

New phase 2.1 coverage includes:

- Oversized table splitting between rows
- Repeated headers and separators
- Row conservation and ordering
- Single oversized row preservation
- Stable row-range chunk IDs
- Stable earlier chunks when rows are appended
- Ordered parent transclusions
- Table hierarchy and metadata
- Table chunk structural diffs
- Base image presence in SVG
- Distinct category shapes
- Safe XML escaping
- Valid record rendering
- Invalid and out-of-bounds record skipping
- Deterministic overlap offsets
- Legend record coverage
- Validation counts
- PNG generation and dimensions
- Unsupported coordinate-system handling
- Expanded capture artifact tree

All tests use local fixtures and local HTTP servers. They do not access live URLs.

## Build And Runtime Validation

The following passed:

- `nix develop --command npm test`
- `nix build`
- `nix run .`
- `nix build .#ociImage`
- `nix flake check --no-build`
- Docker image loading
- OCI execution against mounted `/output`
- Non-root OCI execution as UID/GID `10001:10001`
- OCI PNG rasterization with readable labels
- Immediate unchanged-run suppression in direct execution
- Immediate unchanged-run suppression in OCI execution

Final OCI archive size:

```text
143,657,689 bytes
```

## Live Results

Validated direct capture:

```text
Capture ID: 2026-07-26T00-56-26Z
```

Immediate second attempt:

```text
Attempt ID:       2026-07-26T00-56-31Z
Previous capture: 2026-07-26T00-56-26Z
Status:           unchanged
```

Live artifact metrics:

- Codex fragments: 29
- Aggregate fragments: 4
- Leaf fragments: 25
- Normalized map records: 9
- Settlements: 4
- Markers: 4
- Seat records: 1
- Labels: 0
- Unclassified records: 0
- Rendered map records: 9
- Skipped map records: 0
- Out-of-bounds records: 0
- Duplicate coordinates: 0
- Deterministic label offsets: 6
- Legend records: 9
- Annotated SVG size: 4,738 bytes
- Annotated PNG size: 2,407,292 bytes
- Capture tree size: approximately 11 MiB

The legend contains all nine normalized live map records, and normalized validation reports zero omitted source records.

## Live Table Discrepancy

The current live codex contains zero HTML tables.

The remaining approximately 29 KiB oversized codex leaf is a 183-item glossary list, not a table. Therefore the live capture correctly reports:

- Oversized tables detected: 0
- Tables split: 0
- Table chunks: 0

Table splitting is fully validated with sanitized local fixtures. The collector does not reinterpret the glossary list as a table or invent structure that is not present in the source.

## Limitations

- A single table row may exceed the configured maximum because rows remain atomic.
- Other non-table atomic blocks, including a large list, may remain above the maximum.
- Only image-pixel coordinates with a top-left origin are rendered.
- Long source labels can still occupy significant visual space, although deterministic offsets, halos, and leader lines reduce collisions.
- SVG uses a relative reference to `overview.png`; both files should remain together.
- The collector still has no knowledge of downstream vault placement or configuration.
