import { describe, it, expect } from 'vitest'
import { loadExportOrNull } from './loadPkgNode'

const PKG_PATH = '/repo/sketch-solver/pkg-node/sketch_solver.js'

function moduleNotFound(target: string): NodeJS.ErrnoException {
  const err = new Error(`Cannot find module '${target}'`) as NodeJS.ErrnoException
  err.code = 'MODULE_NOT_FOUND'
  return err
}

// loadExportOrNull is the require + classification seam behind
// loadPkgNodeExport; exercising it directly avoids a real wasm-pack build.
describe('loadExportOrNull error handling', () => {
  it('returns null when the package itself is absent', () => {
    // A fresh checkout has no pkg-node build; the harness must skip, not throw.
    expect(loadExportOrNull('solve_sketch_bytes', PKG_PATH, (p) => { throw moduleNotFound(p) })).toBeNull()
  })

  it('rethrows a MODULE_NOT_FOUND for a different module (a broken dependency)', () => {
    // The package path exists but something it requires does not: the message
    // names the nested module, not the package, so it must surface rather than
    // masquerade as an absent artifact and skip the whole suite.
    expect(() => loadExportOrNull('solve_sketch_bytes', PKG_PATH, () => {
      throw moduleNotFound('some-nested-dep')
    })).toThrow(/some-nested-dep/)
  })

  it('rethrows a syntax-broken package instead of swallowing it', () => {
    // A SyntaxError is not an absent artifact, so the whole suite must not skip
    // silently on a corrupt build.
    expect(() => loadExportOrNull('solve_sketch_bytes', PKG_PATH, () => {
      throw new SyntaxError('bad pkg')
    })).toThrow(SyntaxError)
  })

  it('returns null for a missing named export instead of an uncast undefined', () => {
    expect(loadExportOrNull('nope', PKG_PATH, () => ({}))).toBeNull()
  })
})
