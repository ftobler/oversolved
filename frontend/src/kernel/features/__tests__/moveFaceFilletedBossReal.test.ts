// @vitest-environment node
//
// Regression for the 2026-11-22 "move face error 2" report: a 3x3x3 box with a
// centred elliptic boss on its +Y face, the boss's base edge filleted r0.4.
// Moving the +Z face outward was refused with "the body has two faces on one
// surface" although nothing the move touches is a boolean split.
//
// Skips when OCC.js or the Rust solver is absent.
import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { DisposeScope } from '../../occ/disposeScope'
import { volumeOf } from '../../occ/volume'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import type { BuildResponse } from '../../builder'
import type { OccShape } from '../../occ/occTypes'

const oc = await loadOcc()
const solveBytes = loadSolver()

const PART = 'body_ex1'
const FILLET = '-Dd5RNlJDw84y6RyeatuzSzu'
const MOVE = 'xMzMp5tFZphlyN0DEIsaHhzg'
// The report's stored +Z pick verbatim.
const FRONT_PICK =
  '?15,4,9,15,15,15,15,7;@u|u_f1f3430b8c166c93@ex1@body_ex1@sk1/4iejEu0DIweXuHyU' +
  '@sk1/CBwI0hYnpud6k1Be@sk1/rl7cXPyFcqFF6xuq@sk1/wWsYjbNYOs7x3PkN@cls_zp:flatface'

const BASE_FEATURES: Array<Record<string, unknown>> = [
  { id: 'Origin', kind: 'origin' },
  { id: 'Top', kind: 'plane', visible: false },
  { id: 'Front', kind: 'plane', visible: false },
  { id: 'Right', kind: 'plane', visible: false },
  {
    id: 'sk1', kind: 'sketch', label: 'Box', plane: '@builtin_plane_front',
    entities: [
      { id: 'wWsYjbNYOs7x3PkN', kind: 'line' },
      { id: 'CBwI0hYnpud6k1Be', kind: 'line' },
      { id: 'rl7cXPyFcqFF6xuq', kind: 'line' },
      { id: '4iejEu0DIweXuHyU', kind: 'line' },
      { id: 'lL53or3BHOQKFFUl', kind: 'point' },
    ],
    initial: {
      wWsYjbNYOs7x3PkN: [-1.5, -1.5, 1.5, -1.5],
      CBwI0hYnpud6k1Be: [1.5, -1.5, 1.5, 1.5],
      rl7cXPyFcqFF6xuq: [1.5, 1.5, -1.5, 1.5],
      '4iejEu0DIweXuHyU': [-1.5, 1.5, -1.5, -1.5],
      lL53or3BHOQKFFUl: [0, 0],
    },
    constraints: [
      { id: 'c_coincident_FOrBvLGg', kind: 'coincident', a: '$wWsYjbNYOs7x3PkNend', b: '$CBwI0hYnpud6k1Bestart' },
      { id: 'c_coincident_epDJ63Bf', kind: 'coincident', a: '$CBwI0hYnpud6k1Beend', b: '$rl7cXPyFcqFF6xuqstart' },
      { id: 'c_coincident_6bNWdmsI', kind: 'coincident', a: '$rl7cXPyFcqFF6xuqend', b: '$4iejEu0DIweXuHyUstart' },
      { id: 'c_coincident_jdSJnsPl', kind: 'coincident', a: '$4iejEu0DIweXuHyUend', b: '$wWsYjbNYOs7x3PkNstart' },
      { id: 'c_equal_length_jfWr1Evc', kind: 'equal_length', a: '$wWsYjbNYOs7x3PkN', b: '$rl7cXPyFcqFF6xuq' },
      { id: 'c_equal_length_kJaEaKp_', kind: 'equal_length', a: '$CBwI0hYnpud6k1Be', b: '$4iejEu0DIweXuHyU' },
      { id: 'c_horizontal_u7dXkrFp', kind: 'horizontal', target: '$wWsYjbNYOs7x3PkN' },
      { id: 'c_vertical_EKxgCfjl', kind: 'vertical', target: '$CBwI0hYnpud6k1Be' },
      { id: 'c_midpoint_Q_C9MgCX', kind: 'midpoint', point_a: '$wWsYjbNYOs7x3PkNstart', point_b: '$rl7cXPyFcqFF6xuqstart', point: '$lL53or3BHOQKFFUlxy' },
      { id: 'c_length_vxMD18Un', kind: 'length', target: '$wWsYjbNYOs7x3PkN', value: 3 },
      { id: 'c_length_p-qy4jdl', kind: 'length', target: '$CBwI0hYnpud6k1Be', value: 3 },
      { id: 'c_coincident_MnSguQY4', kind: 'coincident', a: '$lL53or3BHOQKFFUlxy', b: '@builtin_origin' },
    ],
  },
  {
    id: 'ex1', kind: 'extrude', label: 'Extrude',
    extrude: { sketch: ['$sk1'], distance: 3, direction: 'symmetric', operation: 'new' },
  },
  {
    id: 'x1EwYBue9X0fLto0nRKDeulA', kind: 'sketch', label: 'sketch 3',
    plane: '?15,4,9,15,7;@u|u_9595960713d23970@ex1@body_ex1@sk1/rl7cXPyFcqFF6xuq@cls_yp:flatface',
    initial: { WpqUeBS_QJYGVyEY: [0, 0, 1.353869, 0.836691, 32.513924] },
    entities: [{ id: 'WpqUeBS_QJYGVyEY', kind: 'ellipse' }],
    constraints: [
      { id: 'c_coincident_hl514RPU', kind: 'coincident', a: '$WpqUeBS_QJYGVyEYcenter', b: '@builtin_origin' },
    ],
  },
  {
    id: 'kVJzib-YexiR7tbbApP8CAoC', kind: 'extrude', label: 'extrude 2',
    extrude: { sketch: ['@x1EwYBue9X0fLto0nRKDeulA'], distance: 2.25, direction: 'normal' },
  },
  {
    id: FILLET, kind: 'fillet', label: 'fillet 2',
    fillet: {
      edges: ['?15,19,9,15;@u|e_b0c3492fdf1fbba3@kVJzib-YexiR7tbbApP8CAoC@body_ex1@sk1/rl7cXPyFcqFF6xuq:edge'],
      radius: 0.4,
    },
  },
]

