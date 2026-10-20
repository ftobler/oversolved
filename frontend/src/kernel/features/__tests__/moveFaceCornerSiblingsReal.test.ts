// @vitest-environment node
//
// The four move-face reports of 2026-10-20 share one geometry family: a
// crescent body (left r25 disk minus a right r25 bite) with an r15 bore that
// crosses the bite, so the bite wall is split into an upper and a lower arc.
//   - 0648: moving the bore then the upper arc refused ("the neighbours do not
//     bound the moved face") because the arc split tool left one cell spanning
//     both siblings on the same cylinder.
//   - 0650/0651: the same split left old r25 and r15 pieces at the corners.
//   - 0654: the top face + bore + upper arc hung in the combined boolean.
// The documents and picks below are copied verbatim from the reports (the
// stored UUIDs match the rebuilt body, so the literal queries resolve).
//
// Skips when OCC.js or the Rust solver is absent.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { parseAncestry } from '../../query'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { DisposeScope } from '../../occ/disposeScope'
import { volumeOf } from '../../occ/volume'
import type { OccShape } from '../../occ/occTypes'
import { solveWithTimeout, disposeWorker } from '../../solveTimeout'
import type { BuildResponse } from '../../builder'

const oc = await loadOcc()
const solveBytes = loadSolver()

const SK = 'ej5yKuzkrjyx1bIum42EJLki'
const EX = 'UU4SAjHG0AQZAsU8C2j5JKjo'
const BODY = `body_${EX}`
const PROFILE =
  `?2a,2a,2a,2a,9,19;@${SK}/0IPnfibogdJZCeul@${SK}/0IPnfibogdJZCeul` +
  `@${SK}/43NO99KuPeLF1spx@${SK}/_yxEcYDVIUOLVgBHsurface:2@${SK}:flatface`

const BASE_FEATURES: Array<Record<string, unknown>> = [
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
      { id: 'c_radius_difference_1eN-DrCz', kind: 'radius_difference', a: '$_yxEcYDVIUOLVgBH', b: '$43NO99KuPeLF1spx', value: 10, pos: [-23.039145, 43.560241] },
      { id: 'c_diameter_DbYzTFco', kind: 'diameter', target: '$_yxEcYDVIUOLVgBH', value: 30, pos: [38.985063, 21.546119] },
      { id: 'c_equal_length_NzFw9tv_', kind: 'equal_length', a: '$0IPnfibogdJZCeul', b: '$43NO99KuPeLF1spx' },
      { id: 'c_point_distance_x_xVCq_ty_', kind: 'point_distance_x', a: '$0IPnfibogdJZCeulcenter', b: '$43NO99KuPeLF1spxcenter', value: 30, pos: [-0.200235, -37.805783], sign: -1 },
      { id: 'c_horizontal_9masKtYp', kind: 'horizontal', a: '$0IPnfibogdJZCeulcenter', b: '$43NO99KuPeLF1spxcenter' },
    ],
    auto_hidden: true,
    visible: false,
  },
  {
    id: EX, kind: 'extrude', label: 'extrude 1',
    extrude: { sketch: [PROFILE], distance: 10, direction: 'normal' },
  },
]

// The literal stored picks of the four reports.
const BORE =
  `?15,19,1e,2a;@u|u_12fe4d96581d211f@${EX}@${BODY}@${SK}/_yxEcYDVIUOLVgBH:cylinderface`
const UPPER =
  `?15,19,1e,2a,7,7;@u|u_8fee0efaff178537@${EX}@${BODY}@${SK}/0IPnfibogdJZCeul@cls_xp@cls_yp:cylinderface`
// 0648's second move stores the first move's token in its ancestry.
const UPPER_AFTER_BORE =
  `?15,19,1e,2a,7,7;@u|u_8fee0efaff178537@kaq8NQBPIvFccTpLoxMfHDEV@${BODY}` +
  `@${SK}/0IPnfibogdJZCeul@cls_xp@cls_yp:cylinderface`
const LOWER =
  `?15,19,1e,2a,7,7;@u|u_ddc9b0766a2715e7@${EX}@${BODY}@${SK}/0IPnfibogdJZCeul@cls_xp@cls_yn:cylinderface`
const TOP_FLAT =
  `?15,19,1e,2a,2a,2a,2a,2a,2a,2a,2a,2a,2a,2a,2a,7;@u|u_d555c033af1edc8d@${EX}@${BODY}` +
  `@${SK}/0IPnfibogdJZCeul@${SK}/43NO99KuPeLF1spx@${SK}/_yxEcYDVIUOLVgBH` +
  `@${SK}/0IPnfibogdJZCeul@${SK}/43NO99KuPeLF1spx@${SK}/0IPnfibogdJZCeul` +
  `@${SK}/43NO99KuPeLF1spx@${SK}/_yxEcYDVIUOLVgBH@${SK}/0IPnfibogdJZCeul` +
  `@${SK}/_yxEcYDVIUOLVgBH@${SK}/0IPnfibogdJZCeul@${SK}/_yxEcYDVIUOLVgBH@cls_zp:flatface`

