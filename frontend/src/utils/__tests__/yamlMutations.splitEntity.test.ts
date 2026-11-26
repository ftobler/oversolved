// @vitest-environment node
//
// The split_entity applier: one curve becomes pieces meeting at the split
// points, the shape does not change, and every constraint either stays, moves
// to the piece that now owns its vertex, or refuses the step by id. The cut
// math is pinned in utils/geometry/__tests__/sketchPieces.test.ts; these pin
// the document write, the constraint carry and, against the real solver, that
// a fully constrained sketch stays fully constrained with its geometry intact.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { PartConstraint, PartDoc, PartEntityDef, SketchData, SketchFeature } from '@/types/cad'
import { applySplitEntity, planSplitEntity } from '@/utils/yamlMutations'
import { createDocSession, type EditorFacts } from '@/session/DocSession'
import type { DirtyFacts } from '@/session/dirty'
import { createFakeSolveScheduler } from '@/session/__tests__/fakeSolveScheduler'
import { mutationValueViolation } from '@/drive/mutationValues'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'
import { setSketchSolver, setSketchTopology, solveSketch } from '@/kernel/features/sketch'
import { initGlobalRepo } from '@/kernel/query'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { sketchAt } from '@/testing/featureAccess'

const solveBytes = loadSolver()
const topologyBytes = loadTopology()

const copy = (doc: PartDoc): PartDoc => structuredClone(doc)
const featureOf = (doc: PartDoc): SketchFeature => sketchAt(doc) as SketchFeature
const constraintsOf = (doc: PartDoc): PartConstraint[] => featureOf(doc).constraints ?? []
const byId = (doc: PartDoc, id: string) => constraintsOf(doc).find(c => c.id === id)
const newIds = (doc: PartDoc, before: readonly string[]) =>
  (featureOf(doc).entities ?? []).map(e => e.id).filter(id => !before.includes(id))

function sketchDoc(entities: PartEntityDef[], initial: Record<string, number[]>, constraints: PartConstraint[] = []): PartDoc {
  return makeDoc(makeSketch('sk', { entities, initial, constraints }))
}

/** A 40 x 30 rectangle held by joints, axis constraints, a fixed corner point
 *  and two side lengths: fully constrained with no equal_length (which a split
 *  refuses). */
function rectDoc(): PartDoc {
  return sketchDoc(
    [
      { id: 'b', kind: 'line' }, { id: 'r', kind: 'line' },
      { id: 't', kind: 'line' }, { id: 'l', kind: 'line' },
      { id: 'o', kind: 'point' },
    ],
    { b: [0, 0, 40, 0], r: [40, 0, 40, 30], t: [40, 30, 0, 30], l: [0, 30, 0, 0], o: [0, 0] },
    [
      { id: 'k_bl', kind: 'coincident', a: '$bstart', b: '$lend' },
      { id: 'k_br', kind: 'coincident', a: '$bend', b: '$rstart' },
      { id: 'k_tr', kind: 'coincident', a: '$rend', b: '$tstart' },
      { id: 'k_tl', kind: 'coincident', a: '$tend', b: '$lstart' },
      { id: 'h_b', kind: 'horizontal', target: '$b' },
      { id: 'h_t', kind: 'horizontal', target: '$t' },
      { id: 'v_l', kind: 'vertical', target: '$l' },
      { id: 'v_r', kind: 'vertical', target: '$r' },
      { id: 'fx', kind: 'fixed', target: '$o' },
      { id: 'k_o', kind: 'coincident', a: '$o', b: '$bstart' },
      { id: 'len_b', kind: 'length', target: '$b', value: 40, pos: [0, -5] },
      { id: 'len_r', kind: 'length', target: '$r', value: 30 },
    ],
  )
}

const solve = (doc: PartDoc) =>
  solveSketch(featureOf(doc) as unknown as Record<string, unknown>, initGlobalRepo(), {})

