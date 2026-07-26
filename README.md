# Chadlands static collector

Small Node.js experiment that fetches the public Chadlands map and codex pages and turns their static HTML into artifacts suitable for human or LLM inspection. It does not run page JavaScript or use a browser.

## Non-goals

This is not an MCP server, scheduler, database, knowledge-base integration, authentication layer, or production monitoring/retry service. It does not assign Chadlands-specific semantics to extracted values.

## Run

Run the packaged collector with the default URLs:

```bash
nix run . -- --output ./artifacts
```

Use the development shell:

```bash
nix develop
npm install
npm test
npm run collect -- --output ./artifacts
```

Override either URL when testing another static page:

```bash
npm run collect -- \
  --map-url https://example.com/map \
  --codex-url https://example.com/codex \
  --output ./artifacts
```

The process exits nonzero on an HTTP error, empty response, extraction error, or artifact write failure.

## Artifacts

Each run creates `artifacts/captures/<UTC timestamp>/` and replaces `artifacts/current/` with a copy of that completed capture:

```text
current/
├── manifest.json
├── map/
│   ├── raw.html
│   ├── document.{json,md,txt}
│   ├── images/                 # decoded embedded data images, when present
│   ├── scripts/{001.js,...,index.json}
│   └── json-candidates/{index.json,...}
└── codex/
    ├── raw.html
    ├── document.{json,md,txt}
    └── scripts/{001.js,...,index.json}
```

`raw.html` contains the exact response bytes. Script hashes and byte lengths describe the original inline source even when the saved copy was formatted. Large embedded image data is decoded to `images/` and represented by a compact hash/size record in the inspection documents.

## Nix builds

```bash
nix build
nix build .#ociImage
```

The default package includes Node.js dependencies and exposes `bin/chadlands-static-collector`. The OCI image is a Nix `dockerTools.buildLayeredImage` tar archive named `chadlands-static-collector:latest`; it runs as UID/GID `10001`, writes to `/output` by default, and includes CA certificates.

Load and run it with Podman:

```bash
podman load < result
mkdir -p artifacts
podman run --rm \
  -v "$PWD/artifacts:/output" \
  chadlands-static-collector:latest
```

Docker uses the same archive and arguments:

```bash
docker load < result
docker run --rm \
  -v "$PWD/artifacts:/output" \
  chadlands-static-collector:latest
```

The mounted directory must be writable by UID `10001`. Add normal CLI arguments after the image name to override URLs or output location.

## Real-page result

Validated against both default URLs on 2026-07-25. Both returned HTTP 200. The map response was 4,665,454 bytes and the codex response was 101,969 bytes. Neither response supplied ETag or Last-Modified headers.

Static inspection was enough to recover useful map artifacts without browser automation:

- A 1024 by 1024 PNG was decoded from the map's embedded data URI (1,741,514 bytes).
- Two map inline scripts were preserved. One `application/json` block parsed successfully into a 3,207-byte candidate containing image dimensions, markers, a seat, and settlements. The collector reports these keys and values without interpreting their meaning.
- The map inspection Markdown records the title, DOM counts, SVG, image, script, candidate, and map-related identifier inventories. The page has no visible text outside its rendered image/overlays in the static HTML.
- One codex inline script was preserved. Codex Markdown contains recognizable headings such as `THE CODEX OF BRANDON`, `WHAT'S NEW THIS YEAR`, and `HOW THIS WORLD WORKS`, along with prose, lists, links, images, and tables.

## Limitations

- Hidden-content removal is a practical selector-based heuristic; computed CSS visibility is unavailable without a browser.
- External script URLs are inventoried but not downloaded.
- Candidate detection handles JSON script blocks, quoted `JSON.parse` arguments, and JSON-compatible named or large assignments. It does not parse arbitrary JavaScript syntax or execute downloaded code.
- JavaScript object literals that are not valid JSON are retained as unparsed candidate text when detected.
- URL bodies are decoded as UTF-8 for extraction; the original response bytes remain unchanged in `raw.html`.
- The copied `current` directory briefly does not exist while an older copy is replaced; this experiment does not implement an atomic cross-platform directory swap.