interface FaceDatum {
  surface_type?: string
  surface_frame?: { radius?: number }
  centroid?: number[]
}
interface BodyView {
  mesh?: { face_queries?: string[]; face_data?: FaceDatum[]; vertices?: number[][] }
}
interface Face {
  query: string
  data: FaceDatum
}

const uuidOf = (query: string): string | null => {
  const token = parseAncestry(query)[0].find((part) => part.startsWith('@u|'))
  return token === undefined ? null : token.slice(3)
}

function facesOf(body: BodyView): Face[] {
  const queries = body.mesh?.face_queries ?? []
  const data = body.mesh?.face_data ?? []
  return queries.map((query, index) => ({ query, data: data[index] ?? {} }))
}

function radiusByUuid(body: BodyView, uuid: string): number {
  const face = facesOf(body).find((f) => uuidOf(f.query) === uuid)
  const radius = face?.data.surface_frame?.radius
  if (radius === undefined) throw new Error(`no cylinder face for ${uuid}`)
  return radius
}

function bbox(verts: number[][]): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const v of verts) for (let i = 0; i < 3; i++) {
    min[i] = Math.min(min[i], v[i])
    max[i] = Math.max(max[i], v[i])
  }
  return { min, max }
}

function resultOf(result: BuildResponse, id: string): Record<string, unknown> {
  return (result.result as Record<string, Record<string, unknown>>)[id] ?? {}
}
function bodyOf(result: BuildResponse): BodyView {
  return ((result.bodies as Record<string, BodyView>)[BODY] ?? {})
}