// The pins are authored on the document grid (1e-6), so an angle they hold may
// move by a few micro-degrees: far below any visible shift, but not 1e-6.
function expectGeometry(actual: number[] | undefined, expected: number[], digits = 6): void {
  expect(actual).toBeDefined()
  expect(actual!).toHaveLength(expected.length)
  actual!.forEach((value, i) => expect(value).toBeCloseTo(expected[i], digits))
}

describe('split_entity on a line', () => {
  it('splits at the midpoint into two lines with a coincident joint, a colinear tie and a pin', () => {
    const doc = rectDoc()
    applySplitEntity(doc, 'sk', 'b', [[20, 0]])
    const f = featureOf(doc)
    const [piece] = newIds(doc, ['b', 'r', 't', 'l', 'o'])
    expect(piece).toBeDefined()
    // The new piece lands right after the entity it came from.
    expect(f.entities!.map(e => e.id)).toEqual(['b', piece, 'r', 't', 'l', 'o'])
    expect(f.initial!.b).toEqual([0, 0, 20, 0])
    expect(f.initial![piece]).toEqual([20, 0, 40, 0])
    const added = constraintsOf(doc).filter(c => byId(rectDoc(), c.id) === undefined)
    expect(added.map(c => c.kind).sort()).toEqual(['coincident', 'colinear', 'length'])
    expect(added.find(c => c.kind === 'coincident')).toMatchObject({ a: '$bend', b: `$${piece}start` })
    expect(added.find(c => c.kind === 'length')).toMatchObject({ target: '$b', value: 20 })
  })

  it('rewrites the length to the end-to-end point_distance with the same id, value and label', () => {
    const doc = rectDoc()
    applySplitEntity(doc, 'sk', 'b', [[20, 0]])
    const [piece] = newIds(doc, ['b', 'r', 't', 'l', 'o'])
    const rewritten = byId(doc, 'len_b')!
    expect(rewritten.kind).toBe('point_distance')
    expect(rewritten.target).toBeUndefined()
    expect(rewritten).toMatchObject({ a: '$bstart', b: `$${piece}end`, value: 40, pos: [0, -5] })
  })

  it('moves a coincident on the end vertex to the last piece and leaves start refs alone', () => {
    const doc = rectDoc()
    applySplitEntity(doc, 'sk', 'b', [[20, 0]])
    const [piece] = newIds(doc, ['b', 'r', 't', 'l', 'o'])
    expect(byId(doc, 'k_br')).toMatchObject({ a: `$${piece}end`, b: '$rstart' })
    expect(byId(doc, 'k_bl')).toMatchObject({ a: '$bstart', b: '$lend' })
    expect(byId(doc, 'k_o')).toMatchObject({ a: '$o', b: '$bstart' })
    // A carrier relation stays on the id-keeping piece.
    expect(byId(doc, 'h_b')).toMatchObject({ target: '$b' })
  })

  it('cuts at several points into ordered pieces', () => {
    const doc = rectDoc()
    applySplitEntity(doc, 'sk', 'b', [[30, 0], [10, 0]])
    const pieces = newIds(doc, ['b', 'r', 't', 'l', 'o'])
    expect(pieces).toHaveLength(2)
    const f = featureOf(doc)
    expect(f.initial!.b).toEqual([0, 0, 10, 0])
    expect(f.initial![pieces[0]]).toEqual([10, 0, 30, 0])
    expect(f.initial![pieces[1]]).toEqual([30, 0, 40, 0])
    expect(byId(doc, 'k_br')).toMatchObject({ a: `$${pieces[1]}end` })
  })

  it('projects a point near the line onto it', () => {
    const doc = rectDoc()
    applySplitEntity(doc, 'sk', 'b', [[12.5, 0.0004]])
    expect(featureOf(doc).initial!.b).toEqual([0, 0, 12.5, 0])
  })

  it('keeps carrier relations on the first piece and moves an end tangent joint to the last', () => {
    const doc = sketchDoc(
      [
        { id: 'a', kind: 'line' }, { id: 'p', kind: 'line' },
        { id: 'c', kind: 'circle' }, { id: 'arc', kind: 'arc' },
      ],
      {
        a: [0, 0, 10, 0], p: [0, 5, 10, 5], c: [5, -3, 3],
        // A quarter arc whose start sits on a's end, tangent there.
        arc: [10, 4, 4, 270, 360],
      },
      [
        { id: 'par', kind: 'parallel', a: '$a', b: '$p' },
        { id: 'tc', kind: 'tangent', a: '$a', b: '$c' },
        { id: 'joint', kind: 'coincident', a: '$aend', b: '$arcstart' },
        { id: 'ta', kind: 'tangent', a: '$a', b: '$arc' },
      ],
    )
    applySplitEntity(doc, 'sk', 'a', [[6, 0]])
    const [piece] = newIds(doc, ['a', 'p', 'c', 'arc'])
    expect(byId(doc, 'par')).toMatchObject({ a: '$a', b: '$p' })
    expect(byId(doc, 'tc')).toMatchObject({ a: '$a', b: '$c' })
    expect(byId(doc, 'joint')).toMatchObject({ a: `$${piece}end`, b: '$arcstart' })
    expect(byId(doc, 'ta')).toMatchObject({ a: `$${piece}`, b: '$arc' })
  })

  it('splits a construction line into construction pieces', () => {
    const doc = sketchDoc([{ id: 'cl', kind: 'line', construction: true }], { cl: [0, 0, 10, 10] })
    applySplitEntity(doc, 'sk', 'cl', [[5, 5]])
    const entities = featureOf(doc).entities!
    expect(entities).toHaveLength(2)
    for (const entity of entities) expect(entity.construction).toBe(true)
  })
})

