// Rebinding a part instance to another part document: the repair for an
// instance whose doc_id resolves to nothing. The mutation is the placement's
// identity change only; mates are by handle, so their rows stay as they are and
// the solver's descriptor fallback decides whether they survive.

import { describe, it, expect } from 'vitest'
import type { AssemblyDoc } from '@/types/cad'
import { History } from '@/session/History'
import { applyAssemblyEdit } from '@/utils/assemblyEdit'
import {
  findInstance,
  mateFeatures,
  setInstancePartDoc,
} from '@/utils/assemblyMutations'
import {
  planAssemblyOperation,
  runAssemblyOperation,
  type AssemblyOperationHost,
} from '@/utils/assemblyOperations'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'

function docWith(leftDocId = 'old-part'): AssemblyDoc {
  return {
    kind: 'assembly',
    features: [
      {
        id: 'inst_left',
        kind: 'part_instance',
        instance: {
          handle: 'left',
          doc_id: leftDocId,
          doc_rev: 4,
          transform: { ...IDENTITY_TRANSFORM, tx: 12, ty: 3, tz: 7 },
          visible: false,
          fixed: true,
        },
      },
      {
        id: 'm1',
        kind: 'mate',
        mate: {
          kind: 'fixed',
          ref_a: { part: 'left', anchor: 'a', anchor_descriptor: { geom_hash: '@gdf|a', created_by: 'ex1', kind: 'plane', point: [1, 2, 3] } },
          ref_b: { part: 'right', anchor: 'b' },
        },
      },
    ],
  }
}

describe('setInstancePartDoc', () => {
  it('keeps the handle, pose, visibility and fixed flag and resets doc_rev', () => {
    const before = findInstance(docWith(), 'left')!
    const next = setInstancePartDoc(docWith(), 'left', 'new-part')
    const after = findInstance(next, 'left')!
    expect(after.handle).toBe(before.handle)
    expect(after.transform).toEqual(before.transform)
    expect(after.visible).toBe(false)
    expect(after.fixed).toBe(true)
    expect(after.doc_id).toBe('new-part')
    // The old part's revision says nothing about the new one.
    expect(after.doc_rev).toBe(0)
    expect(before.doc_id).toBe('old-part')
  })

  it('leaves every mate ref row alone: refs name the instance by handle', () => {
    const before = mateFeatures(docWith())
    const after = mateFeatures(setInstancePartDoc(docWith(), 'left', 'new-part'))
    expect(after).toEqual(before)
  })

  it('is a no-op for a handle the document does not carry', () => {
    const doc = docWith()
    expect(setInstancePartDoc(doc, 'ghost', 'new-part')).toEqual(doc)
  })
})

describe('set_part_doc operation', () => {
  it('is a structural one-shot that re-solves and labels the undo step', () => {
    const plan = planAssemblyOperation(
      'set_part_doc',
      { handle: 'left', docId: 'new-part' },
      { doc: docWith(), transforms: {} },
    )!
    expect(plan.label).toBe('Set part document')
    expect(plan.undo).toBe('one-shot')
    expect(plan.solve).toBe('solve')
    expect(plan.changed).toBe(true)
    expect(findInstance(plan.doc, 'left')!.doc_id).toBe('new-part')
  })

  it('refuses a doc_id that is not a live part entry, with a named cause', () => {
    expect(() => planAssemblyOperation(
      'set_part_doc',
      { handle: 'left', docId: 'ghost' },
      { doc: docWith(), transforms: {}, knownPartIds: new Set(['new-part']) },
    )).toThrow(/not a live entry in this workspace: ghost/)
  })

  it('refuses an empty doc_id with a named cause', () => {
    expect(() => planAssemblyOperation(
      'set_part_doc',
      { handle: 'left', docId: '' },
      { doc: docWith(), transforms: {} },
    )).toThrow(/non-empty part doc_id/)
  })

  it('refuses pointing the instance at the assembly that owns it', () => {    expect(() => planAssemblyOperation(
      'set_part_doc',
      { handle: 'left', docId: 'assembly-1' },
      {
        doc: docWith(), transforms: {},
        knownPartIds: new Set(['assembly-1']), assemblyDocId: 'assembly-1',
      },
    )).toThrow(/cannot point at the assembly it belongs to: assembly-1/)
  })

  it('undo restores the previous doc_id through the edit funnel', () => {
    const history = new History<AssemblyDoc>({ cloneDoc: d => structuredClone(d), cap: 100 })
    let current = docWith()
    const host: AssemblyOperationHost = {
      doc: current,
      transforms: {},
      knownPartIds: new Set(['new-part']),
      mutateSession: () => { throw new Error('set_part_doc must be one-shot') },
      mutateOneShot: (label, fn) => {
        const next = fn(current)
        const outcome = applyAssemblyEdit(history, current, label, next, false)
        if (outcome.doc) current = outcome.doc
      },
      requestSolve: () => undefined,
      requestSolveOrDefer: () => undefined,
    }
    runAssemblyOperation('set_part_doc', { handle: 'left', docId: 'new-part' }, host)
    expect(findInstance(current, 'left')!.doc_id).toBe('new-part')
    expect(history.undoLabels()).toEqual(['Set part document'])

    const undone = history.undo(current)!
    current = undone.doc
    expect(findInstance(current, 'left')!.doc_id).toBe('old-part')
  })
})
