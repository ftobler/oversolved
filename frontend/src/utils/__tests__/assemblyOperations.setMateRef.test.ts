// The set_mate_ref operation: the one mate reference write, shared by the
// editor's aim commit and the drive (D9). It folds into an open editor session
// like the parameter edit it rides with, and defers the solve while a chip is
// armed.

import { describe, it, expect } from 'vitest'
import type { AssemblyDoc, MateRef } from '@/types/cad'
import { ASSEMBLY_OPERATIONS, planAssemblyOperation } from '../assemblyOperations'
import { appendMate, findMate } from '../assemblyMutations'

const EMPTY: AssemblyDoc = { kind: 'assembly', features: [] }

const REF: MateRef = { part: 'left', anchor: 'a_left', anchor_descriptor: {
  geom_hash: '@u|abc', kind: 'plane', created_by: 'ex1', point: [0, 0, 0],
} }

function docWithMate(): AssemblyDoc {
  return appendMate(EMPTY, 'fixed', 'm1')
}

describe('set_mate_ref operation', () => {
  it('is the fold/defer cell with the pick label', () => {
    const def = ASSEMBLY_OPERATIONS.set_mate_ref
    expect(def).toMatchObject({ bake: false, undo: 'fold', solve: 'defer', label: 'Pick mate reference' })
  })

  it('writes the ref into the named field', () => {
    const plan = planAssemblyOperation('set_mate_ref', { id: 'm1', field: 'ref_b', ref: REF }, {
      doc: docWithMate(), transforms: {},
    })!
    expect(plan.changed).toBe(true)
    expect(findMate(plan.doc, 'm1')!.ref_b).toEqual(REF)
    expect(findMate(plan.doc, 'm1')!.ref_a).toEqual({ part: '', anchor: '' })
  })

  it('applies the captured orientation patch in the same step', () => {
    const plan = planAssemblyOperation('set_mate_ref', {
      id: 'm1', field: 'ref_a', ref: REF, patch: { flip: true, angle: 90 },
    }, { doc: docWithMate(), transforms: {} })!
    expect(findMate(plan.doc, 'm1')).toMatchObject({ ref_a: REF, flip: true, angle: 90 })
  })

  it('a patch value of undefined deletes the key', () => {
    const withAngle = appendMate(EMPTY, 'fixed', 'm1', { patch: { angle: 45 } })
    const plan = planAssemblyOperation('set_mate_ref', {
      id: 'm1', field: 'ref_a', ref: REF, patch: { angle: undefined },
    }, { doc: withAngle, transforms: {} })!
    expect('angle' in findMate(plan.doc, 'm1')!).toBe(false)
  })

  it('reports no change for a same-ref write', () => {
    const first = planAssemblyOperation('set_mate_ref', { id: 'm1', field: 'ref_a', ref: REF }, {
      doc: docWithMate(), transforms: {},
    })!
    const second = planAssemblyOperation('set_mate_ref', { id: 'm1', field: 'ref_a', ref: REF }, {
      doc: first.doc, transforms: {},
    })!
    expect(second.changed).toBe(false)
  })
})
