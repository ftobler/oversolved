// The one refusal source for `add_constraint`: the applier and the drive value
// rule must judge the same pick the same way, or a script learns a refusal only
// from an ok that changed nothing. The table is driven twice: the pure rule
// names the sentence, and the applier either authors the constraint or leaves
// the document byte-identical exactly when a problem is returned.
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { addConstraintProblem, constraintOperandRefProblem, midpointShapeReason } from '@/utils/constraintProblems'
import { CONSTRAINT_BY_KIND, CONSTRAINTS, constraintOperandProblem } from '@/registry'
import { applyAddConstraint } from '@/utils/yamlMutations'
import { sketchAt } from '@/testing/featureAccess'
import { COLINEAR_SHAPE_REASON } from '@/utils/constraintOperands'

function shapeDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [{
      id: 'sk1',
      kind: 'sketch',
      initial: {
        ax: [-2, 0, 2, 0], bx: [0, 1, 2, 1], o: [1, 1], p: [3, 3],
        c1: [0, 0, 2], e1: [0, 0, 4, 2, 0], a1: [5, 5, 2, 0, 90], a2: [8, 8, 3, 0, 90],
      },
      entities: [
        { id: 'ax', kind: 'line' },
        { id: 'bx', kind: 'line' },
        { id: 'o', kind: 'point' },
        { id: 'p', kind: 'point' },
        { id: 'c1', kind: 'circle' },
        { id: 'e1', kind: 'ellipse' },
        { id: 'a1', kind: 'arc' },
        { id: 'a2', kind: 'arc' },
      ],
      constraints: [],
    }],
  }
}

interface Case {
  name: string
  kind: string
  targets: string[]
  value?: number
  problem: string | null
}