interface PartView { mesh?: { vertices?: number[][] } }

function bbox(part: PartView): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const v of part.mesh?.vertices ?? []) for (let i = 0; i < 3; i++) {
    min[i] = Math.min(min[i], v[i])
    max[i] = Math.max(max[i], v[i])
  }
  return { min, max }
}

function withMove(distance: number): Record<string, unknown> {
  return {
    features: [
      ...BASE_FEATURES,
      { id: MOVE, kind: 'move_face', label: 'move_face 2', move_face: { faces: [FRONT_PICK], distance } },
    ],
  }
}

describe.skipIf(!oc || !solveBytes)('move face next to a filleted boss (real OCC)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  function volumeAfter(result: BuildResponse, featureId: string): number {
    const handle = result._build_state.checkpoints[featureId]?.body_store_snapshot?.[PART]?.shape
    if (!handle) throw new Error(`no checkpoint shape for ${featureId}/${PART}`)
    const scope = new DisposeScope()
    try {
      return volumeOf(oc!, scope, h.table.get<OccShape>(handle))
    } finally {
      scope.dispose()
    }
  }

  it('the reported outward move builds: +Z grows by 1.09, the slab adds 3 * 3 * 1.09', () => {
    const base = h.run({ features: BASE_FEATURES })
    expect(h.res(base, FILLET).status, String(h.res(base, FILLET).exception ?? '')).toBe('ok')
    const before = bbox(h.part(base, PART) as PartView)
    const r = h.run(withMove(1.09))
    const res = h.res(r, MOVE)
    expect(res.status, String(res.exception ?? '')).toBe('ok')
    const after = bbox(h.part(r, PART) as PartView)
    expect(after.max[2]).toBeCloseTo(2.59, 6)
    for (let i = 0; i < 3; i++) {
      expect(after.min[i]).toBeCloseTo(before.min[i], 6)
      if (i !== 2) expect(after.max[i]).toBeCloseTo(before.max[i], 6)
    }
    // The boss and its fillet stay inside z = +-1.5: the slab is the full face.
    expect(volumeAfter(r, MOVE) - volumeAfter(base, FILLET)).toBeCloseTo(9 * 1.09, 6)
  })

  // The r0.4 fillet runs off the box's +-X top edges, so the +X face borders
  // both top-face pieces and a BSpline fillet face. Growing it would extend the
  // fillet past x = 1.5, which the direct tweak cannot build: pinned refusal
  // (backlog: move face extending a fillet). Shrinking it is the half-space cut.
  function plusXPick(base: BuildResponse): string {
    const part = h.part(base, PART) as { mesh?: { face_queries?: string[]; face_data?: { normal?: number[]; centroid?: number[] }[] } }
    const data = part.mesh?.face_data ?? []
    const hit = (part.mesh?.face_queries ?? []).find((_, i) => {
      const n = data[i]?.normal
      const c = data[i]?.centroid
      return n !== undefined && c !== undefined && Math.abs(n[0] - 1) < 1e-6 && Math.abs(c[0] - 1.5) < 1e-6
    })
    if (hit === undefined) throw new Error('no +X face')
    return hit
  }

  it('growing +X into the fillet is refused by name, the body untouched', () => {
    const base = h.run({ features: BASE_FEATURES })
    const r = h.run({ features: [...BASE_FEATURES, { id: MOVE, kind: 'move_face', move_face: { faces: [plusXPick(base)], distance: 0.5 } }] })
    const res = h.res(r, MOVE)
    expect(res.status).toBe('partial')
    expect(String(res.exception ?? '')).toContain('two faces on one surface')
    expect(bbox(h.part(r, PART) as PartView).max[0]).toBeCloseTo(1.5, 6)
  })

  // At r0.5 the fillet (ellipse z half-width about 1.01 + r) reaches past the
  // +Z top edge, so +Z becomes the same fillet-extension case as +X above.
  it('with a r0.5 fillet the +Z grow reaches the fillet and is refused; the cut still builds', () => {
    const feats = BASE_FEATURES.map((f) => f.id === FILLET ? { ...f, fillet: { ...(f.fillet as object), radius: 0.5 } } : f)
    const grow = h.run({ features: [...feats, { id: MOVE, kind: 'move_face', move_face: { faces: [FRONT_PICK], distance: 1.09 } }] })
    expect(h.res(grow, FILLET).status).toBe('ok')
    expect(h.res(grow, MOVE).status).toBe('partial')
    expect(String(h.res(grow, MOVE).exception ?? '')).toContain('two faces on one surface')
    const cut = h.run({ features: [...feats, { id: MOVE, kind: 'move_face', move_face: { faces: [FRONT_PICK], distance: -1.09 } }] })
    expect(h.res(cut, MOVE).status, String(h.res(cut, MOVE).exception ?? '')).toBe('ok')
  })

  it('shrinking +X through the fillet builds as a cut', () => {
    const base = h.run({ features: BASE_FEATURES })
    const r = h.run({ features: [...BASE_FEATURES, { id: MOVE, kind: 'move_face', move_face: { faces: [plusXPick(base)], distance: -0.5 } }] })
    const res = h.res(r, MOVE)
    expect(res.status, String(res.exception ?? '')).toBe('ok')
    expect(bbox(h.part(r, PART) as PartView).max[0]).toBeCloseTo(1, 6)
    // At least the box slab goes; the boss and fillet past x = 1 go with it.
    expect(volumeAfter(base, FILLET) - volumeAfter(r, MOVE)).toBeGreaterThan(4.5)
  })
})
