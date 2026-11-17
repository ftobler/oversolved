// The instance pattern's Points picker: one multi pick after the source rows,
// no target-form select and no separate sketch field. A sketch row is a target
// that expands to its points, so the hint numbers the expanded list the way the
// kernel does and a picked vertex joins the same list.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, act, cleanup } from '@testing-library/react'
import { FeatureEditor } from '@/components/editors/FeatureEditor'
import { INSTANCE_PATTERN_SCHEMA, PATTERN_SOURCE_FIELDS } from '@/components/editors/featureEditorSchemas'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { PartFeature } from '@/types/cad'
import type { PickFieldDef, TextFieldDef } from '@/components/editors/widgets/fieldTypes'

const FEATURES: PartFeature[] = [
  { id: 'ex1', kind: 'extrude', label: 'Extrude 1', extrude: { sketch: [], distance: 1 } },
  {
    id: 'sk1', kind: 'sketch', label: 'Sketch 1',
    entities: [
      { id: 'p1', kind: 'point' },
      { id: 'c1', kind: 'circle' },
      { id: 'p2', kind: 'point' },
      { id: 'p3', kind: 'point', construction: true },
    ],
    initial: {},
  },
  { id: 'ip1', kind: 'instance_pattern', label: 'Instance Pattern', instance_pattern: {} },
] as unknown as PartFeature[]

function makeFeature(over: Record<string, unknown> = {}): PartFeature {
  return {
    id: 'ip1',
    kind: 'instance_pattern',
    label: 'Instance Pattern',
    instance_pattern: { subject: 'body', source_body: '@body_ex1', ...over },
  } as unknown as PartFeature
}

function renderEditor(feature: PartFeature, onMutation = vi.fn()) {
  render(
    <FeatureEditor
      feature={feature}
      onMutation={onMutation}
      features={FEATURES}
      schema={INSTANCE_PATTERN_SCHEMA}
    />,
  )
  return onMutation
}

const labelsNow = () => [...document.querySelectorAll('.feature-field-label')].map((n) => n.textContent)

function pointsChip(): HTMLElement {
  const row = [...document.querySelectorAll<HTMLElement>('.feature-field-row')]
    .find(r => r.querySelector('.feature-field-label')?.textContent === 'Points')
  if (row === undefined) throw new Error('no Points row')
  return row.querySelector<HTMLElement>('.feature-pick-chip') as HTMLElement
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

describe('INSTANCE_PATTERN_SCHEMA picks points', () => {
  it('offers one target pick after the source rows, with no form select and no sketch field', () => {
    const targetFields = INSTANCE_PATTERN_SCHEMA.fields.filter((f) => f.key === 'targets')
    expect(targetFields).toHaveLength(1)
    const points = targetFields[0] as PickFieldDef
    expect(points.type).toBe('pick')
    expect(points.label).toBe('Points')
    expect(points.multi).toBe(true)
    expect(points.addMutationType).toBe('add_instance_pattern_target')
    expect(points.addValueKey).toBe('targetQuery')
    expect(points.removeMutationType).toBe('remove_instance_pattern_target')
    expect(points.emptyText).toBe('(pick a sketch, sketch points, vertices, faces, edges or planes)')
    // The retired form switch and its sketch row are gone.
    expect(INSTANCE_PATTERN_SCHEMA.fields.some((f) => f.key === 'sketch')).toBe(false)
    expect(INSTANCE_PATTERN_SCHEMA.fields.some((f) => f.type === 'select' && f.key === 'targets')).toBe(false)
    // The picker sits directly below the shared source rows.
    expect(INSTANCE_PATTERN_SCHEMA.fields[PATTERN_SOURCE_FIELDS.length]?.key).toBe('targets')
  })

  it('labels the one pick Points and drops the old Targets select from the form', () => {
    renderEditor(makeFeature())
    const labels = labelsNow()
    expect(labels).toContain('Points')
    expect(labels).not.toContain('Targets')
    expect(labels).not.toContain('Sketch')
  })

  it('dispatches a sketch row as one target ref', () => {
    const onMutation = renderEditor(makeFeature())
    fireEvent.click(pointsChip())
    pick('@sk1')
    expect(onMutation).toHaveBeenCalledWith({
      type: 'add_instance_pattern_target', featureId: 'ip1', targetQuery: '@sk1',
    })
  })

  it('dispatches a vertex pick to the same list, with no mode switch', () => {
    const onMutation = renderEditor(makeFeature())
    fireEvent.click(pointsChip())
    pick('?@body_ex1@u|v1:vertex')
    expect(onMutation).toHaveBeenCalledWith({
      type: 'add_instance_pattern_target', featureId: 'ip1', targetQuery: '?@body_ex1@u|v1:vertex',
    })
  })

  it('shows a stored sketch row as its label and a sketch point as its entity', () => {
    renderEditor(makeFeature({ targets: ['@sk1', 'entity:sk1:p1'] }))
    const chip = pointsChip()
    const chips = [...chip.querySelectorAll('.feature-pick-chip-item-text')].map((n) => n.textContent)
    expect(chips).toEqual(['Sketch 1', 'Entity of Sketch 1'])
  })
})

describe('the instance pattern hint', () => {
  const hint = INSTANCE_PATTERN_SCHEMA.fields.find((f) => f.key === 'skip') as TextFieldDef

  it('asks for points when the list is empty', () => {
    expect(hint.hint!({}, { features: FEATURES }))
      .toContain('pick points; the source goes on every one')
  })

  it('expands a sketch row to its numbered points and counts the list', () => {
    const text = hint.hint!(
      { targets: ['@sk1', '?@body_ex1@u|v1:vertex'] },
      { features: FEATURES },
    )!
    // Construction points are skipped, exactly as the kernel's site rule does.
    expect(text).toContain('1 = p1 (Sketch 1)')
    expect(text).toContain('2 = p2 (Sketch 1)')
    expect(text).toContain('3 = ?@body_ex1@u|v1:vertex (no normal, moved only)')
    expect(text).toContain('3 targets')
    expect(text).toContain('2 new')
  })

  it('still accounts for the skip list on the expanded numbering', () => {
    // Two points, one of them skipped: the source keeps its own slot, so no
    // copy is left.
    const text = hint.hint!({ targets: ['@sk1'], skip: [2] }, { features: FEATURES })!
    expect(text).toContain('2 targets')
    expect(text).toContain('0 new')
    expect(text).toContain('1 skipped')
  })
})
