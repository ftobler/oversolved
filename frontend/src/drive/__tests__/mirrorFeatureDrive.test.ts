// The mirror's feature subject at the drive boundary: the whole-body flags are
// refused by name, the inline add stores the subject's own fields, and the
// dedicated source chip pair edits the mirror sub-dict.
import { describe, it, expect } from 'vitest'
import { validateMutation } from '../mutationCatalog'
import { applyAddMirror, applyAddMirrorSource, applyRemoveMirrorSource, applySetMirrorField } from '@/utils/yamlMutations'
import { featureFieldNames } from '@/persistence/partDocSchema'
import { loadPartDoc } from '@/persistence/docSchema'
import { makeDoc } from '@/utils/core/testFixture'
import type { PartDoc } from '@/types/cad'

const featureMirrorDoc = (): PartDoc => makeDoc({
  id: 'mi1', kind: 'mirror', label: 'Mirror',
  mirror: { subject: 'feature', source_features: ['@ex1'], plane: '@builtin_plane_top' },
})

const partMirrorDoc = (): PartDoc => makeDoc({
  id: 'mi1', kind: 'mirror', label: 'Mirror',
  mirror: { subject: 'body', body: '@body_ex1', plane: '@builtin_plane_top', keep_original: true, merge: true },
})

describe('mirror feature subject at the drive boundary', () => {
  it('lists the subject fields as authored mirror fields', () => {
    expect(featureFieldNames('mirror')).toEqual(expect.arrayContaining([
      'subject', 'body', 'source_features', 'target_body', 'plane', 'keep_original', 'merge',
    ]))
  })

  it('refuses the whole-body flags on an inline feature mirror by name', () => {
    for (const field of ['keep_original', 'merge']) {
      const result = validateMutation(
        { type: 'add_mirror', featureId: 'mi1', subject: 'feature', [field]: true } as never,
        { doc: makeDoc() },
      )
      expect(result, field).toMatchObject({ ok: false, error: { code: 'invalid-mutation' } })
      if (result.ok) continue
      expect(result.error.message).toContain(`"${field}" means nothing on a feature mirror`)
      expect(result.error.message).toContain('the original always stays')
    }
  })

  it('refuses the whole-body flags on a stored feature mirror', () => {
    const result = validateMutation(
      { type: 'set_mirror_field', featureId: 'mi1', field: 'keep_original', value: false },
      { doc: featureMirrorDoc() },
    )
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-mutation' } })
    if (result.ok) return
    expect(result.error.message).toContain('means nothing on feature mirror "mi1"')
    // The same field is a plain edit on a body mirror.
    expect(validateMutation(
      { type: 'set_mirror_field', featureId: 'mi1', field: 'keep_original', value: false },
      { doc: partMirrorDoc() },
    )).toMatchObject({ ok: true })
  })

  it('stores a feature mirror without the body-only keys', () => {
    const doc = makeDoc()
    applyAddMirror(doc, 'mi2', undefined, {
      subject: 'feature', source_features: ['@ex1'], plane: '@builtin_plane_top',
    })
    const feature = doc.features?.at(-1)
    expect(feature?.kind).toBe('mirror')
    if (feature?.kind !== 'mirror') return
    expect(feature.mirror).toEqual({
      subject: 'feature', source_features: ['@ex1'], plane: '@builtin_plane_top',
    })
  })

  it('clears the body-only flags when the subject switches to feature', () => {
    const doc = partMirrorDoc()
    applySetMirrorField(doc, 'mi1', 'subject', 'feature')
    const feature = doc.features?.find((candidate) => candidate.id === 'mi1')
    if (feature?.kind !== 'mirror') throw new Error('mirror row lost')
    expect(feature.mirror.subject).toBe('feature')
    expect(feature.mirror.keep_original).toBeUndefined()
    expect(feature.mirror.merge).toBeUndefined()
    // The body pick survives, so switching back restores it.
    expect(feature.mirror.body).toBe('@body_ex1')
  })

  it('refuses to write a body-only flag while the subject is a feature', () => {
    const doc = featureMirrorDoc()
    const before = JSON.stringify(doc)
    applySetMirrorField(doc, 'mi1', 'merge', false)
    expect(JSON.stringify(doc)).toBe(before)
  })

  it('toggles and removes sources through the dedicated pair', () => {
    const doc = featureMirrorDoc()
    applyAddMirrorSource(doc, 'mi1', '@ex2')
    let mirror = doc.features?.find((candidate) => candidate.id === 'mi1')
    if (mirror?.kind !== 'mirror') throw new Error('mirror row lost')
    expect(mirror.mirror.source_features).toEqual(['@ex1', '@ex2'])
    // Re-picking a source already in the list drops it again.
    applyAddMirrorSource(doc, 'mi1', '@ex1')
    mirror = doc.features?.find((candidate) => candidate.id === 'mi1')
    if (mirror?.kind !== 'mirror') throw new Error('mirror row lost')
    expect(mirror.mirror.source_features).toEqual(['@ex2'])
    applyRemoveMirrorSource(doc, 'mi1', 0)
    mirror = doc.features?.find((candidate) => candidate.id === 'mi1')
    if (mirror?.kind !== 'mirror') throw new Error('mirror row lost')
    expect(mirror.mirror.source_features).toEqual([])
  })

  it('loads a feature mirror that carries no body', () => {
    const loaded = loadPartDoc({
      version: 9,
      kind: 'part',
      features: [
        { id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front', entities: [], initial: {} },
        featureMirrorDoc().features!.find((feature) => feature.id === 'mi1'),
      ],
    })
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    const mirror = loaded.doc.features?.find((feature) => feature.id === 'mi1')
    if (mirror?.kind !== 'mirror') throw new Error('mirror row lost')
    expect(mirror.mirror.subject).toBe('feature')
    expect(mirror.mirror.body).toBeUndefined()
  })
})