describe('split_entity on arcs and circles', () => {
  it('keeps the radius on the first arc and ties the pieces with concentric and a chord', () => {
    const doc = sketchDoc(
      [{ id: 'arc', kind: 'arc' }],
      { arc: [0, 0, 10, 0, 90] },
      [{ id: 'rad', kind: 'radius', target: '$arc', value: 10 }],
    )
    applySplitEntity(doc, 'sk', 'arc', [[10 * Math.SQRT1_2, 10 * Math.SQRT1_2]])
    const [piece] = newIds(doc, ['arc'])
    expect(featureOf(doc).initial!.arc).toEqual([0, 0, 10, 0, 45])
    expect(featureOf(doc).initial![piece]).toEqual([0, 0, 10, 45, 90])
    expect(byId(doc, 'rad')).toMatchObject({ target: '$arc' })
    const kinds = constraintsOf(doc).map(c => c.kind).sort()
    expect(kinds).toEqual(['coincident', 'concentric', 'point_distance', 'radius'])
  })

  it('turns a circle split at two points into two arcs and keeps the diameter on the first', () => {
    const doc = sketchDoc(
      [{ id: 'c', kind: 'circle' }],
      { c: [0, 0, 5] },
      [{ id: 'dia', kind: 'diameter', target: '$c', value: 10 }],
    )
    applySplitEntity(doc, 'sk', 'c', [[0, 5], [0, -5]])
    const f = featureOf(doc)
    const [piece] = newIds(doc, ['c'])
    expect(f.entities!.map(e => e.kind)).toEqual(['arc', 'arc'])
    expect(f.initial!.c).toEqual([0, 0, 5, 90, 270])
    expect(f.initial![piece]).toEqual([0, 0, 5, 270, 90])
    expect(byId(doc, 'dia')).toMatchObject({ target: '$c' })
  })

  it('keeps an equal radius on the first arc instead of refusing it', () => {
    const doc = sketchDoc(
      [{ id: 'c', kind: 'circle' }, { id: 'd', kind: 'circle' }],
      { c: [0, 0, 5], d: [20, 0, 5] },
      [{ id: 'eq', kind: 'equal_length', a: '$c', b: '$d' }],
    )
    applySplitEntity(doc, 'sk', 'c', [[5, 0], [-5, 0]])
    expect(featureOf(doc).entities).toHaveLength(3)
    expect(byId(doc, 'eq')).toMatchObject({ a: '$c', b: '$d' })
  })

  it('refuses a circle with one split point', () => {
    const doc = sketchDoc([{ id: 'c', kind: 'circle' }], { c: [0, 0, 5] })
    const plan = planSplitEntity(featureOf(doc), 'c', [[5, 0]])
    expect(plan).toMatchObject({ code: 'invalid' })
    expect('reason' in plan && plan.reason).toMatch(/a circle needs two split points/)
  })
})

