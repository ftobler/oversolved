// @vitest-environment node
//
// Full-document real-OCC + Rust-solver tests for the helix reference curve: the
// doc-level paths the direct-OCC helixReal suite cannot reach (a real face pick
// resolved through the construction-UUID tier after an upstream edit, the
// builder's per-feature error isolation, and the checkpoint snapshot the
// `_curve_<id>` descriptor has to survive). Skips when OCC.js or the Rust solver
// is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import type { BuildState } from '../../types3d'

const oc = await loadOcc()
const solveBytes = loadSolver()

type Dict = Record<string, unknown>

/** A circle sketch centred on the plane origin; extruded, it is the boss. */
function circleSketch(id: string, r: number, plane = '@builtin_plane_front'): Dict {
  return { id, kind: 'sketch', plane, entities: [{ id: 'c0', kind: 'circle' }], initial: { c0: [0, 0, r] }, constraints: [] }
}

/** A 1x1 square centred at sketch (cx, cy) in a rectangle-style boundary. */
function squareSketch(id: string, cx: number, cy: number, plane = '@builtin_plane_top'): Dict {
  const h = 0.5
  return {
    id, kind: 'sketch', plane,
    entities: [
      { id: 'bottom', kind: 'line' }, { id: 'right', kind: 'line' },
      { id: 'top', kind: 'line' }, { id: 'left', kind: 'line' },
    ],
    initial: {
      bottom: [cx - h, cy - h, cx + h, cy - h],
      right: [cx + h, cy - h, cx + h, cy + h],
      top: [cx + h, cy + h, cx - h, cy + h],
      left: [cx - h, cy + h, cx - h, cy - h],
    },
    constraints: [
      { id: 'c1', kind: 'coincident', a: { entity: 'bottom', point: 'end' }, b: { entity: 'right', point: 'start' } },
      { id: 'c2', kind: 'coincident', a: { entity: 'right', point: 'end' }, b: { entity: 'top', point: 'start' } },
      { id: 'c3', kind: 'coincident', a: { entity: 'top', point: 'end' }, b: { entity: 'left', point: 'start' } },
      { id: 'c4', kind: 'coincident', a: { entity: 'left', point: 'end' }, b: { entity: 'bottom', point: 'start' } },
      { id: 'c5', kind: 'horizontal', target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal', target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical', target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical', target: { entity: 'left' } },
      { id: 'c9', kind: 'length', target: { entity: 'bottom' }, value: 1 },
      { id: 'c10', kind: 'length', target: { entity: 'left' }, value: 1 },
    ],
  }
}

function extrude(id: string, sketch: string, distance: number, operation = 'add'): Dict {
  return { id, kind: 'extrude', sketch: `$${sketch}`, distance, direction: 'normal', operation }
}

function helix(id: string, reference: string, over: Dict = {}): Dict {
  return {
    id, kind: 'helix',
    helix: {
      reference, radius_mode: 'derived', mode: 'pitch_height', pitch: 2,
      height_from_reference: true, offset: 0, start_angle: 0, hand: 'right', direction: 'normal',
      ...over,
    },
  }
}

/** The lateral cylinder face of `body_ex1` in the first build, as a slash ref. */
function cylinderFaceQuery(mesh: { face_data?: Array<{ surface_type?: string }>; face_queries?: string[] } | undefined): string {
  const fd = mesh?.face_data ?? []
  const idx = fd.findIndex((f) => f.surface_type === 'cylinderface')
  if (idx < 0) throw new Error('no cylinder face in the built body')
  const q = mesh?.face_queries?.[idx]
  if (q === undefined) throw new Error('no face query for the cylinder face')
  return q
}

describe.skipIf(!oc || !solveBytes)('helix full-document (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)
  beforeAll(() => { if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) } })

  it('a boss height edit re-derives the helix turns through the face pick', () => {
    // First build the boss alone to learn which sorted face is its lateral
    // cylinder; the doc then references that face by slash id.
    const r1 = h.run({ features: [circleSketch('skc', 5), extrude('ex1', 'skc', 10)] })
    expect(h.res(r1, 'ex1').status).toBe('ok')
    const ref = cylinderFaceQuery(h.body(r1, 'body_ex1').mesh as { face_data?: Array<{ surface_type?: string }>; face_queries?: string[] })

    const spec = (distance: number) => ({
      features: [
        circleSketch('skc', 5),
        extrude('ex1', 'skc', distance),
        helix('hx1', ref),
      ],
    })
    const before = h.run(spec(10))
    expect(h.res(before, 'hx1').status).toBe('ok')
    expect((h.res(before, 'hx1').helix as { turns: number }).turns).toBeCloseTo(5)

    // The edit rebuilds the boss; the pick is remapped through its construction
    // UUID (or the unchanged index) and the helix re-derives 14 / 2 = 7 turns.
    const after = h.run(spec(14), { prevState: before._build_state })
    expect(h.res(after, 'hx1').status).toBe('ok')
    const hx = h.res(after, 'hx1').helix as { turns: number; height: number }
    expect(hx.turns).toBeCloseTo(7)
    expect(hx.height).toBeCloseTo(14)
  }, 60000)

  it('a deleted upstream reference errors the helix but the solve continues', () => {
    // `body_gone` is never built, so the helix's face reference cannot resolve.
    // Its failure must be contained: the following extrude still solves, and no
    // `_curve_hx1` descriptor is left behind in the repo.
    const r = h.run({
      features: [
        circleSketch('skc', 5),
        extrude('ex1', 'skc', 10),
        helix('hx1', '@body_gone/face/0'),
        { id: 'ex2', kind: 'extrude', sketch: '$skc', distance: 3, direction: 'normal', operation: 'new' },
      ],
    })
    expect(h.res(r, 'hx1').status).not.toBe('ok')
    expect(String(h.res(r, 'hx1').exception ?? '')).toMatch(/helix/)
    expect(h.res(r, 'ex2').status).toBe('ok')
    expect(r.bodies).toHaveProperty('body_ex2')

    const state = r._build_state as BuildState
    const repo = (state.checkpoints['ex2'].repo_snapshot as { elements: Record<string, unknown> }).elements
    expect(repo['_curve_hx1']).toBeUndefined()
  }, 60000)

  it('the _curve_ descriptor survives the checkpoint and a downstream sweep rebuilds', () => {
    // skc: a radius-10 circle about +Z. hx1 rides it, start (10,0,0). skp: a 1x1
    // square in the top (y=0) plane centred at local (10,0) -> world (10,0,0),
    // a radial profile on the helix. A variable between them is the edited
    // feature: changing it invalidates everything after, so hx1 is restored from
    // its checkpoint and sw1 re-solves by reading the RESTORED `_curve_hx1`.
    const spec = (expr: string) => ({
      features: [
        circleSketch('skc', 10),
        helix('hx1', '@skc/c0', { mode: 'pitch_turns', pitch: 3, turns: 4, height_from_reference: false }),
        { id: 'var1', kind: 'variable', variable: { expression: expr } },
        squareSketch('skp', 10, 0),
        { id: 'sw1', kind: 'sweep', sweep: { sketch: '$skp', path: '@hx1', operation: 'new' } },
      ],
    })
    const r1 = h.run(spec('5'))
    expect(h.res(r1, 'hx1').status).toBe('ok')
    expect(h.res(r1, 'sw1').status).toBe('ok')
    const v1 = meshVolume(h.body(r1, 'body_sw1').mesh as MeshLike)
    // Pappus: A * 2 pi rbar * turns = 1 * 2 pi * 10 * 4 = 80 pi.
    expect(Math.abs(v1 - 80 * Math.PI)).toBeLessThan(80 * Math.PI * 0.02)

    const r2 = h.run(spec('6'), { prevState: r1._build_state })
    // The helix is the clean prefix: restored, not re-solved. The sweep is after
    // the edited variable, so it re-solves against the restored descriptor.
    expect(h.lastSolved).not.toContain('hx1')
    expect(h.lastSolved).toContain('sw1')
    expect(h.res(r2, 'sw1').status).toBe('ok')
    const v2 = meshVolume(h.body(r2, 'body_sw1').mesh as MeshLike)
    expect(v2).toBeCloseTo(v1, 6)

    // And the descriptor is plain data in the checkpoint snapshot.
    const cp = ((r1._build_state as BuildState).checkpoints['hx1'].repo_snapshot as { elements: Record<string, unknown> }).elements
    const desc = cp['_curve_hx1'] as Dict
    expect(desc.kind).toBe('helix')
    expect(desc.radius).toBeCloseTo(10)
    expect(structuredClone(desc)).toEqual(desc)
  }, 60000)
})

interface MeshLike {
  vertices: number[][]
  faces: number[][]
}

/** Signed-tetrahedron volume of a closed triangle mesh. */
function meshVolume(mesh: MeshLike): number {
  let v = 0
  for (const [a, b, c] of mesh.faces) {
    const pa = mesh.vertices[a]
    const pb = mesh.vertices[b]
    const pc = mesh.vertices[c]
    v += (
      pa[0] * (pb[1] * pc[2] - pb[2] * pc[1]) -
      pa[1] * (pb[0] * pc[2] - pb[2] * pc[0]) +
      pa[2] * (pb[0] * pc[1] - pb[1] * pc[0])
    ) / 6
  }
  return Math.abs(v)
}
