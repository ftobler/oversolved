// @vitest-environment node
//
// Gated real-OCC feature-level sweep tests using the full build pipeline
// (OCC.js + Rust WASM sketch solver). Ports the sweep cut scenario from
// test_sweep.py.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { DisposeScope } from '../occ/disposeScope'
import { HandleTable } from '../occ/handleTable'
import { solidToMesh } from '../occ/tessellation'
import { brepDiffNewFaceHashes, brepDiffNewEdgeHashes, brepDiffNewVertexHashes } from '../occ/brepDiffHash'
import { build, type BuildDeps } from '../builder'
import { initGlobalRepo } from '../query'
import { createFeatureSolver } from '../solverRegistry'
import { postRegister } from './postRegister'
import { setSketchSolver, resetSketchSolver } from './sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'

const oc = await loadOcc()
const solveBytes = loadSolver()

function rectSketch(sketchId: string, w: number, h: number, offsetX: number, offsetY: number) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: {
      bottom: [offsetX, offsetY, offsetX + w, offsetY],
      right: [offsetX + w, offsetY, offsetX + w, offsetY + h],
      top: [offsetX + w, offsetY + h, offsetX, offsetY + h],
      left: [offsetX, offsetY + h, offsetX, offsetY],
    },
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

function linePathSketch(sketchId: string, segments: number[]) {
  // segments: flat array [x0,y0,x1,y1, x1,y1,x2,y2, ...]
  const entities: Array<{ id: string; kind: string }> = []
  const initial: Record<string, number[]> = {}
  const constraints: Array<Record<string, unknown>> = []
  let ci = 0
  for (let i = 0; i < segments.length - 3; i += 4) {
    const eid = 'e' + i
    entities.push({ id: eid, kind: 'line' })
    initial[eid] = [segments[i], segments[i + 1], segments[i + 2], segments[i + 3]]
    if (i > 0) {
      constraints.push({ id: 'cc' + (++ci), kind: 'coincident' as const,
        a: { entity: eid, point: 'start' }, b: { entity: 'e' + (i - 4), point: 'end' } })
    }
  }
  return { id: sketchId, kind: 'sketch' as const, label: 'Path', plane: '@builtin_plane_front',
    entities, initial, constraints }
}

describe.skipIf(!oc || !solveBytes)('sweep feature (real OCC + Rust solver)', () => {
  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) }
  })

  function run(spec: Record<string, unknown>) {
    const scope = new DisposeScope()
    const table = new HandleTable({ finalizerGuard: false })
    try {
      const deps: BuildDeps = {
        trySolveFeature: createFeatureSolver(oc!, scope, table),
        postRegister, initGlobalRepo,
        tessellateBodies: (bodyStore) => {
          const out: Record<string, Record<string, unknown>> = {}
          for (const [_, body] of Object.entries(bodyStore)) {
            if (!body.shape) continue
            try { out[body.id] = { mesh: solidToMesh(oc!, table, body.shape), edges: [], edge_queries: [] } }
            catch { /* non-fatal */ }
          }
          return out
        },
        brepDiffNewFaceHashes: (b) => brepDiffNewFaceHashes(oc!, scope, b),
        brepDiffNewEdgeHashes: (b) => brepDiffNewEdgeHashes(oc!, scope, b),
        brepDiffNewVertexHashes: (b) => brepDiffNewVertexHashes(oc!, scope, b),
      }
      const result = build(spec, {}, deps)
      scope.dispose()
      return result
    } catch (e) {
      scope.dispose()
      throw e
    }
  }

  it('basic sweep produces a body', () => {
    /** A rectangle swept along a straight spine produces a valid body.
     *  Baseline case verifying the sweep pipeline works before testing cut. */
    const result = run({
      version: 1, kind: 'part',
      features: [
        rectSketch('prof', 2, 1, 1, 0),
        linePathSketch('pth', [0, 0, 0, 5]),
        { id: 'sw1', kind: 'sweep', label: 'Sweep',
          sweep: { sketch: ['$prof'], path: '$pth', operation: 'new' } },
      ],
    })
    const r = result.result as Record<string, Record<string, unknown>>
    expect(r.sw1.status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_sw1')
  })
})
