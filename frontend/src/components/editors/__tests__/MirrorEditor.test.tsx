// The mirror editor schema: one subject switch, the whole-body rows with Body,
// Keep Original and Merge, and the feature rows with the source chip and Target
// body. The source chip shares the pattern's refusal rule.
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, screen, act } from '@testing-library/react'
import { FeatureEditor } from '@/components/editors/FeatureEditor'
import { EDITOR_SCHEMAS, MIRROR_SCHEMA } from '@/components/editors/featureEditorSchemas'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { PartFeature } from '@/types/cad'
import type { PickFieldDef } from '@/components/editors/widgets/fieldTypes'

const FEATURES: PartFeature[] = [
  { id: 'ex1', kind: 'extrude', label: 'Extrude 1', extrude: { sketch: [], distance: 1 } },
  { id: 'rv1', kind: 'revolve', label: 'Revolve 1', revolve: { sketch: [], angle: 90 } },
  { id: 'fi1', kind: 'fillet', label: 'Fillet 1', fillet: { edges: [], radius: 1 } },
  { id: 'sk1', kind: 'sketch', label: 'Sketch 1', entities: [], initial: {} },
]

function makeFeature(over: Record<string, unknown> = {}): PartFeature {
  return {
    id: 'mi1',
    kind: 'mirror',
    label: 'Mirror',
    mirror: { subject: 'body', body: '', plane: '', ...over },
  } as unknown as PartFeature
}

function renderEditor(feature: PartFeature, onMutation = vi.fn()) {
  render(<FeatureEditor feature={feature} onMutation={onMutation} features={FEATURES} schema={MIRROR_SCHEMA} />)
  return onMutation
}

function labels(): (string | null)[] {
  return [...document.querySelectorAll('.feature-field-label')].map((n) => n.textContent)
}

const field = (key: string): PickFieldDef => {
  const found = MIRROR_SCHEMA.fields.find((f) => f.key === key)
  if (found === undefined) throw new Error(`no ${key} field`)
  return found as PickFieldDef
}

describe('MIRROR_SCHEMA', () => {
  it('is registered with its sub-key, defaults and field order', () => {
    expect(EDITOR_SCHEMAS.mirror).toBe(MIRROR_SCHEMA)
    expect(MIRROR_SCHEMA.subKey).toBe('mirror')
    expect(MIRROR_SCHEMA.defaults).toEqual({
      subject: 'body', body: '', source_features: [], plane: '', keep_original: true, merge: true,
    })
    expect(MIRROR_SCHEMA.fields.map((f) => f.key)).toEqual([
      'subject', 'body', 'source_features', 'target_body', 'plane', 'keep_original', 'merge',
    ])
  })

  it('shows the whole-body rows on the body subject', () => {
    renderEditor(makeFeature())
    const shown = labels()
    expect(shown).toEqual(expect.arrayContaining(['Part', 'Mirror Plane', 'Keep Original', 'Merge']))
    expect(shown).not.toContain('Source Features')
    expect(shown).not.toContain('Target part')
  })

  it('shows the feature rows on the feature subject', () => {
    renderEditor(makeFeature({ subject: 'feature', source_features: [] }))
    const shown = labels()
    expect(shown).toEqual(expect.arrayContaining(['Source Features', 'Target part', 'Mirror Plane']))
    expect(shown).not.toContain('Body')
    expect(shown).not.toContain('Keep Original')
    expect(shown).not.toContain('Merge')
  })

  it('shares the pattern source refusal, so a fillet row is refused too', () => {
    const source = field('source_features')
    expect(source.multi).toBe(true)
    expect(source.addMutationType).toBe('add_mirror_source')
    expect(source.addValueKey).toBe('sourceFeature')
    expect(source.removeMutationType).toBe('remove_mirror_source')
    expect(source.validatePick!('@ex1', FEATURES)).toBeNull()
    expect(source.validatePick!('@rv1', FEATURES)).toBeNull()
    expect(source.validatePick!('@fi1', FEATURES)).toContain('extrude, revolve or sweep')
    expect(source.validatePick!('@sk1', FEATURES)).toContain('extrude, revolve or sweep')
    expect(source.validatePick!('@body_ex1', FEATURES)).toContain('feature row')
    expect(source.validatePick!('@ex1/face/0', FEATURES)).toContain('feature row')
  })

  it('dispatches the dedicated mirror source pair from the chip', () => {
    const onMutation = renderEditor(makeFeature({ subject: 'feature', source_features: ['@ex1'] }))
    fireEvent.click(screen.getByText('Extrude 1'))
    act(() => {
      useSketchEditorStore.setState({ normalSelection: new Set(['@rv1']) })
    })
    expect(onMutation).toHaveBeenCalledWith({
      type: 'add_mirror_source', featureId: 'mi1', sourceFeature: '@rv1',
    })
    const removes = document.querySelectorAll('.feature-pick-chip-item-remove')
    fireEvent.click(removes[0])
    expect(onMutation).toHaveBeenCalledWith({
      type: 'remove_mirror_source', featureId: 'mi1', index: 0,
    })
  })

  it('writes the subject through the plain setter', () => {
    const onMutation = renderEditor(makeFeature())
    fireEvent.click(screen.getByRole('tab', { name: 'Feature' }))
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_mirror_field', featureId: 'mi1', field: 'subject', value: 'feature',
    })
  })
})
