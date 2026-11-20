// @vitest-environment node
//
// The stud_wall practice run (bugreports/mcp-practice, F3) rebuilt inline: the
// rounded 38.1 x 88.9 section in the plate and stud lengths, the recorded sole
// plate and one stud, and the recorded fixed mate. The run's saved assembly
// named `plate` and `stud`, so a partial import left both doc_ids dangling and
// the document could not be opened.
//
// The repair is two `set_part_doc` steps after the doc_ids are deliberately
// unbound; the solve must reproduce the bound assembly's geometry, not merely
// place the parts at their seeds. The last cases are the mate rules the
// mutation does not rewrite: the ref rows are by handle, so the solver's anchor
// id and descriptor fallback decide whether the mate survives.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { setSolveLocalsForTest } from '@/kernel/solveLocally'
import { setSketchSolver, resetSketchSolver } from '@/kernel/features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadPkgNodeExport, PKG_MATE } from '@/wasm-kernel/loadPkgNode'
import type { AssemblyDoc, PartDoc } from '@/types/cad'
import { docHashOf } from '@/drive/docHash'
import { setMateSolver, type AssemblyScriptStep } from '../headlessAssembly'
import { measureAssemblyHeadless, runAssemblyHeadless } from '../headlessOps'

const oc = await loadOcc()
const solveBytes = loadSolver()
const solveMate = loadPkgNodeExport<(input: Uint8Array) => Uint8Array>('solve_mate_bytes', PKG_MATE)
const describeReal = oc && solveBytes && solveMate ? describe : describe.skip

const PLATE_LENGTH = 1219.2
const STUD_LENGTH = 2362.2
// The stud wall's rounded rectangle: 38.1 x 88.9 with a 6.35 corner radius.
const SECTION_AREA = 38.1 * 88.9 - (4 - Math.PI) * 6.35 ** 2

// The recorded Section sketch, verbatim: four tangent 6.35 arcs on a 38.1 x
// 88.9 rectangle, centre pinned to the projected origin.
const SECTION_SKETCH = {
  id: 'sk', kind: 'sketch' as const, label: 'Section', plane: '@builtin_plane_top',
  entities: [
    { id: 'o', kind: 'point' }, { id: 'rb', kind: 'line' }, { id: 'rr', kind: 'line' },
    { id: 'rt', kind: 'line' }, { id: 'rl', kind: 'line' }, { id: 'rc', kind: 'point' },
    { id: 'q7H6heixr1aflUey', kind: 'arc' }, { id: 'MsaavW-xjT99Pdj9', kind: 'arc' },
    { id: 'xuypUItcAjj7EL1M', kind: 'arc' }, { id: 'ATvDS1Hs6xmGmRR6', kind: 'arc' },
  ],
  constraints: [
    { id: 'proj_o', kind: 'projection', target: '$o', source: '@builtin_origin' },
    { id: 'c_equal_length_GsEbuEyY', kind: 'equal_length', a: '$rb', b: '$rt' },
    { id: 'c_equal_length_pxcMDNA8', kind: 'equal_length', a: '$rr', b: '$rl' },
    { id: 'c_horizontal_iZwvZwWM', kind: 'horizontal', target: '$rb' },
    { id: 'c_vertical_txP9W-Fp', kind: 'vertical', target: '$rr' },
    { id: 'c_midpoint_3iGuJjrt', kind: 'midpoint', point_a: '$rbstart', point_b: '$rtstart', point: '$rcxy' },
    { id: 'c_coincident_nqhgYomL', kind: 'coincident', a: '$rcxy', b: '$oxy' },
    { id: 'c_coincident_6IKRVpxA', kind: 'coincident', a: '$rbend', b: '$q7H6heixr1aflUeystart' },
    { id: 'c_coincident_t503Pg5k', kind: 'coincident', a: '$q7H6heixr1aflUeyend', b: '$rrstart' },
    { id: 'c_tangent_yDhTFRvS', kind: 'tangent', a: '$rb', b: '$q7H6heixr1aflUey' },
    { id: 'c_tangent_WsmduOzD', kind: 'tangent', a: '$q7H6heixr1aflUey', b: '$rr' },
    { id: 'c_radius_gMn7Ax8_', kind: 'radius', target: '$q7H6heixr1aflUey', value: 6.35 },
    { id: 'c_coincident_UJP4kZBe', kind: 'coincident', a: '$rrend', b: '$MsaavW-xjT99Pdj9start' },
    { id: 'c_coincident_gU4laJBr', kind: 'coincident', a: '$MsaavW-xjT99Pdj9end', b: '$rtstart' },
    { id: 'c_tangent_nIZon6qE', kind: 'tangent', a: '$rr', b: '$MsaavW-xjT99Pdj9' },
    { id: 'c_tangent_1m554d7S', kind: 'tangent', a: '$MsaavW-xjT99Pdj9', b: '$rt' },
    { id: 'c_radius_37lB2Eq_', kind: 'radius', target: '$MsaavW-xjT99Pdj9', value: 6.35 },
    { id: 'c_coincident_Bpz7h6iI', kind: 'coincident', a: '$rtend', b: '$xuypUItcAjj7EL1Mstart' },
    { id: 'c_coincident_CpwHYL1Y', kind: 'coincident', a: '$xuypUItcAjj7EL1Mend', b: '$rlstart' },
    { id: 'c_tangent_izBlTxsX', kind: 'tangent', a: '$rt', b: '$xuypUItcAjj7EL1M' },
    { id: 'c_tangent_Zoxl7dcS', kind: 'tangent', a: '$xuypUItcAjj7EL1M', b: '$rl' },
    { id: 'c_radius_1jk7pnAJ', kind: 'radius', target: '$xuypUItcAjj7EL1M', value: 6.35 },
    { id: 'c_coincident_-3hctc-K', kind: 'coincident', a: '$rlend', b: '$ATvDS1Hs6xmGmRR6start' },
    { id: 'c_coincident_R0LaNzqp', kind: 'coincident', a: '$ATvDS1Hs6xmGmRR6end', b: '$rbstart' },
    { id: 'c_tangent_k0qRO7QH', kind: 'tangent', a: '$rl', b: '$ATvDS1Hs6xmGmRR6' },
    { id: 'c_tangent_0f7qjaZ4', kind: 'tangent', a: '$ATvDS1Hs6xmGmRR6', b: '$rb' },
    { id: 'c_radius_fRXfYM2M', kind: 'radius', target: '$ATvDS1Hs6xmGmRR6', value: 6.35 },
    { id: 'c_line_distance_vajQt07I', kind: 'line_distance', a: '$rr', b: '$rlstart', value: 38.1, sign: 1 },
    { id: 'c_line_distance_G4W3QEK3', kind: 'line_distance', a: '$rb', b: '$rtstart', value: 88.9, sign: 1 },
    { id: 'c_horizontal_FcMSfTeD', kind: 'horizontal', target: '$rt' },
    { id: 'c_vertical_D5YVbfuT', kind: 'vertical', target: '$rl' },
  ],
  initial: {
    o: [0, 0],
    rb: [-12.7, -44.45, 12.7, -44.45], rr: [19.05, -38.1, 19.05, 38.1],
    rt: [12.7, 44.45, -12.7, 44.45], rl: [-19.05, 38.1, -19.05, -38.1], rc: [0, 0],
    q7H6heixr1aflUey: [12.7, -38.1, 6.35, 270, 360],
    'MsaavW-xjT99Pdj9': [12.7, 38.1, 6.35, 0, 90],
    xuypUItcAjj7EL1M: [-12.7, 38.1, 6.35, 90, 180],
    ATvDS1Hs6xmGmRR6: [-12.7, -38.1, 6.35, 180, 270],
  },
}

