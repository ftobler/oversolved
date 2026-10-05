// T1: the pure selection accessor and the subject union. No store, no viewport.

import { describe, it, expect } from 'vitest'
import { readSelection, type AssemblySubject } from '@/utils/assemblySelection'

describe('readSelection', () => {
  it('reads a part subject into the parts set and leaves the mate null', () => {
    const view = readSelection({ kind: 'part', handle: 'h1' }, new Set(['e1']))
    expect(view.parts).toEqual(new Set(['h1']))
    expect(view.mate).toBeNull()
    expect(view.entities).toEqual(new Set(['e1']))
  })

  it('reads a mate subject into the mate slot and leaves the parts set empty', () => {
    const view = readSelection({ kind: 'mate', id: 'fm1' }, new Set())
    expect(view.parts.size).toBe(0)
    expect(view.mate).toBe('fm1')
  })

  it('reads a cleared subject as nothing selected', () => {
    const view = readSelection(null, new Set(['e1']))
    expect(view.parts.size).toBe(0)
    expect(view.mate).toBeNull()
    expect(view.entities).toEqual(new Set(['e1']))
  })

  it('never lets a part and a mate be present at once', () => {
    // The union makes this the only constructible shape: there is one subject
    // slot, so a reader cannot observe both populated.
    const subjects: Array<AssemblySubject | null> = [
      null,
      { kind: 'part', handle: 'h1' },
      { kind: 'mate', id: 'fm1' },
    ]
    for (const subject of subjects) {
      const view = readSelection(subject, new Set())
      expect(view.parts.size + (view.mate === null ? 0 : 1)).toBeLessThanOrEqual(1)
    }
  })
})