describe.skipIf(!oc || !solveBytes)('move face corner and split-sibling reports (real OCC)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  /** Volume of the body the last feature built, read from its checkpoint shape
   *  (the build response only carries the mesh). */
  function volumeAfter(result: BuildResponse, lastId: string): number {
    const handle = result._build_state.checkpoints[lastId]?.body_store_snapshot?.[BODY]?.shape
    if (!handle) throw new Error(`no checkpoint shape for ${lastId}`)
    const scope = new DisposeScope()
    try {
      return volumeOf(oc!, scope, h.table.get<OccShape>(handle))
    } finally {
      scope.dispose()
    }
  }

  it('0648: the bore then the upper arc applies cleanly', () => {
    const r = h.run({
      features: [
        ...BASE_FEATURES,
        {
          id: 'kaq8NQBPIvFccTpLoxMfHDEV', kind: 'move_face', label: 'move_face 2',
          move_face: { faces: [BORE], distance: 5 },
        },
        {
          id: '3mVx0XBPxQbI51eD-BLbrEhA', kind: 'move_face', label: 'move_face 2',
          move_face: { faces: [UPPER_AFTER_BORE], distance: 2 },
        },
      ],
    })
    expect(resultOf(r, 'kaq8NQBPIvFccTpLoxMfHDEV').status).toBe('ok')
    expect(resultOf(r, '3mVx0XBPxQbI51eD-BLbrEhA').status).toBe('ok')

    const body = bodyOf(r)
    const faces = facesOf(body)
    expect(faces).toHaveLength(6)
    expect(radiusByUuid(body, 'u_12fe4d96581d211f')).toBeCloseTo(10, 6)
    expect(radiusByUuid(body, 'u_8fee0efaff178537')).toBeCloseTo(23, 6)
    expect(radiusByUuid(body, 'u_ddc9b0766a2715e7')).toBeCloseTo(25, 6)
    const uuids = faces.map((f) => uuidOf(f.query)).filter((u): u is string => u !== null)
    expect(new Set(uuids).size).toBe(uuids.length)
    expect(volumeAfter(r, '3mVx0XBPxQbI51eD-BLbrEhA')).toBeCloseTo(11747.93, 1)
  }, 120000)

  it('0650: two corners move together with no leftover bite or bore pieces', () => {
    const r = h.run({
      features: [
        ...BASE_FEATURES,
        {
          id: 'kaq8NQBPIvFccTpLoxMfHDEV', kind: 'move_face', label: 'move_face 2',
          move_face: { faces: [BORE, UPPER, LOWER], distance: 5 },
        },
      ],
    })
    expect(resultOf(r, 'kaq8NQBPIvFccTpLoxMfHDEV').status).toBe('ok')
    expect(resultOf(r, 'kaq8NQBPIvFccTpLoxMfHDEV').body_ids).toHaveLength(1)

    const body = bodyOf(r)
    const faces = facesOf(body)
    // The old corner strips were r25 bite pieces and r15 relics; the moved bite
    // is r20 everywhere and the bore is r10.
    const bite = faces.filter((f) => f.data.surface_type === 'cylinderface' && f.query.includes('0IPnfibogdJZCeul'))
    expect(bite).toHaveLength(2)
    for (const f of bite) expect(f.data.surface_frame?.radius).toBeCloseTo(20, 5)
    expect(faces.some((f) => f.data.surface_frame?.radius !== undefined && Math.abs(f.data.surface_frame.radius - 15) < 1e-4)).toBe(false)
    const uuids = faces.map((f) => uuidOf(f.query)).filter((u): u is string => u !== null)
    expect(new Set(uuids).size).toBe(uuids.length)
    expect(faces).toHaveLength(7)
    expect(volumeAfter(r, 'kaq8NQBPIvFccTpLoxMfHDEV')).toBeCloseTo(13043.5, 1)
  }, 180000)

  it('0651: the bore and upper arc move cleanly, the lower arc stays', () => {
    const r = h.run({
      features: [
        ...BASE_FEATURES,
        {
          id: 'kaq8NQBPIvFccTpLoxMfHDEV', kind: 'move_face', label: 'move_face 2',
          move_face: { faces: [BORE, UPPER], distance: 5 },
        },
      ],
    })
    expect(resultOf(r, 'kaq8NQBPIvFccTpLoxMfHDEV').status).toBe('ok')

    const body = bodyOf(r)
    const faces = facesOf(body)
    expect(faces).toHaveLength(6)
    const bite = faces.filter((f) => f.data.surface_type === 'cylinderface' && f.query.includes('0IPnfibogdJZCeul'))
    const upper = bite.find((f) => (f.data.centroid?.[1] ?? 0) > 0)
    const lower = bite.find((f) => (f.data.centroid?.[1] ?? 0) < 0)
    expect(upper?.data.surface_frame?.radius).toBeCloseTo(20, 5)
    expect(lower?.data.surface_frame?.radius).toBeCloseTo(25, 5)
    expect(radiusByUuid(body, 'u_12fe4d96581d211f')).toBeCloseTo(10, 6)
    expect(faces.some((f) => f.data.surface_frame?.radius !== undefined && Math.abs(f.data.surface_frame.radius - 15) < 1e-4)).toBe(false)
    const uuids = faces.map((f) => uuidOf(f.query)).filter((u): u is string => u !== null)
    expect(new Set(uuids).size).toBe(uuids.length)
    expect(volumeAfter(r, 'kaq8NQBPIvFccTpLoxMfHDEV')).toBeCloseTo(12242.1, 1)
  }, 180000)

  it('0654: the reported pick order and its reverse finish with the same result', async () => {
    const document = (faces: string[]): Record<string, unknown> => ({
      features: [
        ...BASE_FEATURES,
        {
          id: 'ng546yyywJO-kJj-PfZe_1Q4', kind: 'move_face', label: 'move_face 2',
          move_face: { faces, distance: 5 },
        },
      ],
    })
    // A bounded child, because the pre-fix build spins forever inside the
    // combined boolean and no in-process test timeout can interrupt WASM.
    const runOrder = async (faces: string[]): Promise<{ result: BuildResponse; ms: number }> => {
      const t0 = performance.now()
      const result = await solveWithTimeout(document(faces), undefined, 30000)
      if (result === null) throw new Error('OCC.js is unavailable')
      return { result, ms: performance.now() - t0 }
    }
    const reported = await runOrder([BORE, TOP_FLAT, UPPER])
    const reverse = await runOrder([UPPER, TOP_FLAT, BORE])
    expect(resultOf(reported.result, 'ng546yyywJO-kJj-PfZe_1Q4').status).toBe('ok')
    expect(resultOf(reverse.result, 'ng546yyywJO-kJj-PfZe_1Q4').status).toBe('ok')
    expect(reported.ms).toBeLessThan(30000)
    expect(reverse.ms).toBeLessThan(30000)

    const signature = (result: BuildResponse): string[] =>
      facesOf(bodyOf(result))
        .map((f) => `${f.data.surface_type}:${(f.data.surface_frame?.radius ?? 0).toFixed(4)}:${(f.data.centroid ?? []).map((x) => x.toFixed(3)).join(',')}`)
        .sort()
    expect(signature(reported.result)).toEqual(signature(reverse.result))
    expect(signature(reported.result)).toHaveLength(6)

    const body = bodyOf(reported.result)
    const radii = facesOf(body).map((f) => f.data.surface_frame?.radius).filter((x): x is number => x !== undefined)
    expect(radii.filter((r) => Math.abs(r - 20) < 1e-4)).toHaveLength(1)
    expect(radii.filter((r) => Math.abs(r - 10) < 1e-4)).toHaveLength(1)
    expect(radii.filter((r) => Math.abs(r - 25) < 1e-4)).toHaveLength(2)
    // The top face moved from z=10 to z=15.
    const box = bbox(body.mesh?.vertices ?? [])
    expect(box.min[2]).toBeCloseTo(0, 6)
    expect(box.max[2]).toBeCloseTo(15, 6)
  }, 90000)
})

afterAll(() => {
  disposeWorker()
})