describe('split_entity on a spline', () => {
  it('splits by de Casteljau with a coincident joint and a tangent tie', () => {
    const doc = sketchDoc([{ id: 's', kind: 'spline' }], { s: [0, 0, 10, 20, 30, 20, 40, 0] })
    applySplitEntity(doc, 'sk', 's', [[20, 15]])
    const [piece] = newIds(doc, ['s'])
    const f = featureOf(doc)
    expect(f.initial!.s.slice(0, 2)).toEqual([0, 0])
    expect(f.initial![piece].slice(6)).toEqual([40, 0])
    expect(f.initial!.s.slice(6)).toEqual(f.initial![piece].slice(0, 2))
    expect(constraintsOf(doc).map(c => c.kind).sort()).toEqual(['coincident', 'tangent'])
  })

  it('moves a tangent with the coincident that gives the solver its contact', () => {
    // The spline's end lies on the circle: the tangent's contact is that
    // coincident, which moves to the last piece, so the tangent must follow.
    const doc = sketchDoc(
      [{ id: 's', kind: 'spline' }, { id: 'c', kind: 'circle' }],
      { s: [0, 0, 10, 20, 30, 20, 40, 0], c: [40, -5, 5] },
      [
        { id: 'on', kind: 'coincident', a: '$send', b: '$c' },
        { id: 'tg', kind: 'tangent', a: '$s', b: '$c' },
      ],
    )
    applySplitEntity(doc, 'sk', 's', [[20, 15]])
    const [piece] = newIds(doc, ['s', 'c'])
    expect(byId(doc, 'on')).toMatchObject({ a: `$${piece}end`, b: '$c' })
    expect(byId(doc, 'tg')).toMatchObject({ a: `$${piece}`, b: '$c' })
  })

  it('refuses a spline whose handle a constraint names', () => {
    const doc = sketchDoc(
      [{ id: 's', kind: 'spline' }, { id: 'p', kind: 'point' }],
      { s: [0, 0, 10, 20, 30, 20, 40, 0], p: [10, 20] },
      [{ id: 'h', kind: 'coincident', a: '$sc1', b: '$p' }],
    )
    const plan = planSplitEntity(featureOf(doc), 's', [[20, 15]])
    expect('reason' in plan && plan.reason).toMatch(/"h".*handle "c1"/)
  })
})

