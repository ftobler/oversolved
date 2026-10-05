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

## Dependency pinning

Most dependencies use caret ranges. Three are pinned exactly (`suspend-react`,
`three-stdlib`, `troika-three-text`) because they sit on the `@react-three`
seam: our code imports them directly while `@react-three/drei` depends on all
three (`@react-three/fiber` depends only on `suspend-react`), and around that
seam they are not interchangeable versions.

- `suspend-react` and `troika-three-text`: `src/components/Viewport/labelFont.ts`
  writes process-global state in each -- `configureTextBuilder({ defaultFontURL })`
  at module scope (`:54`), and `preload` into suspend-react's cache from
  `preloadViewportLabelFont()` (`:75-81`) -- that drei's `<Text>` reads back by
  module identity. The self-hosted font (no CDN fetch behind our CSP) and the
  label pre-warm only hold if our import and drei's import resolve to the same
  module instance and the same version those APIs were written against. A
  floating range would let an unreviewed patch change the default the guard
  depends on.
- `three-stdlib`: imported type-only for `OrbitControls`
  (`Viewport/cameraController.ts`, `Viewport/SceneController.tsx`,
  `Viewport/index.tsx`, `Viewport/AssemblyViewport.tsx`) and `Line2`
  (`Geometry3D/dimensions/primitives.tsx`). It is pinned to the version drei
  resolves so the imported type matches the object drei actually instantiates
  at runtime.

Bumping any of the three is therefore deliberate: change the pin, run
`npm run licenses:generate`, and re-run the viewport guards
(`src/components/Viewport/__tests__/planeLabelFont.test.tsx`,
`src/components/Viewport/__tests__/noCdnAssets.test.ts`).
