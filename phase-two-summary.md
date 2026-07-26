# Phase Two Work Summary

## Baseline

Removed the earlier `work-summary.md` and committed the completed phase-one collector as:

```text
d74d03a Implement static resource collector
```

Phase two extends that implementation without redesigning the application or adding downstream integrations.

## Implementation

Added the following capabilities:

- UTC date-partitioned immutable captures
- Manifest-based discovery of the latest prior successful capture
- SHA-256 change detection before creating a capture
- Successful unchanged runs without duplicate artifact trees
- Append-only `fetches.jsonl` attempt records
- First-capture and changed-capture diff artifacts
- Generic heading- and block-based codex fragmentation
- Stable logical fragment IDs derived from heading ancestry
- Obsidian-compatible transclusion aggregates
- Normalized, lossless map records
- Stable map record IDs and moved-coordinate detection
- LLM-readable map Markdown tables
- Map normalization validation reports

## Files Changed

- Updated `src/cli.js`
- Added `src/history.js`
- Added `src/diff.js`
- Added `src/fragments.js`
- Added `src/map.js`
- Added `test/phase-two.test.js`
- Added `test/fixtures/map-candidate.json`
- Updated `README.md`

## Capture Behavior

Successful captures now use this structure:

```text
artifacts/
├── captures/
│   └── YYYY-MM-DD/
│       └── YYYY-MM-DDTHH-MM-SSZ/
│           ├── manifest.json
│           ├── codex/
│           ├── map/
│           └── diff/
├── current/
└── fetches.jsonl
```

The collector scans version-2 capture manifests rather than relying on `current/`. Incomplete, invalid, and older phase-one capture directories are ignored during history discovery.

When both fetched source hashes match the latest successful capture, the collector:

- Appends an `unchanged` record to `fetches.jsonl`
- Exits successfully
- Creates no duplicate capture
- Leaves `current/` unchanged

## Codex Fragmentation

Codex output now includes:

```text
codex/
├── aggregate.md
├── structure.json
└── fragments/
```

The fragmentation pass:

- Preserves ordered source blocks
- Uses heading ancestry for stable logical IDs
- Recursively represents heading hierarchy
- Splits oversized sections at safe block boundaries
- Keeps lists, tables, links, and other atomic blocks intact
- Preserves unheaded content in a deterministic preamble fragment
- Generates relative Obsidian-compatible transclusions
- Records source order, hierarchy, character counts, block ranges, and hashes

Default fragmentation preferences are:

```json
{
  "targetCharacters": 6000,
  "maximumCharacters": 10000,
  "minimumCharacters": 800,
  "maximumHeadingDepth": 4
}
```

## Normalized Map

Map output now includes:

```text
map/
├── overview.png
├── source-candidate.json
├── normalized.json
├── map.md
├── markers.json
├── settlements.json
├── labels.json
├── unclassified.json
└── validation.json
```

Normalization preserves:

- Source-provided IDs where available
- Names
- Source-native coordinates
- Notes
- Collection membership
- Source JSON paths
- Unknown fields
- Complete original source records
- Unclassified top-level fields and collections

Fallback record IDs use collection type and normalized unique names. Coordinates and occurrence indexes are used only when names are duplicated, allowing uniquely named records to retain identity when moved.

No latitude, longitude, relationships, ownership, or lore meaning is inferred.

## Diff Artifacts

Each capture contains:

```text
diff/
├── summary.md
├── manifest.json
├── codex-text.patch
├── codex-structure.json
├── map-structure.json
└── raw-hashes.json
```

Codex structural diffs report added, removed, changed, unchanged, heading, parent, and source-order changes. Map structural diffs report added, removed, changed, moved, renamed, note, seat, image, and unclassified changes.

## Tests

The complete suite contains 11 passing tests. Six phase-two test cases cover the requested scenarios, including:

- Date-partitioned capture paths
- Previous-capture discovery
- Ignoring incomplete captures
- Unchanged-source suppression
- First-capture diffs
- Changed-capture diffs
- Heading-based fragmentation
- Oversized section splitting
- Catch-all content preservation
- Stable fragment IDs after unrelated appended content
- Aggregate transclusion generation
- Representative map normalization
- Preservation of unknown fields
- Stable map record IDs
- Moved-coordinate detection
- The expanded artifact tree

All tests use local fixtures and local HTTP servers. They do not access the live URLs.

## Build And Runtime Validation

The following validations passed:

- `nix develop --command npm test`
- `nix build`
- `nix run . -- --output ./artifacts`
- `nix build .#ociImage`
- `nix flake check --no-build`
- Docker image loading
- OCI execution against a mounted `/output`
- Non-root output ownership as UID/GID `10001:10001`

## Live Results

First phase-two capture:

```text
Capture ID:       2026-07-26T00-30-22Z
Previous capture: none
Status:           captured
```

Immediate second attempt:

```text
Attempt ID:       2026-07-26T00-30-33Z
Previous capture: 2026-07-26T00-30-22Z
Status:           unchanged
```

The second run exited successfully, appended a fetch event, created no duplicate capture, and left `current/` on `2026-07-26T00-30-22Z`.

The final OCI image was also run against existing mounted history and correctly reported an unchanged source capture.

## Artifact Metrics

- Artifact tree size: 8.5 MiB
- Codex fragments: 26
- Aggregate fragments: 4
- Leaf fragments: 22
- Smallest aggregate direct-content size: 0 characters
- Smallest leaf size: 51 characters
- Largest leaf size: 29,268 characters
- Normalized settlements: 2
- Normalized markers: 4
- Normalized labels: 0
- Unclassified records: 0
- Omitted source records: 0
- Total normalized records including the seat: 7

First-capture live diff counts:

- Codex added: 26
- Codex removed: 0
- Codex changed: 0
- Map records added: 6
- Map records removed: 0
- Map records changed: 0
- Map records moved: 0
- Seat recorded separately as present

Changed-diff behavior was also validated with fixtures. The test capture reported one added codex fragment, one changed codex fragment, and coordinate changes as movement rather than removal plus addition.

## Limitations And Surprises

- One live codex table is approximately 29 KiB. It remains above the configured maximum because it is treated as an atomic table and is not split inside rows.
- Aggregate fragments may have zero direct-content characters when they only provide heading framing and child transclusions.
- Renames without source-provided IDs may appear as removal plus addition because normalized names are part of fallback identity.
- Visibility detection remains selector-based because the collector does not execute a browser or computed CSS.
- External scripts are inventoried but not downloaded.
- JavaScript is never executed; JSON candidate extraction remains heuristic.
- `current/` replacement and `fetches.jsonl` appends are intentionally not designed for concurrent writers.
