// @vitest-environment node
//
// End-to-end gated test for local-WASM STEP/STL export (exportLocally): build a
// real two-body document and serialise it, with no backend round-trip. Covers
// both export targets -- the whole assembly (a compound of every body) and a
// single body -- for both formats, asserting valid bytes and round-trip parity.
//
// Skips when OCC.js or the Rust sketch solver is absent. Install OCC with:
//   cd frontend && npm run occ:install

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { DisposeScope } from '../occ/disposeScope'
import { stepBytesToShape } from '../occ/stepIo'
import { volumeOf } from '../occ/booleans'
import { exportLocally, solveLocally, setSolveLocalsForTest } from '../solveLocally'
import { setSketchSolver, resetSketchSolver } from '../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import type { OccModule } from '../occ/occTypes'

const oc = await loadOcc()
const solveBytes = loadSolver()

function rectSketch(sketchId: string, w: number, h: number, plane = '@builtin_plane_front') {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane,
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: { bottom: [0, 0, w, 0], right: [w, 0, w, h], top: [w, h, 0, h], left: [0, h, 0, 0] },
    constraints: [
      { id: 'c1', kind: 'coincident' as const, a: { entity: 'bottom', point: 'end' as const }, b: { entity: 'right', point: 'start' as const } },
      { id: 'c2', kind: 'coincident' as const, a: { entity: 'right', point: 'end' as const }, b: { entity: 'top', point: 'start' as const } },
      { id: 'c3', kind: 'coincident' as const, a: { entity: 'top', point: 'end' as const }, b: { entity: 'left', point: 'start' as const } },
      { id: 'c4', kind: 'coincident' as const, a: { entity: 'left', point: 'end' as const }, b: { entity: 'bottom', point: 'start' as const } },
      { id: 'c5', kind: 'horizontal' as const, target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal' as const, target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical' as const, target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical' as const, target: { entity: 'left' } },
      { id: 'c9', kind: 'length' as const, target: { entity: 'bottom' }, value: w },
      { id: 'c10', kind: 'length' as const, target: { entity: 'left' }, value: h },
    ],
  }
}

function extrude(sketchId: string, id: string, distance: number, operation = 'new'): Record<string, unknown> {
  return { id, kind: 'extrude', sketch: '$' + sketchId, distance, direction: 'normal', operation }
}

// Two solids: body_ex1 = 10*10*5 = 500, body_ex2 = 6*6*4 = 144. A compound's
// volume is the sum of its solids' volumes, independent of any overlap.
const VOL_A = 500
const VOL_B = 144

function twoBodyDoc() {
  return {
    id: 'exportDoc',
    features: [
      rectSketch('sk1', 10, 10),
      extrude('sk1', 'ex1', 5, 'new'),
      rectSketch('sk2', 6, 6, '@builtin_plane_right'),
      extrude('sk2', 'ex2', 4, 'new'),
    ],
  }
}

// Read a binary-STL triangle count and verify the buffer self-describes (84-byte
// header/count prefix + 50 bytes per triangle).
function stlTriangleCount(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = view.getUint32(80, true)
  expect(bytes.length).toBe(84 + count * 50)
  return count
}

describe.skipIf(!oc || !solveBytes)('exportLocally (real OCC + Rust solver)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
    resetSketchSolver()
    setSketchSolver(solveBytes)
    // Drive the production entry with the node-loaded module (loadOccWeb skips
    // under vitest).
    setSolveLocalsForTest(async () => oc)
  })
  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('builds the two-body doc with both bodies present', async () => {
    const r = await solveLocally(twoBodyDoc())
    expect(r).not.toBeNull()
    expect(Object.keys(r!.bodies).sort()).toEqual(['body_ex1', 'body_ex2'])
  })

  it('STEP-exports the whole assembly as a compound (sum of both volumes)', async () => {
    const scope = new DisposeScope()
    try {
      const bytes = await exportLocally(twoBodyDoc(), { format: 'step' })
      expect(bytes).not.toBeNull()
      const text = new TextDecoder().decode(bytes!)
      expect(text).toContain('ISO-10303-21')
      expect(text).toContain('END-ISO-10303-21')

      const shape = scope.track(stepBytesToShape(occ, scope, bytes!))
      expect(volumeOf(occ, scope, shape)).toBeCloseTo(VOL_A + VOL_B, 1)
    } finally {
      scope.dispose()
    }
  })

  it('STEP-exports a single body by id', async () => {
    const scope = new DisposeScope()
    try {
      const bytes = await exportLocally(twoBodyDoc(), { format: 'step', bodyId: 'body_ex1' })
      expect(bytes).not.toBeNull()
      const shape = scope.track(stepBytesToShape(occ, scope, bytes!))
      expect(volumeOf(occ, scope, shape)).toBeCloseTo(VOL_A, 1)
    } finally {
      scope.dispose()
    }
  })

  it('STL-exports the whole assembly (both boxes meshed)', async () => {
    const whole = await exportLocally(twoBodyDoc(), { format: 'stl', tessellation: 0.5 })
    const single = await exportLocally(twoBodyDoc(), { format: 'stl', bodyId: 'body_ex1', tessellation: 0.5 })
    expect(whole).not.toBeNull()
    expect(single).not.toBeNull()
    const wholeTris = stlTriangleCount(whole!)
    const singleTris = stlTriangleCount(single!)
    // A box is 12 triangles; the whole assembly is two boxes, so it carries
    // strictly more triangles than a single body.
    expect(singleTris).toBeGreaterThanOrEqual(12)
    expect(wholeTris).toBeGreaterThan(singleTris)
  })

  it('throws for an unknown body id', async () => {
    await expect(exportLocally(twoBodyDoc(), { format: 'step', bodyId: 'nope' }))
      .rejects.toThrow(/not found/)
  })

  it('returns null for a document with no solid body', async () => {
    const bytes = await exportLocally({ id: 'empty', features: [rectSketch('sk1', 4, 4)] }, { format: 'step' })
    expect(bytes).toBeNull()
  })
})
