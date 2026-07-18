/**
 * Locks the sketch/mate WASM package split.
 *
 * The two solvers ship as separate crates and separate binaries so each Worker
 * fetches and compiles only what it calls, and so their wire formats can
 * version independently. That is easy to undo by accident -- re-exporting
 * `solve_mate_bytes` from the sketch crate would "work" everywhere and quietly
 * re-merge them -- so the boundary is asserted here rather than left to review.
 */
import { describe, it, expect } from 'vitest'
import { loadPkgNodeExport, PKG_SKETCH, PKG_MATE } from './loadPkgNode'

const sketchPkg = loadPkgNodeExport<unknown>('solve_sketch_bytes', PKG_SKETCH)
const matePkg = loadPkgNodeExport<unknown>('solve_mate_bytes', PKG_MATE)

// Both pkg-node builds are gitignored artifacts; skip on a fresh checkout the
// same way the other solver-boundary tests do (`just wasm` provisions them).
const describeReal = sketchPkg && matePkg ? describe : describe.skip

describeReal('wasm package split', () => {
  it('exposes each solver from its own package', () => {
    expect(typeof sketchPkg).toBe('function')
    expect(typeof matePkg).toBe('function')
  })

  it('keeps the mate solver out of the sketch package', () => {
    expect(loadPkgNodeExport('solve_mate_bytes', PKG_SKETCH)).toBeUndefined()
  })

  it('keeps the sketch solver and topology builder out of the mate package', () => {
    expect(loadPkgNodeExport('solve_sketch_bytes', PKG_MATE)).toBeUndefined()
    expect(loadPkgNodeExport('detect_topology_bytes', PKG_MATE)).toBeUndefined()
  })

  it('rejects a buffer carrying the other format\'s magic', () => {
    const solveMate = matePkg as (input: Uint8Array) => Uint8Array
    // "SKS1", the sketch input magic, little-endian.
    const sketchMagic = Uint8Array.from([0x53, 0x4b, 0x47, 0x53, ...new Array(32).fill(0)])
    expect(() => solveMate(sketchMagic)).toThrow()
  })
})
