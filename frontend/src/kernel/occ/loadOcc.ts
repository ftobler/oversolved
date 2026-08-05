/**
 * Load the real opencascade.js (Donalffons fork, OCC 7.5) for headless
 * (Node/vitest) use, returning an [[OccModule]] or `null` when it is absent.
 *
 * opencascade.js is treated exactly like the wasm-pack solver build: a heavy,
 * gitignored, opt-in artifact, NOT a package.json dependency, so CI and a fresh
 * `just frontend` never pull its ~66 MB. Install it locally to run the gated
 * Real tests:
 *
 *   cd frontend && npm run occ:install     # npm i --no-save opencascade.js@1.1.1
 *
 * When it is not installed this resolves to `null` and the gated Real tests
 * skip, mirroring `loadSolver.ts`.
 *
 * Loading quirks pinned against the real build:
 *   - The dist file (`opencascade.wasm.js`) mixes CommonJS `require()` with an
 *     ESM `export default`, so Node's ESM loader rejects it with
 *     ERR_AMBIGUOUS_MODULE_SYNTAX. We read it, rewrite the export to
 *     `module.exports`, and require it as CommonJS (there is no real top-level
 *     await, so CJS is safe).
 *   - Emscripten's node path otherwise `fetch()`es the .wasm by file path and
 *     fails to parse it as a URL; we pre-read the bytes and pass `wasmBinary`,
 *     which short-circuits both fetch and fs.
 *
 * The browser/Worker build is a separate loader (the `--target web`-style
 * dynamic import); this one is for parity/leak testing only.
 */

import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OccModule } from './occTypes'
import { memoizedLoad } from './memoizedLoad'

type OccFactory = (config: {
  wasmBinary: Uint8Array
  locateFile: (p: string) => string
}) => Promise<OccModule>

const occ = memoizedLoad(async (): Promise<OccModule | null> => {
  try {
    const require = createRequire(import.meta.url)
    const distPath = require.resolve('opencascade.js/dist/opencascade.wasm.js')
    const wasmPath = distPath.replace(/\.js$/, '.wasm')
    const src = readFileSync(distPath, 'utf8').replace(
      /export default opencascade;\s*$/,
      'module.exports = opencascade;',
    )
    const dir = mkdtempSync(path.join(os.tmpdir(), 'occjs-'))
    const cjsPath = path.join(dir, 'opencascade.cjs')
    writeFileSync(cjsPath, src)
    const factory = require(cjsPath) as OccFactory
    const wasmBinary = readFileSync(wasmPath)
    return await factory({ wasmBinary, locateFile: (p) => p })
  } catch {
    return null
  }
})

export const loadOcc = occ.load
