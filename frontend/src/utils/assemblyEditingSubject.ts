// Which subject the assembly editor is currently editing, as a sum type. The
// page used to hold a mate id and an instance handle in two independent
// useState values and keep them mutually exclusive by hand at every set/clear
// site; a single tagged value makes "two subjects at once" unrepresentable.
//
// Pure and React free, so the store actions (open/close) and deleteSelected can
// all be the same one-line reduction and the invariant is unit testable.

import type { AssemblyDoc } from '@/types/cad'
import { findInstance, findMate } from '@/utils/assemblyMutations'

export type EditingSubject =
  | { kind: 'none' }
  | { kind: 'instance'; handle: string }
  | { kind: 'mate'; id: string }

export type EditingAction =
  // Opening a subject replaces whatever was there; a subject is never appended.
  | { type: 'open_instance'; handle: string }
  | { type: 'open_mate'; id: string }
  | { type: 'close' }
  // A doc change (undo, reload, live edit) can retire the edited subject. Clear
  // only when the named instance or mate is absent, so an unrelated edit that
  // leaves the subject in place does not close its editor.
  | { type: 'subject_removed'; doc: AssemblyDoc | null }

export function reduceEditingSubject(s: EditingSubject, a: EditingAction): EditingSubject {
  switch (a.type) {
    case 'open_instance':
      return { kind: 'instance', handle: a.handle }
    case 'open_mate':
      return { kind: 'mate', id: a.id }
    case 'close':
      return { kind: 'none' }
    case 'subject_removed': {
      if (s.kind === 'none') return s
      if (!a.doc) return { kind: 'none' }
      if (s.kind === 'instance' && !findInstance(a.doc, s.handle)) return { kind: 'none' }
      if (s.kind === 'mate' && !findMate(a.doc, s.id)) return { kind: 'none' }
      return s
    }
  }
}

export function editingMateId(s: EditingSubject): string | null {
  return s.kind === 'mate' ? s.id : null
}

export function editingInstanceHandle(s: EditingSubject): string | null {
  return s.kind === 'instance' ? s.handle : null
}

export function isSessionOpen(s: EditingSubject): boolean {
  return s.kind !== 'none'
}
