# Setup Guide

Oversolved runs entirely in the browser. There is no server, no database
process and no API to configure: documents live in IndexedDB, and the CAD
kernel (OpenCascade) plus both solvers are WASM running in Web Workers. A
build produces static files that any static host can serve.

Python survives only as build-time tooling: the icon generator and the repo's
own lint/test gates. It is never deployed.

## Prerequisites

- Node.js >= 22.12
- npm
- Python 3.13 (build tooling only; CI tests this version only)
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
installs `wasm-pack`, and provisions the OpenCascade build into
`frontend/public/occ`. It is an opt-in ~21 MB download, not a `package.json`
dependency, which is why it belongs to install rather than to every build. The
release (a GitHub release of
[oversolved-occt](https://github.com/ftobler/oversolved-occt)), the OCCT version
it built and a sha256 per file are pinned in `frontend/occ.pin.json`;
`occ:install` downloads the files into `node_modules/.occt/<tag>/` and verifies
them, and `occ:provision` refuses to copy anything that does not match.

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
`/occ/`. Sizes of the pinned `occt-8.0.1-r3` build (`frontend/occ.pin.json`),
measured 2026-11-18 with Node's zlib (gzip level 9; brotli quality 11 at zlib's
default 22-bit window):

| file | raw | gzip -9 | brotli q11 |
| --- | --- | --- | --- |
| `occt.wasm` | 22,132,120 B (21.1 MiB) | 6,828,291 B (6.5 MiB) | 4,732,678 B (4.5 MiB) |
| `occt.js` | 111,932 B (109 KiB) | 30,180 B (29 KiB) | 26,592 B (26 KiB) |

A first visit therefore transfers about 4.8 MB with brotli (6.9 MB with gzip)
instead of 22 MB; the opencascade.js 1.1.1 build it replaced was 9.5 MB with
brotli, from a 66 MB wasm that bound over 4000 classes. Nothing in this
repository configures a server, but the deploy is expected to:

- serve `/occ/occt.wasm` as `Content-Type: application/wasm`. The
  loader checks the type before streaming the file into
  `WebAssembly.compileStreaming`; a wrong type silently drops to the buffered
  compile (still correct, just without streaming).
- compress it: brotli (`Content-Encoding: br`) saves another ~31% over gzip.
  Precompress once at deploy time; the bytes never change within a pinned
  version.
- cache `/occ/*` immutably (`Cache-Control: public, max-age=31536000`). The
  file names are stable and the bytes are version-pinned, so this is safe until
  the pin moves: the same names then hold different bytes, and the cache must be
  purged or the path versioned at that moment.

While the artifact downloads, the solving overlay shows a percentage (an
indeterminate message when the host answers chunked with no `Content-Length`),
then a compiling message, so the first solve no longer looks stalled.

## The OCCT build and taking a new release

The kernel is not built in this repository. The
[oversolved-occt](https://github.com/ftobler/oversolved-occt) repo pins an
upstream OCCT release, generates the embind layer from its
`bindings/classes.txt`, compiles with a pinned emsdk and publishes `occt.js`,
`occt.wasm`, the LGPL texts and a `manifest.json` (the OCCT release and commit,
the emcc version, the build commit and every file's sha256) as a GitHub release
tagged `occt-<version>-r<n>`.

The classes the kernel touches are listed in `frontend/occ.used.json`, generated
(`npm run occ:usage`) from the declared embind surface in `occTypes.ts` and
every `oc.` / `occ.` access under `frontend/src`, and verified by
`src/__tests__/occUsage.test.ts`: an access missing from the list fails the
suite, and so does a listed binding nothing uses any more. That list is the
input for the build repo's `classes.txt`; keep the two in step. The runtime
list (`FS`, `getExceptionMessage`, `decrementExceptionRefcount`) must stay in
the build's `EXPORTED_RUNTIME_METHODS`.

Taking a new release is one command and a review of the diff:

```bash
cd frontend
node scripts/occProvision.mjs repin <tag>       # writes occ.pin.json from the release manifest
just install-occ                                     # download, verify, provision
```

`repin` refuses a tag whose OCCT version disagrees with the manifest it
publishes. The same change must bump `scripts/fetchOccSource.mjs` to the new
build commit (the LGPL corresponding source) and the notices in
`public/third_party/opencascade/`; `occVersion.test.ts` and
`thirdPartyNotices.test.ts` fail until it does.

`occ/__tests__/occt8SurfaceReal.test.ts` holds a release to the kernel's
contract: it parses `occTypes.ts` and checks every declared constructor, static
and method against the live module, by name and by arity (embind binds no
default arguments, so a signature that grew a defaulted parameter changes the
arity). A binding the release lacks fails there by name. Then run the full
`just frontend` gate and `just fuzz` against the new bytes; expect the volume
oracle, the action matrix and the fuzz pins to move with a new OCCT, and review
each moved baseline before re-ratcheting it.

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
just mypy && just ruff                      # Python checks (CI still runs flake8)
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
