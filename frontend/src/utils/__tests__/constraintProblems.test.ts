// The one refusal source for `add_constraint`: the applier and the drive value
// rule must judge the same pick the same way, or a script learns a refusal only
// from an ok that changed nothing. The table is driven twice: the pure rule
// names the sentence, and the applier either authors the constraint or leaves
// the document byte-identical exactly when a problem is returned.
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { addConstraintProblem, midpointShapeReason } from '@/utils/constraintProblems'
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
      initial: { ax: [-2, 0, 2, 0], bx: [0, 1, 2, 1], o: [1, 1], p: [3, 3], c1: [0, 0, 2] },
      entities: [
        { id: 'ax', kind: 'line' },
        { id: 'bx', kind: 'line' },
        { id: 'o', kind: 'point' },
        { id: 'p', kind: 'point' },
        { id: 'c1', kind: 'circle' },
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
  {
    name: 'horizontal whole entity in the a/b slot',
    kind: 'horizontal', targets: ['entity:sk1:ax', 'vertex:sk1:ax:start'],
    problem: 'horizontal needs one line or two points, got ["entity:sk1:ax","vertex:sk1:ax:start"]',
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
    problem: 'coincident needs two targets, got ["$oxy"]',
  },
  { name: 'length one ref', kind: 'length', targets: ['$ax'], value: 4, problem: null },
  {
    name: 'generic kind with no target',
    kind: 'parallel', targets: [],
    problem: 'parallel needs a target, got []',
  },
  { name: 'zero point_distance', kind: 'point_distance', targets: ['$oxy', '$pxy'], value: 0,
    problem: 'point_distance value 0 is a coincident, not a dimension; use the coincident constraint between the two points' },
  { name: 'zero point_distance_x', kind: 'point_distance_x', targets: ['$oxy', '$pxy'], value: 0, problem: null },
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
})