const cases: Case[] = [
  {
    name: 'midpoint line then builtin point',
    kind: 'midpoint', targets: ['$ax', '@builtin_origin'], problem: null,
  },
  {
    name: 'midpoint builtin point then line',
    kind: 'midpoint', targets: ['@builtin_origin', '$ax'], problem: null,
  },
  {
    name: 'midpoint explicit line then stored vertex',
    kind: 'midpoint', targets: ['entity:sk1:ax', '$oxy'], problem: null,
  },
  {
    name: 'midpoint three stored points',
    kind: 'midpoint', targets: ['$axstart', '$axend', '$oxy'], problem: null,
  },
  {
    name: 'midpoint two points',
    kind: 'midpoint', targets: ['$o', '$p'], problem: midpointShapeReason(['$o', '$p']),
  },
  {
    name: 'midpoint two lines',
    kind: 'midpoint', targets: ['$ax', '$bx'], problem: midpointShapeReason(['$ax', '$bx']),
  },
  {
    name: 'midpoint curve and line',
    kind: 'midpoint', targets: ['$c1', '$ax'], problem: midpointShapeReason(['$c1', '$ax']),
  },
  {
    name: 'midpoint one operand',
    kind: 'midpoint', targets: ['$ax'], problem: midpointShapeReason(['$ax']),
  },
  {
    name: 'midpoint four operands',
    kind: 'midpoint', targets: ['$axstart', '$axend', '$o', '$p'],
    problem: midpointShapeReason(['$axstart', '$axend', '$o', '$p']),
  },
  // A handle names a point only after the applier materializes it, so the rule
  // must not refuse it before then.
  {
    name: 'midpoint with an inferred point handle',
    kind: 'midpoint', targets: ['$ax', 'dock:sk1:host'], problem: null,
  },
  { name: 'horizontal line', kind: 'horizontal', targets: ['entity:sk1:ax'], problem: null },
  {
    name: 'horizontal two vertices',
    kind: 'horizontal', targets: ['vertex:sk1:ax:start', 'vertex:sk1:ax:end'], problem: null,
  },
  { name: 'horizontal no target', kind: 'horizontal', targets: [], problem: 'horizontal needs a target' },
  // Both spellings of a whole non-point entity in the a/b slot reach the same
  // entity-kind sentence; only a substituted point-style sub-ref (a vertex) is a
  // legal point operand there.
  {
    name: 'horizontal line entity in the a/b slot',
    kind: 'horizontal', targets: ['entity:sk1:ax', 'vertex:sk1:ax:start'],
    problem: 'horizontal does not apply to line',
  },
  {
    name: 'horizontal dead pair, explicit refs',
    kind: 'horizontal', targets: ['entity:sk1:c1', 'entity:sk1:o'],
    problem: 'horizontal does not apply to circle and point',
  },
  {
    name: 'horizontal dead pair, stored refs',
    kind: 'horizontal', targets: ['$c1', '$o'],
    problem: 'horizontal does not apply to circle and point',
  },
  {
    name: 'horizontal three points',
    kind: 'horizontal', targets: ['$oxy', '$pxy', 'vertex:sk1:ax:start'],
    problem: 'horizontal needs one line or two points, got ["$oxy","$pxy","vertex:sk1:ax:start"]',
  },
  { name: 'vertical line', kind: 'vertical', targets: ['$ax'], problem: null },
  { name: 'colinear two lines', kind: 'colinear', targets: ['$ax', '$bx'], problem: null },
  { name: 'colinear point then line', kind: 'colinear', targets: ['$oxy', '$ax'], problem: null },
  { name: 'colinear one target', kind: 'colinear', targets: ['$ax'], problem: COLINEAR_SHAPE_REASON },
  { name: 'colinear curve and line', kind: 'colinear', targets: ['$c1', '$ax'], problem: COLINEAR_SHAPE_REASON },
  { name: 'coincident two refs', kind: 'coincident', targets: ['$oxy', '$pxy'], problem: null },
  {
    name: 'coincident one ref',
    kind: 'coincident', targets: ['$oxy'],
    problem: 'Coincident needs two operands, got one',
  },
  {
    name: 'equal_length with the sketch plane as an operand',
    kind: 'equal_length', targets: ['@builtin_plane_top', 'entity:sk1:ax'],
    problem: 'Equal takes sketch geometry; @builtin_plane_top is a plane',
  },
  { name: 'length one ref', kind: 'length', targets: ['$ax'], value: 4, problem: null },
  {
    name: 'generic kind with no target',
    kind: 'parallel', targets: [],
    problem: 'Parallel needs two operands (two lines), got none',
  },
  { name: 'zero point_distance', kind: 'point_distance', targets: ['$oxy', '$pxy'], value: 0,
    problem: 'point_distance value 0 is a coincident, not a dimension; use the coincident constraint between the two points' },
  { name: 'zero point_distance_x', kind: 'point_distance_x', targets: ['$oxy', '$pxy'], value: 0, problem: null },
  // The kind-applicability half: a well-formed pick whose entity kind the
  // constraint cannot represent is refused with the sentence the solve-time
  // lowering records in `dropped_constraints`, so a script cannot author a row
  // the next solve silently ignores.
  { name: 'horizontal on a point entity', kind: 'horizontal', targets: ['$o'], problem: 'horizontal does not apply to point' },
  { name: 'vertical on a curve entity', kind: 'vertical', targets: ['$c1'], problem: 'vertical does not apply to circle' },
  // The overloaded a/b pair is two points: a whole point entity is a legal
  // operand there even though the single-target form must be a line. The stored
  // `$` spelling and the explicit `entity:` spelling must agree.
  { name: 'vertical two point entities', kind: 'vertical', targets: ['$o', '$p'], problem: null },
  {
    name: 'vertical two point entities, explicit refs',
    kind: 'vertical', targets: ['entity:sk1:o', 'entity:sk1:p'], problem: null,
  },
  { name: 'length on an arc', kind: 'length', targets: ['$a1'], value: 3, problem: 'length does not apply to arc' },
  { name: 'radius on a line', kind: 'radius', targets: ['$ax'], value: 3, problem: 'radius does not apply to line' },
  { name: 'radius on an ellipse', kind: 'radius', targets: ['$e1'], value: 3, problem: 'radius does not apply to ellipse' },
  { name: 'diameter on an ellipse', kind: 'diameter', targets: ['$e1'], value: 6, problem: 'diameter does not apply to ellipse' },
  { name: 'diameter on an arc', kind: 'diameter', targets: ['$a1'], value: 4, problem: null },
  { name: 'angle with a curve operand', kind: 'angle', targets: ['$ax', '$c1'], value: 30,
    problem: 'angle does not apply to line and circle' },
  { name: 'radius_difference with a line operand', kind: 'radius_difference', targets: ['$c1', '$ax'], value: 1,
    problem: 'radius_difference does not apply to circle and line' },
  { name: 'equal_length across a line and an ellipse', kind: 'equal_length', targets: ['$ax', '$e1'],
    problem: 'equal_length does not apply to line and ellipse' },
  { name: 'equal_length on two arcs', kind: 'equal_length', targets: ['$a1', '$a2'], problem: null },
  { name: 'concentric circle and ellipse', kind: 'concentric', targets: ['$c1', '$e1'], problem: null },
  { name: 'concentric with a line', kind: 'concentric', targets: ['$c1', '$ax'],
    problem: 'concentric does not apply to circle and line' },
  // A vertex names a point operand, not an entity kind: the group table has
  // nothing to say about it.
  { name: 'radius named by a vertex', kind: 'radius', targets: ['vertex:sk1:c1:center'], value: 3, problem: null },
  // A group holds whole entities and single points. The applier parity run
  // below proves a legal point member is authored and a duplicate/lone point is
  // not.
  { name: 'group whole line and circle', kind: 'group', targets: ['entity:sk1:ax', 'entity:sk1:c1'], problem: null },
  { name: 'group two point members', kind: 'group', targets: ['$axend', '$c1center'], problem: null },
  { name: 'group a point entity by its xy', kind: 'group', targets: ['$oxy'], problem: null },
  {
    name: 'group a whole entity and its own point', kind: 'group', targets: ['entity:sk1:ax', '$axend'],
    problem: 'group names entity "ax" both whole and by point; drop the duplicate',
  },
  {
    name: 'group a lone point member', kind: 'group', targets: ['$axend'],
    problem: 'group needs at least two points, or one whole entity',
  },
  {
    name: 'group a point key the kind lacks', kind: 'group', targets: ['$axc1', '$c1'],
    problem: 'group cannot hold point "c1" of line "ax"; it has no such point',
  },
  {
    name: 'group the origin', kind: 'group', targets: ['$ax', '@builtin_origin'],
    problem: 'group holds entities and points; the origin is not one',
  },
]

