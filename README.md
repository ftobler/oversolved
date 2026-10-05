# Oversolved

A mechanical CAD system running entirely in the browser. React frontend,
OpenCascade + the Rust solvers compiled to WASM in Web Workers, documents
persisted to IndexedDB. There is no server and no database process. A folder
of files or a zip is an import source and an export target, never a home; the
folder picker is Chromium-only.

A build produces static files that any static host can serve.

## Stack

- React + TypeScript frontend (`frontend/`), built with Vite
- OpenCascade (OCCT 7.4) as the geometry kernel, WASM in a Web Worker
- Rust solvers, WASM: `sketch-solver` (2D sketch constraints), `mate-solver`
  (assembly mates), on the shared `solver-core`
- Python (`oversolved/`) for build-time icon generation only, never deployed

## Quick start

```bash
just install    # .venv, npm install, wasm-pack, opencascade.js
just dev        # Vite dev server: this is the whole running app
just build      # static app into frontend/dist
```

Prerequisites and the full setup are in `docs/setup.md`.

## Gates

```bash
just default    # every gate (python + frontend)
just python     # mypy, ruff, lint.py, pytest over the repo tooling
just frontend   # icons, lint, vitest, licenses, build
just rust-test  # cargo test over the solver workspace
just rust-lint  # cargo clippy over the solver workspace
just rust-fmt   # cargo fmt --check over the solver workspace
just licenses   # verify the third-party notice bundles
just parity     # full-document WASM parity gate (slow, needs OCC.js)
```

Gates tee their output to a log under `tmp/` so a slow run can be re-read
without re-running it.

## Layout

- `frontend/` - the React app, which is the whole product
- `sketch-solver/`, `mate-solver/`, `solver-core/` - the Rust solver workspace
- `oversolved/` - icon generation
- `tests/` - pytest suite for the Python tooling and the docs invariants
- `docs/` - architecture and setup notes

`code_guideline.md` is the map for navigating the codebase;
`AGENTS.md` holds the working conventions.

## License

Not open source. Copyright (c) 2026 Florin Tobler, all rights reserved. See
`LICENSE.md`; third-party components keep their own licenses, listed at
`/docs/licenses` in the running app.
