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
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { solveWithTimeout, disposeWorker } from '../../solveTimeout'
import type { BuildResponse } from '../../builder'

const oc = await loadOcc()
const solveBytes = loadSolver()

const SK = 'ej5yKuzkrjyx1bIum42EJLki'
const EX = 'UU4SAjHG0AQZAsU8C2j5JKjo'
const PART = `body_${EX}`
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
    extrude: { sketch: [PROFILE], distance: 10, direction: 'normal', operation: 'new' },
  },
]

// The literal stored picks of the four reports.
const BORE =
  `?15,19,1e,2a;@u|u_12fe4d96581d211f@${EX}@${PART}@${SK}/_yxEcYDVIUOLVgBH:cylinderface`
const UPPER =
  `?15,19,1e,2a,7,7;@u|u_8fee0efaff178537@${EX}@${PART}@${SK}/0IPnfibogdJZCeul@cls_xp@cls_yp:cylinderface`
// 0648's second move stores the first move's token in its ancestry.
const UPPER_AFTER_BORE =
  `?15,19,1e,2a,7,7;@u|u_8fee0efaff178537@kaq8NQBPIvFccTpLoxMfHDEV@${PART}` +
  `@${SK}/0IPnfibogdJZCeul@cls_xp@cls_yp:cylinderface`
const LOWER =
  `?15,19,1e,2a,7,7;@u|u_ddc9b0766a2715e7@${EX}@${PART}@${SK}/0IPnfibogdJZCeul@cls_xp@cls_yn:cylinderface`
const TOP_FLAT =
  `?15,19,1e,2a,2a,2a,7;@u|u_9c1f24e62f9dae31@${EX}@${PART}` +
  `@${SK}/0IPnfibogdJZCeul@${SK}/43NO99KuPeLF1spx@${SK}/_yxEcYDVIUOLVgBH@cls_zp:flatface`

function resultOf(result: BuildResponse, id: string): Record<string, unknown> {
  return (result.result as Record<string, Record<string, unknown>>)[id] ?? {}
}

describe.skipIf(!oc || !solveBytes)('move face corner and split-sibling reports (real OCC)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  // The 2026-10-20 family all has a boolean-split body (the r25 bite is two
  // arcs, the bore crosses it). The direct tweak refuses the move by name: a
  // split network needs a new step face between the moved and staying halves,
  // and the hand-built shell of a multi-arc body is where its rebuild traps.
  // The old slab route built these by minting `|extend|` faces; re-testing the
  // family on the direct route is a backlog item, not a silent fallback.
  const expectSplitRefusal = (r: BuildResponse, id: string): void => {
    const result = resultOf(r, id)
    expect(result.status, String(result.exception ?? '')).toBe('partial')
    expect((result.failed_faces as string[] | undefined) ?? []).not.toHaveLength(0)
    expect(String(result.exception ?? '')).toContain('two faces on one surface')
  }

  it('0648: the bore then the upper arc is refused by name', () => {
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
    expectSplitRefusal(r, 'kaq8NQBPIvFccTpLoxMfHDEV')
    // The second feature builds on the refused (unchanged) body and is refused
    // by the same body-level split guard.
    expect(resultOf(r, '3mVx0XBPxQbI51eD-BLbrEhA').status).toBe('partial')
  }, 120000)

  it('0650: two corners together are refused by name', () => {
    const r = h.run({
      features: [
        ...BASE_FEATURES,
        {
          id: 'kaq8NQBPIvFccTpLoxMfHDEV', kind: 'move_face', label: 'move_face 2',
          move_face: { faces: [BORE, UPPER, LOWER], distance: 5 },
        },
      ],
    })
    expectSplitRefusal(r, 'kaq8NQBPIvFccTpLoxMfHDEV')
  }, 180000)

  it('0651: the bore and upper arc are refused by name', () => {
    const r = h.run({
      features: [
        ...BASE_FEATURES,
        {
          id: 'kaq8NQBPIvFccTpLoxMfHDEV', kind: 'move_face', label: 'move_face 2',
          move_face: { faces: [BORE, UPPER], distance: 5 },
        },
      ],
    })
    expectSplitRefusal(r, 'kaq8NQBPIvFccTpLoxMfHDEV')
  }, 180000)

  it('0654: the reported pick order and its reverse are refused by name', async () => {
    const document = (faces: string[]): Record<string, unknown> => ({
      features: [
        ...BASE_FEATURES,
        {
          id: 'ng546yyywJO-kJj-PfZe_1Q4', kind: 'move_face', label: 'move_face 2',
          move_face: { faces, distance: 5 },
        },
      ],
    })
    const runOrder = async (faces: string[]): Promise<BuildResponse> => {
      const result = await solveWithTimeout(document(faces), undefined, 30000)
      if (result === null) throw new Error('OCC.js is unavailable')
      return result
    }
    const reported = await runOrder([BORE, TOP_FLAT, UPPER])
    const reverse = await runOrder([UPPER, TOP_FLAT, BORE])
    expectSplitRefusal(reported, 'ng546yyywJO-kJj-PfZe_1Q4')
    expectSplitRefusal(reverse, 'ng546yyywJO-kJj-PfZe_1Q4')
  }, 90000)
})

afterAll(() => {
  disposeWorker()
})