describe('split_entity refusals', () => {
  const lineWith = (constraints: PartConstraint[], extra: PartEntityDef[] = []): PartDoc => sketchDoc(
    [{ id: 'l', kind: 'line' }, { id: 'm', kind: 'line' }, ...extra],
    { l: [0, 0, 10, 0], m: [0, 5, 10, 5], q: [3, 3] },
    constraints,
  )

  it.each([
    ['equal_length', { id: 'eq', kind: 'equal_length', a: '$l', b: '$m' }, /"eq" is an equal_length/],
    ['midpoint', { id: 'mid', kind: 'midpoint', line: '$l', point: '$q' }, /"mid" is a midpoint/],
    ['group', { id: 'grp', kind: 'group', refs: ['$l', '$m'] }, /group constraint "grp"/],
    ['fixed entity', { id: 'fix', kind: 'fixed', target: '$l' }, /"fix" fixes the whole entity/],
    ['projection', { id: 'prj', kind: 'projection', target: '$l', source: '@other/e1' }, /constraint "prj"/],
  ] as Array<[string, PartConstraint, RegExp]>)('refuses a %s by its id and leaves the document byte-identical', (_name, constraint, reason) => {
    const doc = lineWith([constraint], [{ id: 'q', kind: 'point' }])
    const before = JSON.stringify(doc)
    const plan = planSplitEntity(featureOf(doc), 'l', [[5, 0]])
    expect('reason' in plan && plan.reason).toMatch(reason)
    applySplitEntity(doc, 'sk', 'l', [[5, 0]])
    expect(JSON.stringify(doc)).toBe(before)
  })

  it.each([
    ['ellipse', [0, 0, 5, 3, 0], /an ellipse cannot be split: there is no elliptical-arc entity kind/],
    ['fit_spline', [0, 0, 5, 5, 10, 0], /a fit spline cannot be split/],
    ['point', [1, 1], /a point has no length to split/],
  ] as Array<[string, number[], RegExp]>)('refuses a %s with its sentence', (kind, params, reason) => {
    const doc = sketchDoc([{ id: 'e', kind }], { e: params })
    const plan = planSplitEntity(featureOf(doc), 'e', [[1, 1]])
    expect(plan).toMatchObject({ code: 'invalid' })
    expect('reason' in plan && plan.reason).toMatch(reason)
  })

  it.each([
    ['off the curve', [[5, 0.5]], /beyond the pick tolerance/],
    ['past an end', [[12, 0]], /past the end/],
    ['on an open end', [[10, 0]], /on an end of "l"/],
    ['twice at one point', [[4, 0], [4, 0.000001]], /same point as point 0/],
  ] as Array<[string, Array<[number, number]>, RegExp]>)('refuses a point %s', (_name, at, reason) => {
    const doc = lineWith([])
    const before = JSON.stringify(doc)
    const plan = planSplitEntity(featureOf(doc), 'l', at)
    expect('reason' in plan && plan.reason).toMatch(reason)
    applySplitEntity(doc, 'sk', 'l', at)
    expect(JSON.stringify(doc)).toBe(before)
  })

  it('reports an unknown entity as an unknown target', () => {
    expect(planSplitEntity(featureOf(lineWith([])), 'nope', [[0, 0]])).toMatchObject({ code: 'unknown-target' })
  })
})

describe('split_entity history and drive parity', () => {
  it('undo restores the document byte for byte and redo repeats the split', () => {
    const cell: { current: PartDoc | null } = { current: rectDoc() }
    const solveResults: { current: Record<string, SketchData> } = { current: {} }
    const facts: EditorFacts = { editingFeatureId: null, rollbackPosition: null }
    const dirty: DirtyFacts = { dirty: false, saves: 0, savedHash: null }
    const session = createDocSession({
      cloneDoc: source => structuredClone(source),
      doc: { get: () => cell.current, set: next => { cell.current = next } },
      solve: createFakeSolveScheduler<PartDoc>(),
      solveResults: { get: () => solveResults.current, set: next => { solveResults.current = next } },
      editorFacts: () => facts,
      dirtyFacts: () => dirty,
    })
    const before = JSON.stringify(cell.current)
    session.execute({ type: 'split_entity', featureId: 'sk', entityId: 'b', at: [[20, 0]] })
    const after = JSON.stringify(cell.current)
    expect(after).not.toBe(before)
    session.undo()
    expect(JSON.stringify(cell.current)).toBe(before)
    session.redo()
    expect(JSON.stringify(cell.current)).toBe(after)
  })

  it('refuses at the drive boundary with the applier\'s own reason', () => {
    const doc = sketchDoc(
      [{ id: 'l', kind: 'line' }, { id: 'm', kind: 'line' }],
      { l: [0, 0, 10, 0], m: [0, 5, 10, 5] },
      [{ id: 'eq', kind: 'equal_length', a: '$l', b: '$m' }],
    )
    const plan = planSplitEntity(featureOf(doc), 'l', [[5, 0]])
    const step = (at: unknown) => ({ type: 'split_entity', featureId: 'sk', entityId: 'l', at })
    const ctx = (d: PartDoc | null) => ({ doc: d, fieldSchema: () => null })
    const violation = mutationValueViolation('split_entity', step([[5, 0]]), ctx(copy(doc)))
    expect(violation).not.toBeNull()
    expect(violation!.message).toBe(`split_entity: ${'reason' in plan ? plan.reason : ''}`)
    expect(mutationValueViolation('split_entity', step([]), ctx(copy(doc)))!.message)
      .toMatch(/at must be a non-empty list/)
    expect(mutationValueViolation('split_entity', step([[5, 'x']]), ctx(null))!.message)
      .toMatch(/at\[0\] must be 2 finite numbers/)
  })
})

