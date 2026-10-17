import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import {
  applyAddShell,
  applySetShellField,
  applyAddShellFace,
  applyRemoveShellFace,
} from '@/utils/yamlMutations'
import { mutationHandlers } from '@/hooks/mutationDispatch'
import { featureAt } from '@/testing/featureAccess'

const shell0 = (doc: PartDoc) => featureAt(doc, 0, 'shell').shell

describe('applyAddShell', () => {
  it('appends a shell with the inward defaults', () => {
    const doc: PartDoc = {}
    applyAddShell(doc, 'sh1')
    expect(doc.features).toHaveLength(1)
    expect(shell0(doc)).toEqual({ faces: [], thickness: 1, direction: 'inward' })
    expect(doc.features![0]).toMatchObject({ id: 'sh1', kind: 'shell', label: 'Shell' })
  })

  it('honours a label', () => {
    const doc: PartDoc = {}
    applyAddShell(doc, 'sh1', 'My Shell')
    expect(doc.features![0].label).toBe('My Shell')
  })
})

describe('applySetShellField', () => {
  it('writes a field and clears it on empty', () => {
    const doc: PartDoc = { features: [{ id: 'sh1', kind: 'shell', shell: { faces: [], thickness: 1 } }] }
    applySetShellField(doc, 'sh1', 'thickness', 3)
    expect(shell0(doc).thickness).toBe(3)
    applySetShellField(doc, 'sh1', 'direction', '')
    expect(shell0(doc)).not.toHaveProperty('direction')
  })

  it('refuses a non-finite thickness', () => {
    const doc: PartDoc = { features: [{ id: 'sh1', kind: 'shell', shell: { faces: [], thickness: 1 } }] }
    applySetShellField(doc, 'sh1', 'thickness', NaN)
    expect(shell0(doc).thickness).toBe(1)
  })

  it('warns and no-ops on a wrong kind', () => {
    const doc: PartDoc = { features: [{ id: 'sk1', kind: 'sketch' }] }
    const before = structuredClone(doc)
    applySetShellField(doc, 'sk1', 'thickness', 3)
    expect(doc).toEqual(before)
  })
})

describe('applyAddShellFace toggle', () => {
  it('adds a new face query', () => {
    const doc: PartDoc = { features: [{ id: 'sh1', kind: 'shell', shell: { faces: ['?f1'], thickness: 1 } }] }
    applyAddShellFace(doc, 'sh1', '?f2')
    expect(shell0(doc).faces).toEqual(['?f1', '?f2'])
  })

  it('removes an existing face query (toggle)', () => {
    const doc: PartDoc = { features: [{ id: 'sh1', kind: 'shell', shell: { faces: ['?f1', '?f2'], thickness: 1 } }] }
    applyAddShellFace(doc, 'sh1', '?f1')
    expect(shell0(doc).faces).toEqual(['?f2'])
  })

  it('does nothing if shell is undefined', () => {
    const doc: PartDoc = { features: [{ id: 'sh1', kind: 'sketch' }] }
    const before = structuredClone(doc)
    applyAddShellFace(doc, 'sh1', '?f1')
    expect(doc).toEqual(before)
  })
})

describe('applyRemoveShellFace', () => {
  it('removes the face at the given index', () => {
    const doc: PartDoc = { features: [{ id: 'sh1', kind: 'shell', shell: { faces: ['f0', 'f1', 'f2'], thickness: 1 } }] }
    applyRemoveShellFace(doc, 'sh1', 1)
    expect(shell0(doc).faces).toEqual(['f0', 'f2'])
  })

  it('ignores an out-of-range index', () => {
    const doc: PartDoc = { features: [{ id: 'sh1', kind: 'shell', shell: { faces: ['f0'], thickness: 1 } }] }
    applyRemoveShellFace(doc, 'sh1', 5)
    expect(shell0(doc).faces).toEqual(['f0'])
  })
})

describe('shell mutations through the dispatch table', () => {
  it('applies add_shell and add_shell_face through mutationHandlers', () => {
    const doc: PartDoc = {}
    mutationHandlers.add_shell(doc, { type: 'add_shell', featureId: 'sh1', label: 'Shell' })
    mutationHandlers.add_shell_face(doc, { type: 'add_shell_face', featureId: 'sh1', faceQuery: '?f1' })
    mutationHandlers.set_shell_field(doc, { type: 'set_shell_field', featureId: 'sh1', field: 'thickness', value: 2 })
    expect(shell0(doc)).toEqual({ faces: ['?f1'], thickness: 2, direction: 'inward' })
  })
})