describe('addConstraintProblem', () => {
  it.each(cases)('$name', ({ kind, targets, value, problem }) => {
    expect(addConstraintProblem(sketchAt(shapeDoc()), kind, targets, value)).toBe(problem)
  })

  // The parity guarantee: the applier authors something exactly when the rule
  // sees no problem. A materializable handle is excluded because the applier
  // would need a real dock host to resolve it; its rule verdict is pinned above.
  it.each(cases.filter(entry => !entry.targets.some(target => target.startsWith('dock:'))))(
    'the applier agrees with the rule: $name',
    ({ kind, targets, value, problem }) => {
      const doc = shapeDoc()
      const before = JSON.stringify(doc)
      applyAddConstraint(doc, 'sk1', kind, targets, value)
      if (problem === null) {
        expect(JSON.stringify(doc)).not.toBe(before)
      } else {
        expect(JSON.stringify(doc)).toBe(before)
      }
    },
  )

  // The bugreport's row: the sketch's own host plane became operand `a`. A
  // plane, a named plane, another feature and a face query are not sketch
  // geometry, so no kind may take one, and the sentence says which kind of
  // thing the ref is when the name alone can classify it.
  const NON_SKETCH_TARGETS: ReadonlyArray<readonly [string, string]> = [
    ['@builtin_plane_top', 'a plane'],
    ['@builtin_plane_front', 'a plane'],
    ['@pl1', 'not sketch geometry'],
    ['@sk1', 'not sketch geometry'],
    ['@body_ex1/face/0', 'not sketch geometry'],
    ['?face', 'not sketch geometry'],
  ]

  it.each(CONSTRAINTS.map(c => c.kind))('%s refuses a non-sketch operand', kind => {
    const label = CONSTRAINT_BY_KIND.get(kind)!.label
    for (const [target, noun] of NON_SKETCH_TARGETS) {
      expect(addConstraintProblem(sketchAt(shapeDoc()), kind, [target], undefined))
        .toBe(`${label} takes sketch geometry; ${target} is ${noun}`)
    }
  })

  it('judges the non-sketch operand without a live document', () => {
    // The drive and MCP value rule call this with no sketch: the ref shape is
    // readable on its own, so the plane must still be refused there.
    expect(addConstraintProblem(undefined, 'equal_length', ['@builtin_plane_top', '$L1'], undefined))
      .toBe('Equal takes sketch geometry; @builtin_plane_top is a plane')
  })

  it('accepts the builtin origin where the kind takes a point', () => {
    const sketch = sketchAt(shapeDoc())
    expect(addConstraintProblem(sketch, 'coincident', ['@builtin_origin', '$pxy'], undefined)).toBeNull()
    expect(addConstraintProblem(sketch, 'point_distance', ['@builtin_origin', '$pxy'], 5)).toBeNull()
    expect(addConstraintProblem(sketch, 'horizontal', ['@builtin_origin', '$oxy'], undefined)).toBeNull()
    expect(addConstraintProblem(sketch, 'midpoint', ['$ax', '@builtin_origin'], undefined)).toBeNull()
  })

  it('keeps the pinned face:/edge: wrappers on their add-time verbatim path', () => {
    // `yamlMutations.constraints.test.ts` pins that these wrappers are stored
    // verbatim by the applier. The closed-list rule still names them for the
    // lowering and for the editor filter, so the exception is add-time only.
    const sketch = sketchAt(shapeDoc())
    for (const wrapper of ['face:sketch0:?3;@sketch0abc', 'edge:sketch0:?4;@bodyx:edge']) {
      expect(addConstraintProblem(
        sketch, 'coincident', ['vertex:sk1:ax:start', wrapper], undefined,
      )).toBeNull()
      expect(constraintOperandRefProblem('coincident', wrapper))
        .toBe(`Coincident takes sketch geometry; ${wrapper} is not sketch geometry`)
    }
  })

  it('refuses a face-projection member as a group member', () => {
    const doc = shapeDoc()
    const sketch = doc.features![0]
    if (sketch.kind !== 'sketch') throw new Error('fixture is not a sketch')
    const member = 'proj_face.eaaaaaaa'
    sketch.constraints = [{
      id: 'proj_face', kind: 'projection', source: '?face',
      members: { 'u|e_aaaa': member },
    }]
    const problem = addConstraintProblem(sketch, 'group', [`entity:sk1:${member}`], undefined)
    expect(problem).toContain('projected member')
  })
})

