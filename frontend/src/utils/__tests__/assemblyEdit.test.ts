// The assembly undo funnel's pure core. The hook and the headless session both
// call applyAssemblyEdit, so the push/no-op/fold decision cannot drift between
// the editor and a drive script (D11).

import { describe, it, expect } from 'vitest'
import type { AssemblyDoc } from '@/types/cad'
import { History } from '@/session/History'
import { applyAssemblyEdit, decideAssemblyMutation } from '../assemblyEdit'

function docWith(ids: string[]): AssemblyDoc {
  return { kind: 'assembly', features: ids.map(id => ({ id, kind: 'origin' as const })) }
}

function history(): History<AssemblyDoc> {
  return new History<AssemblyDoc>({ cloneDoc: d => structuredClone(d), cap: 100 })
}

describe('applyAssemblyEdit', () => {
  it('pushes one entry for a real change and returns the next doc', () => {
    const h = history()
    const pre = docWith(['a'])
    const next = docWith(['a', 'b'])
    const outcome = applyAssemblyEdit(h, pre, 'Add part', next, false)
    expect(outcome).toEqual({ decision: 'push', doc: next, pushed: true })
    expect(h.undoLength()).toBe(1)
    expect(h.undoLabels()).toEqual(['Add part'])
    // The entry is a snapshot of the pre-edit doc.
    expect(h.undoEntries()[0].doc).toEqual(pre)
  })

  it('does nothing for an equal document', () => {
    const h = history()
    const pre = docWith(['a'])
    const outcome = applyAssemblyEdit(h, pre, 'Add part', docWith(['a']), false)
    expect(outcome).toEqual({ decision: 'noop', doc: pre, pushed: false })
    expect(h.undoLength()).toBe(0)
  })

  it('does nothing when either side is null', () => {
    const h = history()
    expect(applyAssemblyEdit(h, null, 'Add part', docWith(['a']), false).decision).toBe('noop')
    expect(applyAssemblyEdit(h, docWith(['a']), 'Add part', null, false).decision).toBe('noop')
    expect(h.undoLength()).toBe(0)
  })

  it('folds without pushing when an editor session is open', () => {
    const h = history()
    const pre = docWith(['a'])
    const outcome = applyAssemblyEdit(h, pre, 'Edit mate', docWith(['a', 'b']), true)
    expect(outcome).toMatchObject({ decision: 'fold', pushed: false })
    expect(outcome.doc).toEqual(docWith(['a', 'b']))
    // The session pin owns the entry; the funnel pushed nothing.
    expect(h.undoLength()).toBe(0)
  })

  it('keeps the decision helper as the one rule', () => {
    expect(decideAssemblyMutation({ pre: docWith(['a']), next: docWith(['a']), sessionOpen: false })).toBe('noop')
    expect(decideAssemblyMutation({ pre: docWith(['a']), next: docWith(['a', 'b']), sessionOpen: false })).toBe('push')
    expect(decideAssemblyMutation({ pre: docWith(['a']), next: docWith(['a', 'b']), sessionOpen: true })).toBe('fold')
  })
})