describe.skipIf(!solveBytes)('split_entity against the real solver', () => {
  beforeAll(() => {
    setSketchSolver(solveBytes!)
    setSketchTopology(topologyBytes)
  })
  afterAll(() => {
    setSketchSolver(null)
    setSketchTopology(null)
  })

  it('keeps a fully constrained rectangle fully constrained with unchanged geometry', () => {
    const doc = rectDoc()
    const before = solve(doc)
    expect(before.status).toBe('fully_constrained')
    applySplitEntity(doc, 'sk', 'b', [[15, 0]])
    const [piece] = newIds(doc, ['b', 'r', 't', 'l', 'o'])
    const out = solve(doc)
    expect(out.status).toBe('fully_constrained')
    expect(out.dof).toBe(0)
    expectGeometry(out.geometry?.b, [0, 0, 15, 0])
    expectGeometry(out.geometry?.[piece], [15, 0, 40, 0])
    for (const id of ['r', 't', 'l']) expectGeometry(out.geometry?.[id], featureOf(rectDoc()).initial![id])
  })

  it('keeps a fully constrained arc fully constrained with unchanged geometry', () => {
    const doc = sketchDoc(
      [{ id: 'arc', kind: 'arc' }, { id: 'o', kind: 'point' }],
      { arc: [0, 0, 10, 0, 90], o: [0, 0] },
      [
        { id: 'fx', kind: 'fixed', target: '$o' },
        { id: 'cc', kind: 'coincident', a: '$arccenter', b: '$o' },
        { id: 'rad', kind: 'radius', target: '$arc', value: 10 },
        { id: 'hs', kind: 'horizontal', a: '$arccenter', b: '$arcstart' },
        { id: 've', kind: 'vertical', a: '$arccenter', b: '$arcend' },
      ],
    )
    expect(solve(doc).status).toBe('fully_constrained')
    applySplitEntity(doc, 'sk', 'arc', [[10 * Math.cos(Math.PI / 6), 10 * Math.sin(Math.PI / 6)]])
    const [piece] = newIds(doc, ['arc', 'o'])
    expect(byId(doc, 've')).toMatchObject({ b: `$${piece}end` })
    const out = solve(doc)
    expect(out.status).toBe('fully_constrained')
    expect(out.dof).toBe(0)
    expectGeometry(out.geometry?.arc, [0, 0, 10, 0, 30], 4)
    expectGeometry(out.geometry?.[piece], [0, 0, 10, 30, 90], 4)
  })

  it('keeps a fully constrained circle fully constrained when split into arcs', () => {
    const doc = sketchDoc(
      [{ id: 'c', kind: 'circle' }, { id: 'o', kind: 'point' }],
      { c: [0, 0, 5], o: [0, 0] },
      [
        { id: 'fx', kind: 'fixed', target: '$o' },
        { id: 'cc', kind: 'coincident', a: '$ccenter', b: '$o' },
        { id: 'dia', kind: 'diameter', target: '$c', value: 10 },
      ],
    )
    expect(solve(doc).status).toBe('fully_constrained')
    applySplitEntity(doc, 'sk', 'c', [[5 * Math.cos(0.5), 5 * Math.sin(0.5)], [-5, 0]])
    const out = solve(doc)
    expect(out.status).toBe('fully_constrained')
    expect(out.dof).toBe(0)
    const deg = 0.5 * 180 / Math.PI
    expect(out.geometry?.c?.[3]).toBeCloseTo(deg, 4)
    expect(out.geometry?.c?.[4]).toBeCloseTo(180, 4)
    expect(out.geometry?.c?.[2]).toBeCloseTo(5, 6)
  })
})