// The operand count is a registry fact, so this table is driven from CONSTRAINTS:
// a new pair kind is covered without editing the test, and no kind can fall back
// to "at least one" silently.
const IDS_BY_KIND: Record<string, readonly string[]> = {
  line: ['ax', 'bx'], circle: ['c1'], arc: ['a1', 'a2'], ellipse: ['e1'], point: ['o', 'p'],
}

/** Two operands a pair kind can take: the first two ids of its first entity-kind
 *  group, or two vertex picks for a kind with no entity-kind restriction. */
function pairTargets(kind: string): string[] {
  const group = CONSTRAINT_BY_KIND.get(kind)?.entityKindGroups?.[0]
  const ids = (group ?? []).flatMap(entityKind => IDS_BY_KIND[entityKind] ?? []).slice(0, 2)
  return ids.length === 2
    ? ids.map(id => `entity:sk1:${id}`)
    : ['vertex:sk1:ax:start', 'vertex:sk1:ax:end']
}

describe('constraint operand arity', () => {
  const pairKinds = CONSTRAINTS.filter(c => c.operands === 'pair').map(c => c.kind)

  it('names the count and the pick a pair needs', () => {
    expect(constraintOperandProblem('equal_length', 1))
      .toBe('Equal needs two operands (two lines, or two arcs/circles), got one')
    expect(constraintOperandProblem('parallel', 3))
      .toBe('Parallel needs two operands (two lines), got three')
    expect(constraintOperandProblem('coincident', 1))
      .toBe('Coincident needs two operands, got one')
    expect(constraintOperandProblem('length', 2)).toBe('Length needs one operand, got two')
    expect(constraintOperandProblem('horizontal', 3))
      .toBe('Horizontal needs one or two operands, got three')
    // The kinds with their own shape rule own the count too.
    expect(constraintOperandProblem('group', 0)).toBeNull()
    expect(constraintOperandProblem('midpoint', 1)).toBeNull()
    expect(constraintOperandProblem('colinear', 1)).toBeNull()
    expect(constraintOperandProblem('ngon', 0)).toBeNull()
  })

  it.each(pairKinds)('%s refuses one operand with the pair sentence', kind => {
    expect(addConstraintProblem(sketchAt(shapeDoc()), kind, ['entity:sk1:ax'], undefined))
      .toBe(constraintOperandProblem(kind, 1))
    expect(constraintOperandProblem(kind, 1)).toContain('got one')
  })

  it.each(pairKinds)('%s accepts two operands', kind => {
    expect(addConstraintProblem(sketchAt(shapeDoc()), kind, pairTargets(kind), undefined)).toBeNull()
  })

  it.each(pairKinds)('%s refuses three operands', kind => {
    expect(addConstraintProblem(
      sketchAt(shapeDoc()), kind, [...pairTargets(kind), 'entity:sk1:o'], undefined,
    )).toBe(constraintOperandProblem(kind, 3))
  })

  it('the one-or-pair kinds accept one and two operands', () => {
    for (const kind of ['horizontal', 'vertical']) {
      expect(addConstraintProblem(sketchAt(shapeDoc()), kind, ['entity:sk1:ax'], undefined)).toBeNull()
      expect(addConstraintProblem(
        sketchAt(shapeDoc()), kind, ['vertex:sk1:ax:start', 'vertex:sk1:ax:end'], undefined,
      )).toBeNull()
    }
  })
})
