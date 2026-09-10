import { describe, it, expect } from 'vitest'
import {
  reduceEditingSubject,
  editingMateId,
  editingInstanceHandle,
  isSessionOpen,
  type EditingSubject,
} from '@/utils/assemblyEditingSubject'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'
import type { AssemblyDoc } from '@/types/cad'

function docWithSubject(): AssemblyDoc {
  return {
    kind: 'assembly',
    features: [
      { id: 'fp1', kind: 'part_instance', instance: {
        handle: 'a', doc_id: 'd-a', doc_rev: 1, transform: { ...IDENTITY_TRANSFORM }, visible: true,
      } },
      { id: 'm1', kind: 'mate', mate: {
        kind: 'fixed', ref_a: { part: 'a', anchor: 'x' }, ref_b: { part: 'a', anchor: 'y' },
      } },
    ],
  }
}

describe('reduceEditingSubject', () => {
  it('walks none -> instance -> mate -> none and replaces on each open', () => {
    let s: EditingSubject = { kind: 'none' }
    expect(editingInstanceHandle(s)).toBeNull()
    expect(editingMateId(s)).toBeNull()
    expect(isSessionOpen(s)).toBe(false)

    s = reduceEditingSubject(s, { type: 'open_instance', handle: 'a' })
    expect(s).toEqual({ kind: 'instance', handle: 'a' })
    expect(editingInstanceHandle(s)).toBe('a')
    expect(editingMateId(s)).toBeNull()
    expect(isSessionOpen(s)).toBe(true)

    // Opening a mate replaces the instance rather than appending a second subject.
    s = reduceEditingSubject(s, { type: 'open_mate', id: 'm1' })
    expect(s).toEqual({ kind: 'mate', id: 'm1' })
    expect(editingMateId(s)).toBe('m1')
    expect(editingInstanceHandle(s)).toBeNull()

    s = reduceEditingSubject(s, { type: 'close' })
    expect(s).toEqual({ kind: 'none' })
    expect(isSessionOpen(s)).toBe(false)
  })

  it('never reports both a mate and an instance at once', () => {
    const states: EditingSubject[] = [
      { kind: 'none' },
      reduceEditingSubject({ kind: 'none' }, { type: 'open_instance', handle: 'a' }),
      reduceEditingSubject({ kind: 'none' }, { type: 'open_mate', id: 'm1' }),
    ]
    for (const s of states) {
      expect(editingMateId(s) !== null && editingInstanceHandle(s) !== null).toBe(false)
    }
  })

  it('subject_removed clears an absent instance or mate and keeps a present one', () => {
    const doc = docWithSubject()
    const instance: EditingSubject = { kind: 'instance', handle: 'a' }
    const mate: EditingSubject = { kind: 'mate', id: 'm1' }

    expect(reduceEditingSubject(instance, { type: 'subject_removed', doc })).toBe(instance)
    expect(reduceEditingSubject(mate, { type: 'subject_removed', doc })).toBe(mate)

    const absentInstance: EditingSubject = { kind: 'instance', handle: 'ghost' }
    const absentMate: EditingSubject = { kind: 'mate', id: 'ghost' }
    expect(reduceEditingSubject(absentInstance, { type: 'subject_removed', doc })).toEqual({ kind: 'none' })
    expect(reduceEditingSubject(absentMate, { type: 'subject_removed', doc })).toEqual({ kind: 'none' })
  })

  it('subject_removed with no doc clears any open subject', () => {
    expect(reduceEditingSubject({ kind: 'instance', handle: 'a' }, { type: 'subject_removed', doc: null }))
      .toEqual({ kind: 'none' })
    expect(reduceEditingSubject({ kind: 'mate', id: 'm1' }, { type: 'subject_removed', doc: null }))
      .toEqual({ kind: 'none' })
  })
})
