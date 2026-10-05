# Oversolved frontend

The React app is the whole product. It runs the CAD kernel (OpenCascade) and
both Rust solvers as WASM in Web Workers, and persists documents to IndexedDB.
There is no server. The repo `README.md` and `docs/setup.md` cover the full
project.

## Develop

```bash
just install    # .venv, npm install, wasm-pack, opencascade.js
just dev        # Vite dev server on :5173, this is the whole app
```

## Gates

```bash
just frontend   # icons + lint + vitest + licenses + build
just parity     # full-document WASM parity gate (slow, needs OCC.js)
```

## Rebuilding the WASM kernels

```bash
just wasm               # both solvers, web + nodejs targets
npm run regen:corpus    # regenerate the full-doc parity corpus fixtures
```

The npm scripts expect this directory as their working directory; the just
recipes set it themselves.
