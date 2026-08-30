# Setup Guide

Oversolved runs entirely in the browser. There is no server, no database
process and no API to configure: documents live in IndexedDB, and the CAD
kernel (OpenCascade) plus both solvers are WASM running in Web Workers. A
build produces static files that any static host can serve.

Python survives only as build-time tooling: the icon generator and the repo's
own lint/test gates. It is never deployed.

## Prerequisites

- Node.js >= 20.19
- npm
- Python >= 3.12 (build tooling only)
- Rust + `wasm-pack` (only to rebuild the solver crates)

## System Dependencies

```bash
sudo apt install libcairo2-dev    # pycairo (icon generation)
```

## Install

```bash
just install
```

That creates `.venv`, installs the Python dev extra, runs `npm install`,
installs `wasm-pack`, and provisions OpenCascade.js into `frontend/public/occ`.
OCC.js is an opt-in ~66 MB download, not a `package.json` dependency, which is
why it belongs to install rather than to every build.

To do it by hand:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e .[dev]
cd frontend && npm install
```

The package declares no runtime dependencies. Everything Python needs lives in
the `[dev]` extra, so `pip install -e .` on its own installs nothing.

## Running

```bash
just dev        # Vite dev server on :5173 with HMR -- this is the whole app
```

There is no second process to start. Nothing proxies anywhere.

## Building and serving

```bash
just build      # static deploy build into frontend/dist
just static     # serve frontend/dist with an SPA-fallback static server
```

`just build` is `just frontend-build` under another name: one build, one
artifact, nothing to configure per deployment. Both assume `public/occ` and
`public/wasm` are already provisioned by `just install`.

## Storage

Documents persist in the browser's IndexedDB, scoped to the origin serving the
app. Clearing site data deletes them; different origins do not share them.
Export STEP/STL through the app to get files out; there is nothing on disk to
back up server-side.

## Just recipes

```bash
just python     # mypy + ruff + pytest over the Python tooling (CI still runs flake8)
just frontend   # icons + lint + test + build
just wasm       # rebuild both Rust solvers (web + nodejs targets)
just rust-test  # cargo test over the solver workspace
just icons      # regenerate frontend/src/assets/icons from oversolved/icons.py
just parity     # full-document WASM parity gate (slow, needs OCC.js)
```

## Testing

```bash
pytest tests/ -v                            # Python tooling tests
cd frontend && npx vitest run                # frontend
mypy tests/ oversolved/ && ruff check tests/ oversolved/   # Python lint (CI still runs flake8)
cd frontend && npm run lint                  # frontend lint
```

No test needs a database or a network service. The frontend suite self-skips
its B-rep tests when OCC.js or the Rust `pkg-node` builds are absent, so run
`just install` and `just wasm` first if you want real coverage of the kernel
layer rather than a suite that passes as skipped.

## Troubleshooting

**"Dependency cairo not found"** — Install `libcairo2-dev`, re-run `pip install`.

**Kernel tests all skip** — OCC.js is not provisioned or the Rust solvers are
not built: run `just install-occ` and `just wasm`.

**Frontend not serving** — Build it: `just build`, then `just static`. For dev,
use `just dev` (Vite HMR) instead.

**Documents vanished** — IndexedDB is per-origin and per-browser-profile.
Serving the same build from a different port or host is a different origin with
its own empty store.
