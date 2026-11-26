// The chip's Remove button runs a named operation, not a raw ref write: the
// clear is one undo step, and undoing it restores the full ref including the
// descriptor that lets a cold solve re-find the element.

import { describe, it, expect, beforeEach } from 'vitest'
import type { AssemblyDoc, MateRef } from '@/types/cad'
import { ASSEMBLY_OPERATIONS, planAssemblyOperation } from '../assemblyOperations'
import { appendMate, findMate, setMateRef } from '../assemblyMutations'
import { assemblyHistory } from '@/stores/assemblyHistory'
import { applyAssemblyEdit } from '../assemblyEdit'
import { isMateRefEmpty } from '../mateKinds'

const EMPTY: AssemblyDoc = { kind: 'assembly', features: [] }

const REF_A: MateRef = {
  part: 'left', anchor: 'a_left', anchor_descriptor: {
    geom_hash: '@u|a', kind: 'plane', created_by: 'ex1', point: [0, 0, 0],
  },
}
const REF_B: MateRef = {
  part: 'right', anchor: 'b_right', anchor_descriptor: {
    geom_hash: '@u|b', kind: 'cylinder', created_by: 'ex2', point: [5, 0, 0],
  },
}

function docWithBothRefs(): AssemblyDoc {
  const base = appendMate(EMPTY, 'fixed', 'm1', { patch: { angle: 45 } })
  return setMateRef(setMateRef(base, 'm1', 'ref_a', REF_A), 'm1', 'ref_b', REF_B)
}

function clearRef(doc: AssemblyDoc, field: 'ref_a' | 'ref_b') {
  return planAssemblyOperation('clear_mate_ref', { id: 'm1', field }, { doc, transforms: {} })!
}

beforeEach(() => { assemblyHistory.clear() })

describe('clear_mate_ref operation', () => {
  it('is its own one-shot undo step and re-solves', () => {
    expect(ASSEMBLY_OPERATIONS.clear_mate_ref).toMatchObject({
      bake: false, undo: 'one-shot', solve: 'solve', label: 'Clear mate reference',
    })
  })

  it('clears only the named slot, keeping the other ref and the params', () => {
    const plan = clearRef(docWithBothRefs(), 'ref_b')
    expect(plan.changed).toBe(true)
    const mate = findMate(plan.doc, 'm1')!
    expect(isMateRefEmpty(mate.ref_b)).toBe(true)
    expect(mate.ref_a).toEqual(REF_A)
    expect(mate.angle).toBe(45)
  })

  it('records one undo entry that restores the cleared ref exactly', () => {
    const doc = docWithBothRefs()
    const plan = clearRef(doc, 'ref_b')
    const outcome = applyAssemblyEdit(assemblyHistory, doc, plan.label, plan.doc, false)
    expect(outcome.pushed).toBe(true)
    expect(assemblyHistory.undoLength()).toBe(1)
    expect(assemblyHistory.undoEntries()[0].label).toBe('Clear mate reference')

    const restored = assemblyHistory.undo(doc)!
    expect(restored.doc).toEqual(doc)
    expect(findMate(restored.doc, 'm1')!.ref_b).toEqual(REF_B)
    expect(findMate(restored.doc, 'm1')!.ref_b.anchor_descriptor).toEqual(REF_B.anchor_descriptor)
  })

  it('is a no-op on a slot that is already empty', () => {
    const doc = appendMate(EMPTY, 'fixed', 'm1')
    expect(clearRef(doc, 'ref_b').changed).toBe(false)
  })
})