function section(length: number, extrudeId = 'ex'): PartDoc {
  return {
    version: 7, kind: 'part',
    features: [
      { id: 'Origin', kind: 'origin' },
      { id: 'Top', kind: 'plane', visible: false },
      { id: 'Front', kind: 'plane', visible: false },
      { id: 'Right', kind: 'plane', visible: false },
      SECTION_SKETCH,
      { id: extrudeId, kind: 'extrude', label: 'Extrude', extrude: { sketch: ['$sk'], distance: length, direction: 'normal', operation: 'new' } },
    ],
  } as unknown as PartDoc
}

const PARTS = new Map<string, PartDoc>([
  ['plate', section(PLATE_LENGTH)],
  ['stud', section(STUD_LENGTH)],
])

// The recorded assembly, cut to its sole plate, first stud and first mate. The
// stored anchor descriptors are kept: they are what a real document carries.
const STUD_WALL: AssemblyDoc = {
  version: 7, kind: 'assembly',
  features: [
    {
      id: 'inst_sole', kind: 'part_instance',
      instance: {
        handle: 'sole', doc_id: 'plate', doc_rev: 0, visible: true, fixed: true,
        transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: -0.7071067811865475, qw: 0.7071067811865476 },
      },
    },
    {
      id: 'inst_s0', kind: 'part_instance',
      instance: {
        handle: 's0', doc_id: 'stud', doc_rev: 0, visible: true,
        transform: { tx: 19.05, ty: 19.05, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
      },
    },
    {
      id: 'm_s0', kind: 'mate',
      mate: {
        kind: 'fixed', label: 'Fixed 1',
        ref_a: {
          part: 'sole', anchor: 'a_a9a731f4ff48e749',
          anchor_descriptor: {
            geom_hash: '@u|u_bb45152908c5e59d', kind: 'plane', created_by: 'ex',
            point: [-19.049999999999997, 609.6, 5.440092820663267e-15],
          },
        },
        ref_b: {
          part: 's0', anchor: 'a_701e2b1d8bfb8511',
          anchor_descriptor: {
            geom_hash: '@u|u_2212259b6ef6e6aa', kind: 'plane', created_by: 'ex',
            point: [-3.4559767292579276e-16, 0, -9.131065399428788e-16],
          },
        },
        flip: true, angle: 180, offset: { x: 0, y: -590.55, z: 0 },
      },
    },
  ],
}

