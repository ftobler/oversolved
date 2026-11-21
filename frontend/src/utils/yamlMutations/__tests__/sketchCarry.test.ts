// The one carry rule behind pattern_entities and the clipboard copy, table by
// table. The pattern keeps `fixed` (and transforms its override); a copy breaks
// it, per the user's rule. Everything reaching outside the copied set is broken
// for both, and projections are never carried.

import { describe, it, expect } from 'vitest'
import type { PartConstraint } from '@/types/cad'
import { carryConstraints, type CarryPolicy } from '@/utils/yamlMutations/sketchCarry'

const SOURCES = ['a', 'b']

const CONSTRAINT_KINDS = [
  'internal',
  'outside',
  'fixed',
  'projection',
  'group_all',
  'group_out',
  'sugar',
] as const

const CONSTRAINTS: PartConstraint[] = [
  { id: 'internal', kind: 'coincident', a: '$aend', b: '$bstart' },
  { id: 'outside', kind: 'point_distance', a: '$astart', b: '$outside', value: 5 },
  { id: 'fixed', kind: 'fixed', target: '$a' },
  { id: 'projection', kind: 'projection', target: '$a', source: '?@body_ex1:edge:1' },
  { id: 'group_all', kind: 'group', refs: ['$a', '$b'] },
  { id: 'group_out', kind: 'group', refs: ['$a', '$outside'] },
  // A refs-only sugar row has no single-ref operand; it is dropped whole.
  { id: 'sugar', kind: 'ngon', refs: ['$a', '$b'] },
]

const carriedIds = (policy: CarryPolicy): string[] =>
  carryConstraints(CONSTRAINTS, SOURCES, policy, null).templates.map(t => t.constraint.id).sort()

describe('carryConstraints policy table', () => {
  it('the pattern keeps its own shape rule', () => {
    expect(carriedIds('pattern')).toEqual(['fixed', 'group_all', 'internal'])
    const { report } = carryConstraints(CONSTRAINTS, SOURCES, 'pattern', null)
    expect(report).toEqual({ fixed: 0, outside: 0 })
  })

  it('a copy breaks fixed and every outside anchor, counting both', () => {
    expect(carriedIds('copy')).toEqual(['group_all', 'internal'])
    const { report } = carryConstraints(CONSTRAINTS, SOURCES, 'copy', null)
    // fixed + outside + projection + group_out + sugar.
    expect(report).toEqual({ fixed: 1, outside: 4 })
  })

  it.each([
    ['internal', true, true],
    ['outside', false, false],
    ['fixed', true, false],
    ['projection', false, false],
    ['group_all', true, true],
    ['group_out', false, false],
    ['sugar', false, false],
  ] as const)('row %s: pattern %s, copy %s', (id, pattern, copy) => {
    const inPattern = carriedIds('pattern').includes(id)
    const inCopy = carriedIds('copy').includes(id)
    expect(inPattern).toBe(pattern)
    expect(inCopy).toBe(copy)
  })

  it('resolves each operand to the source and its vertex suffix', () => {
    const { templates } = carryConstraints(CONSTRAINTS, SOURCES, 'pattern', null)
    const internal = templates.find(t => t.constraint.id === 'internal')!
    expect(internal.operands).toEqual([
      { field: 'a', sourceId: 'a', key: 'end', prefix: '$' },
      { field: 'b', sourceId: 'b', key: 'start', prefix: '$' },
    ])
    const group = templates.find(t => t.constraint.id === 'group_all')!
    expect(group.groupRefs?.map(ref => ref.sourceId)).toEqual(['a', 'b'])
  })

  it('leaves a constraint unrelated to the copied set alone, uncounted', () => {
    const unrelated: PartConstraint[] = [{ id: 'x', kind: 'coincident', a: '$p', b: '$q' }]
    expect(carryConstraints(unrelated, SOURCES, 'copy', null)).toEqual({
      templates: [], report: { fixed: 0, outside: 0 },
    })
  })

  it('names every table row exactly once', () => {
    expect([...new Set(CONSTRAINTS.map(c => c.id))].sort()).toEqual([...CONSTRAINT_KINDS].sort())
  })
})
