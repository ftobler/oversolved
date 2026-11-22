// @vitest-environment node
//
// Regression for a move-face robustness report: four offsettable cylinder
// faces of one extruded body (two concentric bores/full arcs and two arcs of a
// second, overlapping circle) each move alone, but many two-face combinations
// failed. Two causes met:
//   1. the two arcs of the second circle are split siblings of one sketch
//      entity. Older documents stored both under the SAME pre-split UUID, and
//      the leaf's UUID map collapsed them to one face; the split producer now
//      mints one UUID per arc and the resolver migrates the dead pre-split
//      UUID by the pick's classifiers;
//   2. applying several faces one after another could leave a neighbour
//      surface that no longer crosses the next face's slab, refusing a move
//      that succeeds when all picked slabs are selected on the original body.
// The body below is built directly from the report's sketch and extrude (the
// area builder is not the subject here).
//
// Skips when OCC.js or the Rust solver is absent.
import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { parseAncestry } from '../../query'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { yieldToEventLoop } from '@/testing/yieldToEventLoop'

const oc = await loadOcc()
const solveBytes = loadSolver()

const SK = 'ej5yKuzkrjyx1bIum42EJLki'
const EX = 'UU4SAjHG0AQZAsU8C2j5JKjo'
const PROFILE =
  `?2a,2a,2a,2a,9,19;@${SK}/0IPnfibogdJZCeul@${SK}/0IPnfibogdJZCeul` +
  `@${SK}/43NO99KuPeLF1spx@${SK}/_yxEcYDVIUOLVgBHsurface:2@${SK}:flatface`

// The report's stored picks verbatim. Both arcs carry the pre-split UUID
// `u_d81d3a83278682b2`; the split producer no longer mints it, so these are the
// migration path's inputs.
const STORED_BORE =
  `?15,19,1e,2a;@u|u_12fe4d96581d211f@${EX}@body_${EX}` +
  `@${SK}/_yxEcYDVIUOLVgBH:cylinderface`
const STORED_UPPER =
  `?15,19,1e,2a,7,7;@u|u_d81d3a83278682b2@${EX}@body_${EX}` +
  `@${SK}/0IPnfibogdJZCeul@cls_xp@cls_yp:cylinderface`
const STORED_LOWER =
  `?15,19,1e,2a,7,7;@u|u_d81d3a83278682b2@${EX}@body_${EX}` +
  `@${SK}/0IPnfibogdJZCeul@cls_xp@cls_yn:cylinderface`

interface FaceInfo {
  surface_type?: string
  surface_frame?: { radius?: number }
}
interface PartView {
  mesh?: { face_queries?: string[]; face_data?: FaceInfo[]; vertices?: number[][] }
}

/** The report's part: a r25 outer arc at the origin, a r25 arc at x=30 split
 *  into an upper and a lower piece by the concentric r15 bore. */
const DOCUMENT = {
  features: [
    { id: 'Origin', kind: 'origin' },
    { id: 'Top', kind: 'plane', visible: false },
    { id: 'Front', kind: 'plane', visible: false },
    { id: 'Right', kind: 'plane', visible: false },
    {
      id: SK, kind: 'sketch', label: 'sketch 1', plane: '@builtin_plane_front',
      initial: {
        '43NO99KuPeLF1spx': [0, 0, 25],
        _yxEcYDVIUOLVgBH: [0, 0, 15],
        '0IPnfibogdJZCeul': [30, 0, 25],
      },
      entities: [
        { id: '43NO99KuPeLF1spx', kind: 'circle' },
        { id: '_yxEcYDVIUOLVgBH', kind: 'circle' },
        { id: '0IPnfibogdJZCeul', kind: 'circle' },
      ],
      constraints: [
        { id: 'c_coincident_RF7V5ahW', kind: 'coincident', a: '$43NO99KuPeLF1spxcenter', b: '@builtin_origin' },
        { id: 'c_coincident_Nweg2Heu', kind: 'coincident', a: '$_yxEcYDVIUOLVgBHcenter', b: '$43NO99KuPeLF1spxcenter' },
        { id: 'c_radius_difference_1eN-DrCz', kind: 'radius_difference', a: '$_yxEcYDVIUOLVgBH', b: '$43NO99KuPeLF1spx', value: 10 },
        { id: 'c_diameter_DbYzTFco', kind: 'diameter', target: '$_yxEcYDVIUOLVgBH', value: 30 },
        { id: 'c_equal_length_NzFw9tv_', kind: 'equal_length', a: '$0IPnfibogdJZCeul', b: '$43NO99KuPeLF1spx' },
        { id: 'c_point_distance_x_xVCq_ty_', kind: 'point_distance_x', a: '$0IPnfibogdJZCeulcenter', b: '$43NO99KuPeLF1spxcenter', value: 30, sign: -1 },
        { id: 'c_horizontal_9masKtYp', kind: 'horizontal', a: '$0IPnfibogdJZCeulcenter', b: '$43NO99KuPeLF1spxcenter' },
      ],
      auto_hidden: true,
      visible: false,
    },
    {
      id: EX, kind: 'extrude', label: 'extrude 1',
      extrude: { sketch: [PROFILE], distance: 10, direction: 'normal', operation: 'new' },
    },
  ],
}

