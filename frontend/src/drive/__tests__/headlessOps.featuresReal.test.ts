// @vitest-environment node
//
// The reply fields the CLI and MCP server share: the features a solve did not
// finish cleanly, the empty-script "inspect this document" solve, and the
// measure reply carrying the same list. Real kernel, gated like the other
// drive real suites.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { runHeadless, measureHeadless, seedBuiltins } from '../headlessOps'
import { DocHandleStore } from '../docHandleStore'
import { runReply } from '../mcpDocRef'
import { MUTATION_EXAMPLES } from '../mutationExamples'
import { HOLE_ALL_SITES_MISS, HOLE_ON_LINE_SKETCH } from './featureFixtures'
import { nonSketchProblems } from './buildProblems'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'

function occInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('opencascade.js/dist/opencascade.wasm.js')
    return true
  } catch {
    return false
  }
}

const oc = occInstalled()
const solveBytes = loadSolver()
if (oc && solveBytes) {
  setOccLoader(loadOcc)
  setSketchSolver(solveBytes)
  setSketchTopology(loadTopology())
}

function emptyDoc(): PartDoc {
  return seedBuiltins({ version: 1, kind: 'part', features: [] } as PartDoc)
}

const ready = oc && solveBytes

describe.skipIf(!ready)('headless feature problems (real OCC + Rust solver)', () => {
  it('reports an empty list for a clean box whose sketch is fully constrained', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const result = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(result.ok).toBe(true)
    expect(nonSketchProblems(result.features)).toEqual([])
    // The example obeys the sketch constraint law: dimensioned and anchored,
    // so there is no underconstrained warning row to explain away.
    expect(result.part.solveOutcomes().sk1?.status).toBe('fully_constrained')
    expect(result.part.solveOutcomes().sk1?.dof).toBe(0)
  }, 120_000)

  it('keeps an automatic cut that eats a split lump out of the problems list', async () => {
    // The example008 practice shape in miniature: a plate, a slot that severs
    // it into two lumps, then an automatic cut whose footprint reaches only the
    // small lump and swallows it. The model is right -- the cut was sized from
    // the part, not aimed at a body -- so the reply must read clean, not carry
    // "the cut removed all of body ..." forever. The three sketches are fully
    // constrained (anchored and dimensioned) so no sketch row joins the list.
    const result = await runHeadless({
      doc: emptyDoc(),
      steps: [
        { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_top' } },
        {
          mutation: {
            type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [40, 30],
            p0Ref: '@builtin_origin', dimensions: true,
          },
        },
        { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10, operation: 'new' } },
        // Slot across the plate at x 30..32: a 30 mm lump and an 8 mm one.
        { mutation: { type: 'add_sketch', featureId: 'sk2', plane: '@builtin_plane_top' } },
        {
          mutation: {
            type: 'add_rect', featureId: 'sk2', p0: [30, 0], p1: [32, 30],
            entityIds: ['slot_b', 'slot_r', 'slot_t', 'slot_l'], dimensions: true,
          },
        },
        {
          mutation: {
            type: 'add_constraint', featureId: 'sk2', kind: 'point_distance_x',
            targets: ['vertex:sk2:slot_b:start', '@builtin_origin'], value: 30, sign: -1,
          },
        },
        {
          mutation: {
            type: 'add_constraint', featureId: 'sk2', kind: 'point_distance_y',
            targets: ['vertex:sk2:slot_b:start', '@builtin_origin'], value: 0, sign: -1,
          },
        },
        {
          mutation: {
            type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk2', distance: 20,
            operation: 'cut', direction: 'symmetric',
          },
        },
        // Reach only the small lump (x 32..40) and enclose it: the symmetric
        // span also covers the plate's 10 mm thickness on both sides.
        { mutation: { type: 'add_sketch', featureId: 'sk3', plane: '@builtin_plane_top' } },
        {
          mutation: {
            type: 'add_rect', featureId: 'sk3', p0: [31, 0], p1: [41, 30],
            entityIds: ['eat_b', 'eat_r', 'eat_t', 'eat_l'], dimensions: true,
          },
        },
        {
          mutation: {
            type: 'add_constraint', featureId: 'sk3', kind: 'point_distance_x',
            targets: ['vertex:sk3:eat_b:start', '@builtin_origin'], value: 31, sign: -1,
          },
        },
        {
          mutation: {
            type: 'add_constraint', featureId: 'sk3', kind: 'point_distance_y',
            targets: ['vertex:sk3:eat_b:start', '@builtin_origin'], value: 0, sign: -1,
          },
        },
        {
          mutation: {
            type: 'add_extrude', featureId: 'ex3', sketchQuery: '$sk3', distance: 20,
            operation: 'cut', direction: 'symmetric',
          },
        },
      ],
    })
    expect(result.ok).toBe(true)
    // The small lump is gone and the big one survives.
    expect(result.bodies).toHaveLength(1)
    expect(result.features).toEqual([])
    expect(result.part.solveOutcomes().ex3?.warning).toBeUndefined()
    // The summary a one-line client reads has nothing to act on either.
    const reply = runReply(result, false, new DocHandleStore())
    expect(String(reply.summary)).not.toContain('problems:')
  }, 120_000)

  it('lists an underconstrained sketch as a warning row without flipping ok', async () => {
    // A free rectangle has 4 DOF; it is the law's yellow case, not a failure.
    const free: PartDoc = seedBuiltins({
      version: 1,
      kind: 'part',
      features: [
        { id: 'sk1', kind: 'sketch', label: 'Free', plane: '@builtin_plane_front' },
      ],
    } as PartDoc)
    const result = await runHeadless({
      doc: free,
      steps: [{ mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [40, 30] } }],
    })
    expect(result.ok).toBe(true)
    const problem = result.features.find(feature => feature.id === 'sk1')
    expect(problem).toMatchObject({ kind: 'sketch', status: 'underconstrained' })
    expect(problem!.message).toMatch(/^Underconstrained: 4 degrees of freedom\. Free: /)
    const row = result.featureDeltas?.find(delta => delta.id === 'sk1')
    expect(row?.dof).toBe(4)
  }, 120_000)

  it('lists a touched fully constrained sketch even when its checkpoint did not move', async () => {
    // The sketch-protection probe: project the origin into an already
    // constrained box sketch. Nothing the checkpoint measures moves, so the
    // zero rule dropped the row and the reply said nothing about the sketch.
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    const result = await runHeadless({
      doc: built.doc!,
      steps: [{
        mutation: {
          type: 'add_projected_entity', featureId: 'sk1', kind: 'point',
          source: '@builtin_origin', entityId: 'origin_proj',
        },
      }],
    })
    expect(result.ok).toBe(true)
    const row = result.featureDeltas?.find(delta => delta.id === 'sk1')
    expect(row).toMatchObject({
      id: 'sk1', status: 'fully_constrained', dof: 0, volumeDelta: 0,
    })
  }, 120_000)

  it('lists a failed hole with its kernel message and does not flip ok', async () => {
    const result = await runHeadless({ doc: emptyDoc(), steps: HOLE_ON_LINE_SKETCH })
    expect(result.ok).toBe(true)
    expect(result.solve.lastError).toBeNull()
    expect(result.features).toHaveLength(1)
    expect(result.features[0]).toMatchObject({ id: 'h1', kind: 'hole', status: 'exception' })
    expect(result.features[0].message).toMatch(/has no point/)
  }, 120_000)

  it('lists an ok-with-warning hole and keeps the warning text', async () => {
    const result = await runHeadless({ doc: emptyDoc(), steps: HOLE_ALL_SITES_MISS })
    expect(result.ok).toBe(true)
    expect(result.features).toHaveLength(1)
    expect(result.features[0]).toMatchObject({ id: 'h1', kind: 'hole', status: 'ok' })
    expect(result.features[0].message).toMatch(/none of the 1 drill site\(s\) intersect/)
  }, 120_000)

  it('keeps a dependent extrude after its sketch is deleted and names the missing input', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const result = await runHeadless({
      doc: emptyDoc(),
      steps: [...box.steps, { mutation: { type: 'delete_feature', featureId: 'sk1' } }],
    })
    // delete_feature removes the named row only; the dependent stays and fails.
    expect(result.doc?.features?.map(feature => feature.id)).not.toContain('sk1')
    expect(result.doc?.features?.map(feature => feature.id)).toContain('ex1')
    const problem = result.features.find(feature => feature.id === 'ex1')
    expect(problem).toBeDefined()
    expect(problem!.message).toContain('sketch not found: sk1')
  }, 120_000)

  it('builds a through_all hole with no stored depth and cuts all the way through', async () => {
    const result = await runHeadless({
      doc: emptyDoc(),
      steps: [
        { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
        { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] } },
        { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10, operation: 'new' } },
        { mutation: { type: 'add_sketch', featureId: 'sk2', plane: '@builtin_plane_front' } },
        { mutation: { type: 'add_entity', featureId: 'sk2', kind: 'point', params: [5, 5], entityId: 'p1' } },
        { mutation: { type: 'add_hole', featureId: 'h1', sketch: '@sk2', diameter: 4, depth_mode: 'through_all' } },
      ],
    })
    expect(result.ok).toBe(true)
    expect(nonSketchProblems(result.features)).toEqual([])
    const hole = result.doc?.features?.find(feature => feature.id === 'h1')
    if (hole?.kind !== 'hole') throw new Error('unreachable')
    expect(hole.hole).not.toHaveProperty('depth')
    // The Front plane's normal points into the box, so the resolved side is
    // the authored one, and the reply says which way the hole went.
    expect(result.featureDeltas?.find(row => row.id === 'h1')?.direction).toBe('normal')
    const measured = await measureHeadless(result.doc!)
    expect(measured).not.toBeNull()
    // 10x10x10 box minus a 4 mm bore through the 10 mm height.
    expect(measured!.measures.volume).toBeCloseTo(1000 - Math.PI * 2 * 2 * 10, 2)
  }, 120_000)

  it('names a variable defined later and builds after reorder_features moves it up', async () => {
    // Build the box first, then author the forward reference directly: a fresh
    // full solve is what has to report the forward reference, while an
    // incremental solve that never re-reaches ex1 would keep its old result.
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const base = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    const doc = base.doc!
    const ex1 = doc.features!.find(feature => feature.id === 'ex1')
    if (ex1?.kind !== 'extrude') throw new Error('unreachable')
    ex1.extrude.distance = 'width+50'
    doc.features!.push({
      id: 'width', kind: 'variable', label: 'width', variable: { expression: '100' },
    })

    const built = await runHeadless({ doc, docId: 'forward-ref', steps: [] })
    const forward = built.features.find(feature => feature.id === 'ex1')
    expect(forward).toBeDefined()
    expect(forward!.message).toBe(
      "distance: variable 'width' is defined after this feature (at index 2); "
      + 'move it up with reorder_features',
    )

    // The solver sees only user features, so its N is 2. reorder_features counts
    // the seeded plane rows and clamps a smaller index to the first user slot.
    const reordered = await runHeadless({
      doc: built.doc!,
      docId: 'forward-reordered',
      steps: [{ mutation: { type: 'reorder_features', featureId: 'width', toIndex: 2 } }],
    })
    expect(reordered.ok).toBe(true)
    expect(nonSketchProblems(reordered.features)).toEqual([])
    expect(reordered.part.solveOutcomes().ex1.status).toBe('ok')
  }, 120_000)

  it('builds an add_revolve that carries its axis inline', async () => {
    const result = await runHeadless({
      doc: emptyDoc(),
      steps: [
        { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
        { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] } },
        { mutation: { type: 'add_sketch', featureId: 'sk2', plane: '@builtin_plane_front' } },
        { mutation: { type: 'add_entity', featureId: 'sk2', kind: 'line', params: [0, -5, 0, 15], entityId: 'ax' } },
        {
          mutation: {
            type: 'add_revolve', featureId: 'rev1', sketchQuery: '$sk1', angle: 90, axis: '@sk2/ax',
          },
        },
      ],
    })
    expect(result.ok).toBe(true)
    expect(nonSketchProblems(result.features)).toEqual([])
    expect(result.part.solveOutcomes().rev1.status).toBe('ok')
  }, 120_000)

  it('builds an inline cut revolve that stores its operation and direction', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const base = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(base.ok).toBe(true)
    const result = await runHeadless({
      doc: structuredClone(base.doc!),
      steps: [
        // A Front plane offset to Z = -15 cuts through the box (Top's sketch
        // y runs along -Z, so the box spans Z -30..0).
        { mutation: { type: 'add_plane', featureId: 'pl1', definition: { mode: 'offset', plane: '@builtin_plane_front', offset: -15 } } },
        { mutation: { type: 'add_sketch', featureId: 'sk2', plane: '@pl1' } },
        { mutation: { type: 'add_rect', featureId: 'sk2', p0: [25, 3], p1: [30, 7] } },
        { mutation: { type: 'add_entity', featureId: 'sk2', kind: 'line', params: [20, 3, 20, 7], entityId: 'ax' } },
        {
          mutation: {
            type: 'add_revolve', featureId: 'rev1', sketchQuery: '$sk2', angle: 360, axis: '@sk2/ax',
            operation: 'cut', direction: 'reverse',
          },
        },
      ],
    })
    expect(result.ok).toBe(true)
    expect(nonSketchProblems(result.features)).toEqual([])
    expect(result.part.solveOutcomes().rev1.status).toBe('ok')
    const cut = result.doc?.features?.find(feature => feature.id === 'rev1')
    expect(cut).toMatchObject({ kind: 'revolve', revolve: { operation: 'cut', direction: 'reverse' } })
    const measured = await measureHeadless(result.doc!)
    expect(measured).not.toBeNull()
    // The revolved 5 x 4 section has its centroid at radius 7.5, so Pappus
    // gives 2 pi * 7.5 * 20 out of the 12000 mm3 box.
    expect(measured!.measures.volume).toBeCloseTo(12000 - 2 * Math.PI * 7.5 * 20, 2)
  }, 120_000)

  it('moves a body with one inline add_transform step', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const base = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    expect(base.ok).toBe(true)
    const before = await measureHeadless(base.doc!)
    const moved = await runHeadless({
      doc: structuredClone(base.doc!),
      steps: [
        {
          mutation: {
            type: 'add_transform', featureId: 'tr1', bodies: ['body_ex1'], operation: 'replace',
            translation: [0, 5, 0],
          },
        },
      ],
    })
    expect(moved.ok).toBe(true)
    expect(nonSketchProblems(moved.features)).toEqual([])
    const after = await measureHeadless(moved.doc!)
    if (before === null || after === null) throw new Error('measure returned no row')
    if (before.measures.centroid === null || after.measures.centroid === null) throw new Error('measure returned no centroid')
    expect(after.measures.volume).toBeCloseTo(before.measures.volume, 6)
    const expected = [0, 5, 0]
    for (let i = 0; i < 3; i++) {
      const delta = after.measures.centroid[i] - before.measures.centroid[i]
      expect(delta, `centroid axis ${i}`).toBeCloseTo(expected[i], 6)
    }
  }, 120_000)

  it('refuses a revolve axis that cuts through the profile interior', async () => {
    const result = await runHeadless({
      doc: emptyDoc(),
      steps: [
        { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
        { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [10, 10] } },
        { mutation: { type: 'add_sketch', featureId: 'sk2', plane: '@builtin_plane_front' } },
        { mutation: { type: 'add_entity', featureId: 'sk2', kind: 'line', params: [-5, 5, 15, 5], entityId: 'ax' } },
        {
          mutation: {
            type: 'add_revolve', featureId: 'rev1', sketchQuery: '$sk1', angle: 90, axis: '@sk2/ax',
          },
        },
      ],
    })
    const problem = result.features.find(feature => feature.id === 'rev1')
    expect(problem).toBeDefined()
    expect(problem!.message).toContain('the axis crosses profile area sk1')
    expect(problem!.message).toContain('may touch the profile but not cut through it')
  }, 120_000)

  it('cuts a through_all extrude through the whole box with distance 1 ignored', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const result = await runHeadless({
      doc: emptyDoc(),
      steps: [
        ...box.steps,
        { mutation: { type: 'add_sketch', featureId: 'sk2', plane: '@builtin_plane_top' } },
        { mutation: { type: 'add_rect', featureId: 'sk2', p0: [10, 10], p1: [15, 15] } },
        {
          mutation: {
            type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk2', distance: 1,
            operation: 'cut', termination: 'through_all',
          },
        },
      ],
    })
    expect(result.ok).toBe(true)
    // The step is accepted and the reply is clean: distance is stored because
    // the row requires it, but the solve sizes the cut from the 10 mm box.
    expect(nonSketchProblems(result.features)).toEqual([])
    const row = result.featureDeltas?.find(entry => entry.id === 'ex2')
    expect(row?.volumeDelta).toBeCloseTo(-25 * 10, 6)
    expect(row?.bodyVolume).toBeCloseTo(12000 - 25 * 10, 6)
    const measured = await measureHeadless(result.doc!)
    expect(measured!.measures.volume).toBeCloseTo(12000 - 25 * 10, 2)
  }, 120_000)

  it('cuts a symmetric through_all extrude through the whole box from its bottom face', async () => {
    // The MCP practice repro: a 20 x 20 x 10 plate on Front, then a r=5 circle
    // on the same plane (z=0, the bottom face) cut through_all symmetric. The
    // full bore removes pi * 25 * 10, not the half the centred-span sizing took.
    const result = await runHeadless({
      doc: emptyDoc(),
      steps: [
        { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
        { mutation: { type: 'add_rect', featureId: 'sk1', p0: [-10, -10], p1: [10, 10] } },
        { mutation: { type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 10, operation: 'new' } },
        { mutation: { type: 'add_sketch', featureId: 'sk2', plane: '@builtin_plane_front' } },
        { mutation: { type: 'add_entity', featureId: 'sk2', kind: 'circle', params: [0, 0, 5], entityId: 'c1' } },
        {
          mutation: {
            type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk2', distance: 1, operation: 'cut',
            termination: 'through_all', direction: 'symmetric',
          },
        },
      ],
    })
    expect(result.ok).toBe(true)
    expect(nonSketchProblems(result.features)).toEqual([])
    const row = result.featureDeltas?.find(entry => entry.id === 'ex2')
    expect(row?.volumeDelta).toBeCloseTo(-Math.PI * 25 * 10, 3)
    expect(row?.bodyVolume).toBeCloseTo(4000 - Math.PI * 25 * 10, 3)
  }, 120_000)

  it('refuses an inline through_all add at the drive boundary, not in the kernel', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    // An absent operation reads as add, so both spellings are refused by the
    // value rule before the step touches the document.
    const operations: Array<'add' | undefined> = ['add', undefined]
    for (const operation of operations) {
      const result = await runHeadless({
        doc: emptyDoc(),
        steps: [
          ...box.steps,
          { mutation: { type: 'add_sketch', featureId: 'sk2', plane: '@builtin_plane_top' } },
          { mutation: { type: 'add_rect', featureId: 'sk2', p0: [10, 10], p1: [15, 15] } },
          {
            mutation: {
              type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk2', distance: 1,
              termination: 'through_all', ...(operation === undefined ? {} : { operation }),
            },
          },
        ],
      })
      const step = result.outcome.steps.at(-1)!
      expect(step.ok, String(operation)).toBe(false)
      expect(step.error?.code, String(operation)).toBe('invalid-mutation')
      expect(step.error?.message, String(operation)).toContain('through_all')
      expect(step.error?.message, String(operation)).toContain('cut')
      // The refused step never landed, so the solve reports no feature problem.
      expect(nonSketchProblems(result.features)).toEqual([])
      expect(result.doc?.features?.some(feature => feature.id === 'ex2')).toBe(false)
    }
  }, 120_000)

  it('carries a no-body through_all refusal as a feature row and keeps solving', async () => {
    const result = await runHeadless({
      doc: emptyDoc(),
      steps: [
        { mutation: { type: 'add_sketch', featureId: 'sk1', plane: '@builtin_plane_front' } },
        { mutation: { type: 'add_rect', featureId: 'sk1', p0: [0, 0], p1: [5, 5] } },
        {
          mutation: {
            type: 'add_extrude', featureId: 'ex1', sketchQuery: '$sk1', distance: 1,
            operation: 'cut', termination: 'through_all',
          },
        },
        { mutation: { type: 'add_sketch', featureId: 'sk2', plane: '@builtin_plane_front' } },
        { mutation: { type: 'add_rect', featureId: 'sk2', p0: [0, 0], p1: [4, 4] } },
        { mutation: { type: 'add_extrude', featureId: 'ex2', sketchQuery: '$sk2', distance: 2, operation: 'new' } },
      ],
    })
    expect(result.ok).toBe(true)
    const problem = result.features.find(feature => feature.id === 'ex1')
    expect(problem?.status).toBe('exception')
    expect(problem?.message).toContain('through_all')
    expect(problem?.message).toContain('merge_target')
    // The rest of the log still solved: only the through-all row is a problem.
    expect(nonSketchProblems(result.features).map(feature => feature.id)).toEqual(['ex1'])
    expect(result.bodies).toContain('body_ex2')
  }, 120_000)

  it('reports a through_all switch on an add extrude as a feature exception', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const result = await runHeadless({
      doc: emptyDoc(),
      steps: [
        ...box.steps,
        { mutation: { type: 'set_extrude_field', featureId: 'ex1', field: 'termination', value: 'through_all' } },
      ],
    })
    // The setter is a legal field value, so the step lands and the kernel owns
    // the refusal: a feature row, not a tool error.
    expect(result.outcome.steps.at(-1)?.ok).toBe(true)
    const problem = result.features.find(feature => feature.id === 'ex1')
    expect(problem?.status).toBe('exception')
    expect(problem?.message).toContain('through_all')
    expect(problem?.message).toContain('cut')
  }, 120_000)

  it('solves a passed document once when the script is empty', async () => {
    const box = MUTATION_EXAMPLES.find(entry => entry.name === 'box')!
    const built = await runHeadless({ doc: emptyDoc(), steps: box.steps })
    const inspected = await runHeadless({ doc: built.doc!, steps: [] })
    expect(inspected.ok).toBe(true)
    expect(inspected.outcome.steps).toEqual([])
    expect(inspected.solve.generation).toBeGreaterThan(0)
    expect(typeof inspected.docHash).toBe('string')
    expect(nonSketchProblems(inspected.features)).toEqual([])
  }, 120_000)

  it('measure returns the same feature list as run', async () => {
    const clean = await runHeadless({ doc: emptyDoc(), steps: HOLE_ON_LINE_SKETCH })
    const measured = await measureHeadless(clean.doc!)
    expect(measured).not.toBeNull()
    expect(measured!.measures.bodies).toBe(1)
    expect(measured!.features).toHaveLength(1)
    expect(measured!.features[0]).toMatchObject({ id: 'h1', kind: 'hole', status: 'exception' })
    expect(measured!.features[0].message).toMatch(/has no point/)
  }, 120_000)
})
