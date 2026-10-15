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
why it belongs to install rather than to every build. The exact version, the
registry tarball integrity and a sha256 per dist file are pinned in
`frontend/occ.pin.json`; `occ:install` verifies the installed package against it
and `occ:provision` refuses to copy anything that does not match.

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

`just build` is the app build step that `just frontend` also runs: one build,
one artifact, nothing to configure per deployment. Both assume `public/occ` and
`public/wasm` are already provisioned by `just install`.

## Hosting the OCC payload

The app is static files, and the largest of them is the OCC artifact under
`/occ/`. Sizes of the pinned opencascade.js 1.1.1 build
(`frontend/occ.pin.json`), measured 2026-10-15 with Node's zlib (gzip level 9;
brotli quality 11 at zlib's default 22-bit window):

| file | raw | gzip -9 | brotli q11 |
| --- | --- | --- | --- |
| `opencascade.wasm.wasm` | 65,864,037 B (62.8 MiB) | 13,834,575 B (13.2 MiB) | 9,465,008 B (9.0 MiB) |
| `opencascade.wasm.js` | 330,809 B (323 KiB) | 52,371 B (51 KiB) | 44,927 B (44 KiB) |

A first visit therefore transfers about 9.5 MB with brotli (13.9 MB with gzip)
instead of 66 MB. A 24-bit brotli window (`brotli -w 24`, `BROTLI_PARAM_LGWIN`
24 in the API) shrinks the wasm further, to 9,150,579 B (8.7 MiB), at the price
of precompressing once with a window many defaults do not use. Nothing in this
repository configures a server, but the deploy is expected to:

- serve `/occ/opencascade.wasm.wasm` as `Content-Type: application/wasm`. The
  loader checks the type before streaming the file into
  `WebAssembly.compileStreaming`; a wrong type silently drops to the buffered
  compile (still correct, just without streaming).
- compress it: brotli (`Content-Encoding: br`) saves another ~32% over gzip.
  Precompress once at deploy time; the bytes never change within a pinned
  version.
- cache `/occ/*` immutably (`Cache-Control: public, max-age=31536000`). The
  file names are stable and the bytes are version-pinned, so this is safe until
  the pin moves: the same names then hold different bytes, and the cache must be
  purged or the path versioned at that moment.

While the artifact downloads, the solving overlay shows a percentage (an
indeterminate message when the host answers chunked with no `Content-Length`),
then a compiling message, so the first solve no longer looks stalled.

## Building a slimmer OCC

The provisioned artifact marks over 4000 classes as supported (its
`Supported APIs.md`); the kernel calls a few dozen of them, plus five emscripten
runtime members. The exact list lives in `frontend/occ.used.json`, generated
(`npm run occ:usage`) from the declared embind surface in `occTypes.ts` and
every `oc.` / `occ.` access under `frontend/src`, and verified by
`src/__tests__/occUsage.test.ts` in the normal `just frontend` gate: an access
missing from the list fails the suite, and so does a listed binding nothing
uses any more. Tests are scanned deliberately, because the gated Real suites
run on the same artifact.

The slim build itself is not built in this repository. It needs a reachable
Docker daemon, several GB of disk and network access to fetch build inputs;
this machine has no reachable daemon and no emscripten SDK, so the recipe below
is documented, not executed. Once a machine has those:

1. The installed package is the build tree: `node_modules/opencascade.js`
   ships the `Dockerfile`, `make.py`, `patches/` and `embind/`. Copy it to a
   scratch dir. `make.py` downloads OCCT unless `build/occt.tar.gz` exists, and
   the pinned OCCT source is already mirrored at
   `frontend/public/third_party/opencascade/source/` (`npm run
   licenses:mirror`), so copy the mirror tarball in to skip the download and
   build from exactly the pinned tree.
2. `node frontend/scripts/occUsage.mjs symbols` prints the allowlist, one class
   per line. Patch `embind/autobind.py` so `processClass` returns false for any
   class outside it (keep the existing exclusions). Bindings that reach a class
   through a handle or typedef can need that referenced class added by hand
   when the generated code does not compile. Keep the emscripten members the
   runtime list names (`FS`, `HEAP32`, `UTF8ToString`, `___getTypeName`,
   `_free`) exported the way the current artifact exports them; `make.py`
   already names `FS` and `UTF8ToString` in its runtime-method flags.
3. Build with the package's own container (README section "Build it"): build
   the image, run it sharing `build/`, `dist/` and `embind/`. Emscripten lives
   in the image; the multi-GB cost is why this is a deliberate, separate act.
4. The result is a verified-nowhere artifact until the pin learns to describe
   it: `occ.pin.json` and `occProvision.mjs` currently verify the npm package
   (version, OCCT version the build declares, sha256 per file), which a custom
   build does not satisfy. Either extend the pin with a local-build source
   (source commit, per-file sha256s) or keep the slim artifact out of
   `public/occ`; nothing unverified should be served.
5. Prove it before any deploy: run the full `just frontend` gate with the slim
   artifact provisioned. The gated Real suites and the class-list coverage run
   against the same bytes, so a dropped binding fails the suite rather than a
   user's first solve. Expect a large size drop; no number is promised before a
   real build.

## A newer OCCT (7.8/7.9): blocked on infrastructure

The long-term step is the same pipeline against a newer OCCT tag, and it is
gated: the reference corpora must pass on both builds before a switch.
Concretely, `just ratchet-matrix` (the full action-matrix sweep over the corpus
documents) and `just fuzz 500 60` (the seeded fuzz sweep, real kernel) run
against the old and the new artifact, and a regression in either blocks the new
one.

This is not buildable here for the same reasons as the slim build (no reachable
Docker daemon, no emscripten SDK), and it has extra prerequisites:
the opencascade.js `patches/` are cut against V7_4_0p1 and need rework for the
new release, and the LGPL obligations follow the artifact. The wasm must stay a
separate, replaceable file (it already is: a static asset under `/occ/`, never
bundled), and `npm run licenses:mirror` plus the regenerated notices must land
in the same change that swaps the artifact.

## Storage

Documents persist in the browser's IndexedDB, scoped to the origin serving the
app. Clearing site data deletes them; different origins do not share them.
Export STEP/STL through the app to get files out; there is nothing on disk to
back up server-side.

## Just recipes

```bash
just python     # mypy + ruff + lint.py + pytest over the Python tooling (CI still runs flake8)
just frontend   # icons + lint + test + licenses + build
just wasm       # rebuild both Rust solvers (web + nodejs targets)
just rust-test  # cargo test over the solver workspace
just icons      # regenerate frontend/src/assets/icons from oversolved/icons.py
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

**"Dependency cairo not found"** - Install `libcairo2-dev`, re-run `pip install`.

**Kernel tests all skip** - OCC.js is not provisioned or the Rust solvers are
not built: run `just install-occ` and `just wasm`.

**Frontend not serving** - Build it: `just build`, then `just static`. For dev,
use `just dev` (Vite HMR) instead.

**Documents vanished** - IndexedDB is per-origin and per-browser-profile.
Serving the same build from a different port or host is a different origin with
its own empty store.
