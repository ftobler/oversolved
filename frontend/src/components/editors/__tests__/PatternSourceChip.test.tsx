// The Source Features chip behaves the same on all four pattern kinds: picking
// an extrude row dispatches add_pattern_source and the chip shows it, and a
// sketch row is refused with the source rule's own reason. The bug this pins
// was the applier resolving only linear and circular, so the instance and curve
// editors' Feature mode looked wired and did nothing.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, act, screen, cleanup } from '@testing-library/react'
import { FeatureEditor, type FeatureEditorSchema } from '@/components/editors/FeatureEditor'
import {
  CIRCULAR_PATTERN_SCHEMA, CURVE_PATTERN_SCHEMA, EDITOR_SCHEMAS, INSTANCE_PATTERN_SCHEMA,
  LINEAR_PATTERN_SCHEMA, PATTERN_SOURCE_FIELDS,
} from '@/components/editors/featureEditorSchemas'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { PATTERN_KINDS, type PartFeature, type PatternKind } from '@/types/cad'

const SCHEMAS: Record<PatternKind, FeatureEditorSchema> = {
  linear_pattern: LINEAR_PATTERN_SCHEMA,
  circular_pattern: CIRCULAR_PATTERN_SCHEMA,
  curve_pattern: CURVE_PATTERN_SCHEMA,
  instance_pattern: INSTANCE_PATTERN_SCHEMA,
}

const REFUSAL = 'a pattern or mirror source is an extrude, revolve or sweep'

function makeFeature(kind: PatternKind, over: Record<string, unknown> = {}): PartFeature {
  return {
    id: 'pt1',
    kind,
    label: 'Pattern',
    [kind]: { subject: 'feature', source_features: [], ...over },
  } as unknown as PartFeature
}

/** The tree rows the chip reads: two legal sources, one sketch, and the edited
 *  pattern last so every source is an earlier feature. */
function featuresFor(kind: PatternKind): PartFeature[] {
  return [
    { id: 'ex1', kind: 'extrude', label: 'Extrude 1', extrude: { sketch: [], distance: 1 } },
    { id: 'rv1', kind: 'revolve', label: 'Revolve 1', revolve: { sketch: [], angle: 90 } },
    { id: 'sk1', kind: 'sketch', label: 'Sketch 1', entities: [], initial: {} },
    { id: 'pt1', kind, label: 'Pattern', [kind]: { subject: 'feature' } },
  ] as unknown as PartFeature[]
}

function sourceChip(): HTMLElement {
  const row = [...document.querySelectorAll<HTMLElement>('.feature-field-row')]
    .find(r => r.querySelector('.feature-field-label')?.textContent === 'Source Features')
  if (row === undefined) throw new Error('no Source Features row')
  return row.querySelector<HTMLElement>('.feature-pick-chip')!
}

/** A tree row click lands in normalSelection; the armed field consumes it. */
function pick(selectionId: string): void {
  act(() => { useSketchEditorStore.setState({ normalSelection: new Set([selectionId]) }) })
}

beforeEach(() => {
  cleanup()
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    chipOwnedSelection: new Set(),
    activePickField: null,
    modeStack: [],
  })
})

describe('pattern editor schema registration', () => {
  it('registers a schema for every PATTERN_KINDS entry under its own kind', () => {
    for (const kind of PATTERN_KINDS) {
      const schema = EDITOR_SCHEMAS[kind]
      expect(schema, kind).toBeDefined()
      expect(schema.subKey, kind).toBe(kind)
      // The shared source rows lead every pattern schema, so a kind cannot
      // arrive with a body-only editor.
      expect(schema.fields.slice(0, PATTERN_SOURCE_FIELDS.length), kind).toEqual(PATTERN_SOURCE_FIELDS)
    }
  })
})

describe.each(PATTERN_KINDS)('%s source chip', (kind) => {
  it('dispatches add_pattern_source for a picked extrude row', () => {
    const onMutation = vi.fn()
    render(
      <FeatureEditor
        feature={makeFeature(kind)}
        onMutation={onMutation}
        features={featuresFor(kind)}
        schema={SCHEMAS[kind]}
      />,
    )
    fireEvent.click(sourceChip())
    pick('@ex1')
    expect(onMutation).toHaveBeenCalledWith({
      type: 'add_pattern_source', featureId: 'pt1', sourceFeature: '@ex1',
    })
  })

  it('shows a stored source as its feature label', () => {
    render(
      <FeatureEditor
        feature={makeFeature(kind, { source_features: ['@ex1'] })}
        onMutation={vi.fn()}
        features={featuresFor(kind)}
        schema={SCHEMAS[kind]}
      />,
    )
    expect(sourceChip().querySelector('.feature-pick-chip-item-text')?.textContent).toBe('Extrude 1')
  })

  it('shows the source rule reason for a refused sketch pick and dispatches nothing', () => {
    const onMutation = vi.fn()
    render(
      <FeatureEditor
        feature={makeFeature(kind)}
        onMutation={onMutation}
        features={featuresFor(kind)}
        schema={SCHEMAS[kind]}
      />,
    )
    fireEvent.click(sourceChip())
    pick('@sk1')
    expect(onMutation).not.toHaveBeenCalled()
    expect(screen.getByText(REFUSAL, { exact: false })).not.toBeNull()
  })
})
