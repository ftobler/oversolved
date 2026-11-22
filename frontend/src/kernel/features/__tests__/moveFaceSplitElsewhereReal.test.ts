// @vitest-environment node
//
// Regression for the 2026-11-22 "move face outward" report: a 3x3x3 box with an
// elliptic boss on its +Y face. The ellipse overhangs the box in X, so the top
// face is split into a +z and a -z piece on one plane. Moving the +Z face
// outward was refused with "the body has two faces on one surface" although the
// move never touches the split: the guard scanned every face pair of the body.
// It now refuses only a picked split sibling, or a move that rebuilds two
// siblings at once.
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
const BOSS = 'kVJzib-YexiR7tbbApP8CAoC'
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
    initial: { 'nwlCUQb_kHk-gnpp': [-0.05729, -0.010305, 1.967115, 0.836966, -11.971273] },
    entities: [{ id: 'nwlCUQb_kHk-gnpp', kind: 'ellipse' }],
  },
  {
    id: BOSS, kind: 'extrude', label: 'extrude 2',
    extrude: {
      sketch: ['?2a,9,19;@x1EwYBue9X0fLto0nRKDeulA/nwlCUQb_kHk-gnppsurface:0@x1EwYBue9X0fLto0nRKDeulA:flatface'],
      distance: 2.25,
      direction: 'normal',
    },
  },
]

interface FaceInfo { normal?: number[]; centroid?: number[] }
interface PartView { mesh?: { face_queries?: string[]; face_data?: FaceInfo[]; vertices?: number[][] } }

function bbox(part: PartView): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const v of part.mesh?.vertices ?? []) for (let i = 0; i < 3; i++) {
    min[i] = Math.min(min[i], v[i])
    max[i] = Math.max(max[i], v[i])
  }
  return { min, max }
}

/** The +Y faces lying on the box top (y = 1.5): the split siblings. */
function topPieces(part: PartView): { query: string; centroid: number[] }[] {
  const queries = part.mesh?.face_queries ?? []
  const data = part.mesh?.face_data ?? []
  const out: { query: string; centroid: number[] }[] = []
  queries.forEach((query, i) => {
    const n = data[i]?.normal
    const c = data[i]?.centroid
    if (n === undefined || c === undefined) return
    if (Math.abs(n[1] - 1) < 1e-6 && Math.abs(c[1] - 1.5) < 1e-6) out.push({ query, centroid: c })
  })
  return out
}

function withMove(faces: string[], distance: number): Record<string, unknown> {
  return {
    features: [
      ...BASE_FEATURES,
      { id: MOVE, kind: 'move_face', label: 'move_face 2', move_face: { faces, distance } },
    ],
  }
}

describe.skipIf(!oc || !solveBytes)('move face with a boolean split elsewhere on the body (real OCC)', () => {
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

  it('the base body carries the split top face the guard used to trip on', () => {
    const base = h.run({ features: BASE_FEATURES })
    expect(h.res(base, BOSS).status).toBe('ok')
    const pieces = topPieces(h.part(base, PART) as PartView)
    expect(pieces).toHaveLength(2)
    expect(pieces.some((p) => p.centroid[2] > 0)).toBe(true)
    expect(pieces.some((p) => p.centroid[2] < 0)).toBe(true)
  })

  it('the reported outward move builds: +Z grows by 1, the slab adds 9', () => {
    const base = h.run({ features: BASE_FEATURES })
    const before = bbox(h.part(base, PART) as PartView)
    const r = h.run(withMove([FRONT_PICK], 1))
    const res = h.res(r, MOVE)
    expect(res.status, String(res.exception ?? '')).toBe('ok')
    expect((res.failed_faces as string[] | undefined) ?? []).toEqual([])
    const after = bbox(h.part(r, PART) as PartView)
    expect(after.max[2]).toBeCloseTo(2.5, 6)
    for (let i = 0; i < 3; i++) {
      expect(after.min[i]).toBeCloseTo(before.min[i], 6)
      if (i !== 2) expect(after.max[i]).toBeCloseTo(before.max[i], 6)
    }
    // The boss stays inside z = +-1.5, so the added material is the full face slab.
    expect(volumeAfter(r, MOVE) - volumeAfter(base, BOSS)).toBeCloseTo(9, 6)
    // Both top siblings survive: the +z one reshaped, the -z one untouched.
    const pieces = topPieces(h.part(r, PART) as PartView)
    expect(pieces).toHaveLength(2)
  })

  it('the inward move still builds through the cutter', () => {
    const r = h.run(withMove([FRONT_PICK], -1))
    const res = h.res(r, MOVE)
    expect(res.status, String(res.exception ?? '')).toBe('ok')
    expect(bbox(h.part(r, PART) as PartView).max[2]).toBeCloseTo(0.5, 6)
  })

  // -3 lands the +Z face exactly on the -Z face; -5 passes it. Either way the
  // cutter removes the whole body, which is the authored result, not a refusal.
  for (const distance of [-3, -5]) {
    it(`an inward move of ${distance} that removes the whole body succeeds and deletes it`, () => {
      const r = h.run(withMove([FRONT_PICK], distance))
      const res = h.res(r, MOVE)
      expect(res.status, String(res.exception ?? '')).toBe('ok')
      expect(res.exception).toBeUndefined()
      expect(res.body_id).toBe(PART)
      expect(res.body_ids).toEqual([])
      expect((r.bodies as Record<string, unknown>)[PART]).toBeUndefined()
    })
  }

  it('picking a split sibling itself is still refused by name', () => {
    const base = h.run({ features: BASE_FEATURES })
    const front = topPieces(h.part(base, PART) as PartView).find((p) => p.centroid[2] > 0)
    if (front === undefined) throw new Error('no +z top piece')
    const r = h.run(withMove([front.query], 0.5))
    const res = h.res(r, MOVE)
    expect(res.status).toBe('partial')
    expect((res.failed_faces as string[] | undefined) ?? []).not.toHaveLength(0)
    expect(String(res.exception ?? '')).toContain('two faces on one surface')
  })
})
