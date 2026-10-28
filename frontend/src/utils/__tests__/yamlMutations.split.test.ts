import { describe, it, expect, vi } from 'vitest'
import type { PartDoc } from '@/types/cad'
import {
  applyAddSplit,
  applySetSplitField,
  applyAddSplitBody,
  applyRemoveSplitBody,
} from '@/utils/yamlMutations'
import { applyReorderPickField } from '@/utils/yamlMutations/partStyle'
import { createDocSession } from '@/session/DocSession'
import { createFakeSolveScheduler } from '@/session/__tests__/fakeSolveScheduler'
import { featureAt } from '@/testing/featureAccess'

const split0 = (doc: PartDoc) => featureAt(doc, 0, 'split').split

describe('applyAddSplit', () => {
  it('inserts a split with the above defaults', () => {
    const doc: PartDoc = {}
    applyAddSplit(doc, 'sp1')
    expect(doc.features).toHaveLength(1)
    expect(doc.features![0]).toMatchObject({ id: 'sp1', kind: 'split', label: 'Split' })
    expect(split0(doc)).toEqual({ bodies: [], plane: '', keep: 'above' })
  })

  it('copies the inline fields instead of aliasing the payload', () => {
    const bodies = ['@ex1']
    const doc: PartDoc = {}
    applyAddSplit(doc, 'sp1', 'Cut', bodies, '@pl1', 'below')
    expect(split0(doc)).toEqual({ bodies: ['@ex1'], plane: '@pl1', keep: 'below' })
    bodies.push('@ex2')
    expect(split0(doc).bodies).toEqual(['@ex1'])
  })

  it('lands at insertAt through the DocSession path', () => {
    // Two features, so the middle position proves insertAt is honoured and not
    // just "append at the end of a one-feature document". The handler appends
    // and the session moves the row, so only the session path exercises it.
    const cell: { current: PartDoc | null } = {
      current: {
        version: 1,
        kind: 'part',
        features: [{ id: 'sk1', kind: 'sketch' }, { id: 'sk2', kind: 'sketch' }],
      },
    }
    const session = createDocSession({
      cloneDoc: (source) => structuredClone(source),
      doc: { get: () => cell.current, set: (next) => { cell.current = next } },
      solve: createFakeSolveScheduler<PartDoc>(),
      solveResults: { get: () => ({}), set: () => undefined },
      editorFacts: () => ({ editingFeatureId: null, rollbackPosition: null }),
      dirtyFacts: () => ({ dirty: false, saves: 0, savedHash: null }),
    })
    session.execute({
      type: 'add_split', featureId: 'sp1', label: 'Split', bodies: ['@ex1'], plane: '@pl1', keep: 'both', insertAt: 1,
    })
    const doc = session.getDoc()!
    expect(doc.features!.map(f => f.id)).toEqual(['sk1', 'sp1', 'sk2'])
    expect(featureAt(doc, 1, 'split').split).toMatchObject({ keep: 'both' })
  })

  it('refuses an unknown keep value by name instead of storing it', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const doc: PartDoc = {}
    applyAddSplit(doc, 'sp1', undefined, ['@ex1'], '@pl1', 'top' as never)
    expect(warnSpy).toHaveBeenCalledWith(
      'applyAddSplit: unknown keep value "top"; use one of "above", "below", "both"',
    )
    expect(doc.features ?? []).toHaveLength(0)
    warnSpy.mockRestore()
  })
})

describe('applySetSplitField', () => {
  it('sets plane and keep', () => {
    const doc: PartDoc = { features: [{ id: 'sp1', kind: 'split', split: { bodies: [], plane: '' } }] }
    applySetSplitField(doc, 'sp1', 'plane', '@builtin_plane_top')
    applySetSplitField(doc, 'sp1', 'keep', 'both')
    expect(split0(doc).plane).toBe('@builtin_plane_top')
    expect(split0(doc).keep).toBe('both')
  })

  it('clears keep on an empty value and refuses an unknown field', () => {
    const doc: PartDoc = { features: [{ id: 'sp1', kind: 'split', split: { bodies: [], plane: '@pl1', keep: 'above' } }] }
    applySetSplitField(doc, 'sp1', 'keep', '')
    expect(split0(doc)).not.toHaveProperty('keep')
    applySetSplitField(doc, 'sp1', 'nonsense' as never, 1)
    expect(split0(doc)).not.toHaveProperty('nonsense')
  })

  it('warns by name on an unknown field through the shared setter', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const doc: PartDoc = { features: [{ id: 'sp1', kind: 'split', split: { bodies: [], plane: '@pl1' } }] }
    applySetSplitField(doc, 'sp1', 'nonsense' as never, 1)
    expect(warnSpy).toHaveBeenCalledWith('applySetSplitField: unknown split field "nonsense"')
    expect(split0(doc)).not.toHaveProperty('nonsense')
    warnSpy.mockRestore()
  })

  it('warns and no-ops on a wrong kind', () => {
    const doc: PartDoc = { features: [{ id: 'sk1', kind: 'sketch' }] }
    const before = structuredClone(doc)
    applySetSplitField(doc, 'sk1', 'plane', '@pl1')
    expect(doc).toEqual(before)
  })
})

describe('add_split_body / remove_split_body', () => {
  const withSplit = (): PartDoc => ({
    features: [{ id: 'sp1', kind: 'split', split: { bodies: ['@ex1'], plane: '@pl1' } }],
  })

  it('appends a body and toggles a duplicate back out', () => {
    const doc = withSplit()
    applyAddSplitBody(doc, 'sp1', '@ex2')
    expect(split0(doc).bodies).toEqual(['@ex1', '@ex2'])
    applyAddSplitBody(doc, 'sp1', '@ex2')
    expect(split0(doc).bodies).toEqual(['@ex1'])
  })

  it('removes by index and refuses an out-of-range index', () => {
    const doc = withSplit()
    applyAddSplitBody(doc, 'sp1', '@ex2')
    applyRemoveSplitBody(doc, 'sp1', 0)
    expect(split0(doc).bodies).toEqual(['@ex2'])
    applyRemoveSplitBody(doc, 'sp1', 5)
    expect(split0(doc).bodies).toEqual(['@ex2'])
  })

  it('reorders the bodies pick list', () => {
    const doc = withSplit()
    applyAddSplitBody(doc, 'sp1', '@ex2')
    applyReorderPickField(doc, 'sp1', 'bodies', 0, 1)
    expect(split0(doc).bodies).toEqual(['@ex2', '@ex1'])
  })
})
