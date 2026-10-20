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
interface BodyView {
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
      extrude: { sketch: [PROFILE], distance: 10, direction: 'normal' },
    },
  ],
}

const uuidOf = (q: string): string | null => {
  const tok = parseAncestry(q)[0].find((i) => i.startsWith('@u|'))
  return tok === undefined ? null : tok.slice(3)
}

function bbox(body: BodyView): { min: number[]; max: number[] } {
  const verts = body.mesh?.vertices ?? []
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
  const bodyId = `body_${EX}`

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  function bodyOf(r: ReturnType<typeof h.run>): BodyView {
    return h.body(r, bodyId) as BodyView
  }

  // The cylinder radius of the one live face carrying `uuid`.
  function radiusByUuid(body: BodyView, uuid: string): number {
    const queries = body.mesh?.face_queries ?? []
    const data = body.mesh?.face_data ?? []
    const idx = queries.findIndex((q) => uuidOf(q) === uuid)
    const radius = idx < 0 ? undefined : data[idx]?.surface_frame?.radius
    if (radius === undefined) throw new Error(`no cylinder face for ${uuid}`)
    return radius
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
    const body = bodyOf(r)
    const queries = body.mesh?.face_queries ?? []
    const data = body.mesh?.face_data ?? []
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

  it('the split sibling arcs carry distinct UUIDs and each pick moves its own arc', async () => {
    const base = h.run(DOCUMENT)
    expect(h.res(base, EX).status).toBe('ok')
    const picks = cylinderPicks(base)
    const upper = uuidOf(picks.upper)
    const lower = uuidOf(picks.lower)
    if (upper === null || lower === null) throw new Error('the split sibling arcs carry no UUID')
    expect(upper).not.toBe(lower)
    const run = (faces: string[]): BodyView => {
      const r = h.run({
        features: [...DOCUMENT.features, { id: 'mf1', kind: 'move_face', move_face: { faces, distance: 5 } }],
      })
      expect(h.res(r, 'mf1').status).toBe('ok')
      return bodyOf(r)
    }
    // The two arcs are the +y and -y halves of one r25 cylinder. Each pick
    // must move the cap that inherits its own UUID by 5 (whichever way its
    // outward normal points) and leave the sibling at r25, which proves the
    // query reached its own face.
    const upperRun = run([picks.upper])
    expect(Math.abs(radiusByUuid(upperRun, upper) - 25)).toBeCloseTo(5, 3)
    expect(radiusByUuid(upperRun, lower)).toBeCloseTo(25, 3)
    await yieldToEventLoop()
    const lowerRun = run([picks.lower])
    expect(Math.abs(radiusByUuid(lowerRun, lower) - 25)).toBeCloseTo(5, 3)
    expect(radiusByUuid(lowerRun, upper)).toBeCloseTo(25, 3)
    await yieldToEventLoop()
  }, 60000)

  it('the reported pair and the split sibling pair both move', async () => {
    const base = h.run(DOCUMENT)
    const p = cylinderPicks(base)
    for (const faces of [[p.bore, p.lower], [p.upper, p.lower]]) {
      const r = h.run({
        features: [...DOCUMENT.features, { id: 'mf1', kind: 'move_face', move_face: { faces, distance: 5 } }],
      })
      expect(h.res(r, 'mf1').status).toBe('ok')
      expect((h.res(r, 'mf1').body_ids as string[])).toHaveLength(1)
      await yieldToEventLoop()
    }
  }, 60000)

  it('the report\'s literal stored move_face (old shared UUID) builds through the migration', async () => {
    const base = h.run(DOCUMENT)
    expect(h.res(base, EX).status).toBe('ok')
    // The document's own feature (bore + upper arc) and the sibling pair, both
    // naming the pre-split shared UUID.
    const p = cylinderPicks(base)
    for (const faces of [[STORED_BORE, STORED_UPPER], [STORED_UPPER, STORED_LOWER], [p.outerLeft, STORED_UPPER]]) {
      const r = h.run({
        features: [...DOCUMENT.features, { id: 'mf1', kind: 'move_face', move_face: { faces, distance: 5 } }],
      })
      const res = h.res(r, 'mf1')
      expect(res.status, String(res.exception ?? '')).toBe('ok')
      const uuids = (bodyOf(r).mesh?.face_queries ?? [])
        .map(uuidOf)
        .filter((u): u is string => u !== null)
      expect(new Set(uuids).size, 'no two resulting faces share a name').toBe(uuids.length)
      await yieldToEventLoop()
    }
  }, 90000)

  it('distance 0 on sibling picks is still the identity', () => {
    const base = h.run(DOCUMENT)
    const p = cylinderPicks(base)
    const before = bbox(bodyOf(base))
    const r = h.run({
      features: [...DOCUMENT.features, {
        id: 'mf1', kind: 'move_face', move_face: { faces: [p.upper, p.lower], distance: 0 },
      }],
    })
    expect(h.res(r, 'mf1').status).toBe('ok')
    const after = bbox(bodyOf(r))
    for (let i = 0; i < 3; i++) {
      expect(after.min[i]).toBeCloseTo(before.min[i], 6)
      expect(after.max[i]).toBeCloseTo(before.max[i], 6)
    }
  })

  it('every ordered pair of the four cylinder faces moves', async () => {
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
        expect(res.status, `pair ${i},${j}: ${String(res.exception ?? '')}`).toBe('ok')
        await yieldToEventLoop()
      }
    }
  }, 600000)

  it('all four faces move together in list order and in reverse, with the same result', async () => {
    const base = h.run(DOCUMENT)
    const baseBox = bbox(bodyOf(base))
    const p = cylinderPicks(base)
    const picked = [p.outerLeft, p.upper, p.lower, p.bore]
    const runs = [picked, [...picked].reverse()]
    const boxes = []
    for (const faces of runs) {
      const r = h.run({
        features: [...DOCUMENT.features, { id: 'mf1', kind: 'move_face', move_face: { faces, distance: 5 } }],
      })
      expect(h.res(r, 'mf1').status).toBe('ok')
      expect((h.res(r, 'mf1').body_ids as string[])).toHaveLength(1)
      const bb = bbox(bodyOf(r))
      // The three outer arcs grow by 5; the bore closes inward.
      expect(bb.min[0]).toBeLessThan(baseBox.min[0] - 4.5)
      expect(bb.max[0]).toBeGreaterThan(baseBox.max[0] + 4.5)
      boxes.push(bb)
      await yieldToEventLoop()
    }
    for (let i = 0; i < 3; i++) {
      expect(boxes[0].min[i]).toBeCloseTo(boxes[1].min[i], 1)
      expect(boxes[0].max[i]).toBeCloseTo(boxes[1].max[i], 1)
    }
  }, 300000)
})