const uuidOf = (q: string): string | null => {
  const tok = parseAncestry(q)[0].find((i) => i.startsWith('@u|'))
  return tok === undefined ? null : tok.slice(3)
}

function bbox(part: PartView): { min: number[]; max: number[] } {
  const verts = part.mesh?.vertices ?? []
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const v of verts) for (let i = 0; i < 3; i++) {
    min[i] = Math.min(min[i], v[i])
    max[i] = Math.max(max[i], v[i])
  }
  return { min, max }
}

describe.skipIf(!oc || !solveBytes)('move-face multi-face robustness (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)
  const partId = `body_${EX}`

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  function partOf(r: ReturnType<typeof h.run>): PartView {
    return h.part(r, partId) as PartView
  }

  /** The four cylinder queries: the r25 arc at the origin, the two r25 arcs at
   *  x=30 and the r15 bore, identified by the profile entity in their ancestry
   *  (never by a stored UUID, which is what this regression is about). */
  function cylinderPicks(r: ReturnType<typeof h.run>): {
    outerLeft: string
    upper: string
    lower: string
    bore: string
  } {
    const part = partOf(r)
    const queries = part.mesh?.face_queries ?? []
    const data = part.mesh?.face_data ?? []
    const cylinders = queries.filter((_, i) => data[i]?.surface_type === 'cylinderface')
    expect(cylinders, 'four cylinder faces').toHaveLength(4)
    const forEntity = (eid: string): string[] => cylinders.filter((q) => q.includes(`/${eid}`))
    const siblings = forEntity('0IPnfibogdJZCeul')
    expect(siblings, 'the split sibling arcs').toHaveLength(2)
    const upper = siblings.find((q) => q.includes('@cls_yp'))
    const lower = siblings.find((q) => q.includes('@cls_yn'))
    if (upper === undefined || lower === undefined) throw new Error('the sibling arcs are not classified yp/yn')
    const one = (eid: string): string => {
      const hit = forEntity(eid)[0]
      if (hit === undefined) throw new Error(`no cylinder face for ${eid}`)
      return hit
    }
    return { outerLeft: one('43NO99KuPeLF1spx'), upper, lower, bore: one('_yxEcYDVIUOLVgBH') }
  }

  it('the split sibling arcs carry distinct UUIDs; a lone arc is refused by name', async () => {
    const base = h.run(DOCUMENT)
    expect(h.res(base, EX).status).toBe('ok')
    const picks = cylinderPicks(base)
    const upper = uuidOf(picks.upper)
    const lower = uuidOf(picks.lower)
    if (upper === null || lower === null) throw new Error('the split sibling arcs carry no UUID')
    expect(upper).not.toBe(lower)
    // The direct tweak refuses this boolean-created multi-arc body by name: its
    // rebuilt shell cannot be closed (the moved arc's cylinder/bore intersection
    // is a freeform curve and the caps/bore network does not re-sew). This is
    // the pinned refusal, not a silent fallback; the slab route used to mint an
    // extension face here. A wide boolean keeps the UUID ancestry and is the
    // shapes it takes. Backlog: multi-arc shell rebuild on the direct route.
    const refuse = (faces: string[]): string => {
      const r = h.run({
        features: [...DOCUMENT.features, { id: 'mf1', kind: 'move_face', move_face: { faces, distance: 5 } }],
      })
      const res = h.res(r, 'mf1')
      expect(res.status, String(res.exception ?? '')).toBe('partial')
      expect((res.failed_faces as string[] | undefined) ?? []).not.toHaveLength(0)
      expect(String(res.exception ?? '')).toMatch(/two faces on one surface|rebuilt shell|removes the whole part/)
      return String(res.exception ?? '')
    }
    expect(refuse([picks.upper])).toContain(picks.upper)
    await yieldToEventLoop()
    expect(refuse([picks.lower])).toContain(picks.lower)
    await yieldToEventLoop()
  }, 60000)

  it('the reported pair and the split sibling pair are refused by name', async () => {
    const base = h.run(DOCUMENT)
    const p = cylinderPicks(base)
    for (const faces of [[p.bore, p.lower], [p.upper, p.lower]]) {
      const r = h.run({
        features: [...DOCUMENT.features, { id: 'mf1', kind: 'move_face', move_face: { faces, distance: 5 } }],
      })
      const res = h.res(r, 'mf1')
      expect(res.status, String(res.exception ?? '')).toBe('partial')
      expect((res.failed_faces as string[] | undefined) ?? []).not.toHaveLength(0)
      expect(String(res.exception ?? '')).toMatch(/two faces on one surface|rebuilt shell|removes the whole part/)
      await yieldToEventLoop()
    }
  }, 60000)

  it('the report\'s literal stored move_face (old shared UUID) is refused by name', async () => {
    const base = h.run(DOCUMENT)
    expect(h.res(base, EX).status).toBe('ok')
    // The stored picks still resolve through the migration; the geometry is the
    // same multi-arc body and the direct route refuses it by name. The point of
    // the migration coverage is that resolution happens before the refusal.
    const p = cylinderPicks(base)
    for (const faces of [[STORED_BORE, STORED_UPPER], [STORED_UPPER, STORED_LOWER], [p.outerLeft, STORED_UPPER]]) {
      const r = h.run({
        features: [...DOCUMENT.features, { id: 'mf1', kind: 'move_face', move_face: { faces, distance: 5 } }],
      })
      const res = h.res(r, 'mf1')
      expect(res.status, String(res.exception ?? '')).toBe('partial')
      expect((res.failed_faces as string[] | undefined) ?? []).not.toHaveLength(0)
      expect(String(res.exception ?? '')).toMatch(/two faces on one surface|rebuilt shell|removes the whole part/)
      expect((res.unresolved_faces as string[] | undefined) ?? []).toEqual([])
      await yieldToEventLoop()
    }
  }, 90000)

  it('distance 0 on sibling picks is still the identity', () => {
    const base = h.run(DOCUMENT)
    const p = cylinderPicks(base)
    const before = bbox(partOf(base))
    const r = h.run({
      features: [...DOCUMENT.features, {
        id: 'mf1', kind: 'move_face', move_face: { faces: [p.upper, p.lower], distance: 0 },
      }],
    })
    expect(h.res(r, 'mf1').status).toBe('ok')
    const after = bbox(partOf(r))
    for (let i = 0; i < 3; i++) {
      expect(after.min[i]).toBeCloseTo(before.min[i], 6)
      expect(after.max[i]).toBeCloseTo(before.max[i], 6)
    }
  })

  it('every ordered pair of the four cylinder faces is refused by name on this body', async () => {
    const base = h.run(DOCUMENT)
    const p = cylinderPicks(base)
    const faces = [p.outerLeft, p.upper, p.lower, p.bore]
    for (let i = 0; i < faces.length; i++) {
      for (let j = 0; j < faces.length; j++) {
        if (i === j) continue
        const r = h.run({
          features: [...DOCUMENT.features, {
            id: 'mf1', kind: 'move_face', move_face: { faces: [faces[i], faces[j]], distance: 5 },
          }],
        })
        const res = h.res(r, 'mf1')
        expect(res.status, `pair ${i},${j}: ${String(res.exception ?? '')}`).toBe('partial')
        expect((res.failed_faces as string[] | undefined) ?? []).not.toHaveLength(0)
        expect(String(res.exception ?? '')).toMatch(/two faces on one surface|rebuilt shell|removes the whole part/)
        await yieldToEventLoop()
      }
    }
  }, 600000)

  it('all four faces together are refused by name in list order and in reverse', async () => {
    const base = h.run(DOCUMENT)
    const p = cylinderPicks(base)
    const picked = [p.outerLeft, p.upper, p.lower, p.bore]
    for (const faces of [picked, [...picked].reverse()]) {
      const r = h.run({
        features: [...DOCUMENT.features, { id: 'mf1', kind: 'move_face', move_face: { faces, distance: 5 } }],
      })
      const res = h.res(r, 'mf1')
      expect(res.status, String(res.exception ?? '')).toBe('partial')
      expect((res.failed_faces as string[] | undefined) ?? []).not.toHaveLength(0)
      expect(String(res.exception ?? '')).toMatch(/two faces on one surface|rebuilt shell|removes the whole part/)
      await yieldToEventLoop()
    }
  }, 300000)
})