const REBIND: AssemblyScriptStep[] = [
  { mutation: { type: 'set_part_doc', handle: 'sole', part: 'plate' } },
  { mutation: { type: 'set_part_doc', handle: 's0', part: 'stud' } },
]

// The document a partial import leaves behind: every doc_id names a part the
// workspace does not hold. The handles, poses and mate are intact.
function unbound(doc: AssemblyDoc): AssemblyDoc {
  return {
    ...doc,
    features: (doc.features ?? []).map(feature => (
      feature.kind === 'part_instance' && feature.instance
        ? { ...feature, instance: { ...feature.instance, doc_id: `missing-${feature.instance.handle}` } }
        : feature
    )),
  }
}

describeReal('rebinding the stud_wall instances to their part documents', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes!)
    setSolveLocalsForTest(async () => oc)
    setMateSolver(solveMate)
  })
  afterAll(() => {
    setMateSolver(null)
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('two set_part_doc steps restore the unbound wall to its solved geometry', async () => {
    const built = await runAssemblyHeadless({ doc: STUD_WALL, parts: PARTS, steps: [] })
    expect(built.ok, JSON.stringify(built.mates)).toBe(true)
    expect(built.mates).toEqual([])
    expect(built.solve.verdict).toBe('fully_constrained')
    const reference = (await measureAssemblyHeadless(built.doc, PARTS))!
    // The reference really is the stud wall's two rounded sections.
    expect(reference.measures.volume).toBeCloseTo(SECTION_AREA * (PLATE_LENGTH + STUD_LENGTH), 0)

    const rebound = await runAssemblyHeadless({
      doc: unbound(built.doc),
      parts: PARTS,
      steps: REBIND,
    })
    expect(rebound.ok, JSON.stringify(rebound.mates)).toBe(true)
    expect(rebound.mates).toEqual([])
    expect(rebound.solve.verdict).toBe('fully_constrained')
    expect(rebound.instances.find(i => i.handle === 'sole')!.part).toBe('plate')
    expect(rebound.instances.find(i => i.handle === 's0')!.part).toBe('stud')

    const measured = (await measureAssemblyHeadless(rebound.doc, PARTS))!
    expect(measured.measures.volume).toBeCloseTo(reference.measures.volume, 3)
    const bbox = measured.measures.bbox
    const referenceBbox = reference.measures.bbox
    expect(bbox).not.toBeNull()
    expect(referenceBbox).not.toBeNull()
    bbox!.forEach((value, index) => {
      expect(value).toBeCloseTo(referenceBbox![index], 3)
    })

    // The same repair script twice is the same document: a replay of the run
    // cannot drift on the bind it performed.
    const replay = await runAssemblyHeadless({
      doc: unbound(built.doc),
      parts: PARTS,
      steps: REBIND,
    })
    expect(docHashOf(replay.doc)).toBe(docHashOf(rebound.doc))
    expect(replay.instances).toEqual(rebound.instances)
  }, 300_000)

  it('keeps the mate fully constrained when the new part has the same geometry', async () => {
    const aliases = new Map<string, PartDoc>([
      ['plate_copy', section(PLATE_LENGTH)],
      ['stud_copy', section(STUD_LENGTH)],
    ])
    const rebound = await runAssemblyHeadless({
      doc: STUD_WALL,
      parts: aliases,
      steps: [
        { mutation: { type: 'set_part_doc', handle: 'sole', part: 'plate_copy' } },
        { mutation: { type: 'set_part_doc', handle: 's0', part: 'stud_copy' } },
      ],
    })
    expect(rebound.ok, JSON.stringify(rebound.mates)).toBe(true)
    expect(rebound.mates).toEqual([])
    expect(rebound.solve.verdict).toBe('fully_constrained')
  }, 300_000)

  it('reports the mate stale when the new part cannot carry its anchor', async () => {
    // A different part document brings its own anchors: another anchor id and
    // another creation bucket (the feature that built the body), so neither the
    // stored id nor its descriptor can re-find the old element and the mate goes
    // stale. That is the same rule a user meets after swapping in another part.
    const other = new Map<string, PartDoc>([
      ['plate', section(PLATE_LENGTH)],
      ['plate_other', section(PLATE_LENGTH, 'ex_other')],
    ])
    const rebound = await runAssemblyHeadless({
      doc: STUD_WALL,
      parts: other,
      steps: [{ mutation: { type: 'set_part_doc', handle: 's0', part: 'plate_other' } }],
    })
    expect(rebound.mates).toContainEqual(expect.objectContaining({
      id: 'm_s0',
      status: 'stale',
      staleRefs: ['ref_b'],
    }))
    expect(rebound.solve.verdict).not.toBe('fully_constrained')
    // The ref row still names the instance: the rebind rewrote no mate.
    const mate = rebound.doc.features!.find(f => f.id === 'm_s0')!.mate!
    expect(mate.ref_b.part).toBe('s0')
    expect(mate.ref_b.anchor).toBe(STUD_WALL.features!.find(f => f.id === 'm_s0')!.mate!.ref_b.anchor)
  }, 300_000)
})
