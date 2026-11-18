/**
 * The circular pattern's source body and axis are pickable. The solver honours
 * `circular_pattern.source_body` and `circular_pattern.axis`; the editor exposes
 * chips for both so a document with more than one body can be patterned on the
 * intended body, about the intended edge or face.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, act, screen } from '@testing-library/react'
import { FeatureEditor } from '@/components/editors/FeatureEditor'
import { CIRCULAR_PATTERN_SCHEMA } from '@/components/editors/featureEditorSchemas'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { PartFeature } from '@/types/cad'
import { useEditorState } from '@/hooks/useEditorState'

const FEATURES: PartFeature[] = [
  { id: 'ex1', kind: 'extrude', extrude: { sketch: [], distance: 1 } },
  { id: 'pt1', kind: 'circular_pattern', circular_pattern: { subject: 'body' } },
]

function makeFeature(source_part = ''): PartFeature {
  return {
    id: 'pt1',
    kind: 'circular_pattern',
    label: 'Pattern',
    circular_pattern: { subject: 'body', source_body: source_part, count: 4, operation: 'add' },
  } as unknown as PartFeature
}

function renderEditor(feature: PartFeature, onMutation: () => void) {
  render(<FeatureEditor feature={feature} onMutation={onMutation} features={FEATURES} schema={CIRCULAR_PATTERN_SCHEMA} />)
}

/** Pick chips in field order: [0] Part, [1] Axis. */
function chips(): NodeListOf<HTMLElement> {
  return document.querySelectorAll<HTMLElement>('.feature-pick-chip')
}
function partChip(): HTMLElement {
  return chips()[0]
}
function axisChip(): HTMLElement {
  return chips()[1]
}

/** Simulate the viewport click path: every pick lands in normalSelection. */
function pick(selectionId: string) {
  act(() => { useSketchEditorStore.getState().toggleNormalSelection(selectionId) })
}

beforeEach(() => {
  useEditorState.setState({
    normalSelection: new Set(),
    chipOwnedSelection: new Set(),
    activePickField: null,
    modeStack: [],
  })
})

describe('circular pattern body pick (via FeatureEditor)', () => {
  it('renders an empty part chip asking for the part to copy', () => {
    renderEditor(makeFeature(), vi.fn())
    const chip = partChip()
    expect(chip.classList.contains('empty')).toBe(true)
    expect(chip.querySelector('.feature-pick-chip-empty-text')?.textContent).toBe('(pick the part to copy)')
  })

  it('renders the source_body ref when set', () => {
    renderEditor(makeFeature('@body_ex1'), vi.fn())
    // PickChip runs the ref through queryLabel when `features` is supplied.
    expect(partChip().querySelector('.feature-pick-chip-item-text')?.textContent).toBe('body_ex1')
  })

  it('picking a body normalizes to an @body_ ref', () => {
    const onMutation = vi.fn()
    renderEditor(makeFeature(), onMutation)
    fireEvent.click(partChip())
    pick('body:body_ex1')
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_circular_pattern_field', featureId: 'pt1', field: 'source_body', value: '@body_ex1',
    })
  })

  it('picking a face of a body keeps the inner query for the solver to resolve', () => {
    const onMutation = vi.fn()
    renderEditor(makeFeature(), onMutation)
    fireEvent.click(partChip())
    pick('face:ex1:?4;@ex1:face')
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_circular_pattern_field', featureId: 'pt1', field: 'source_body', value: '?4;@ex1:face',
    })
  })

  it('rejects picking the pattern\'s own body', () => {
    const onMutation = vi.fn()
    renderEditor(makeFeature(), onMutation)
    fireEvent.click(partChip())
    pick('@body_pt1')
    expect(onMutation).not.toHaveBeenCalled()
  })

  it('remove button clears source_body back to the empty pick', () => {
    const onMutation = vi.fn()
    renderEditor(makeFeature('@body_ex1'), onMutation)
    fireEvent.click(partChip().querySelector('.feature-pick-chip-item-remove')!)
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_circular_pattern_field', featureId: 'pt1', field: 'source_body', value: '',
    })
  })
})

describe('circular pattern count and angle rows', () => {
  it('states what each box measures, in one wrapper, so their widths cannot diverge', () => {
    renderEditor(makeFeature(), vi.fn())
    const count = screen.getByRole('textbox', { name: 'Count, pieces' })
    const angle = screen.getByRole('textbox', { name: 'Angle, degrees' })
    const countBox = count.closest('.field-unit-box')
    const angleBox = angle.closest('.field-unit-box')
    expect(countBox).not.toBeNull()
    expect(angleBox).not.toBeNull()
    expect(countBox!.className).toBe(angleBox!.className)
    expect(countBox!.querySelector('.field-unit')?.textContent).toBe('pcs')
    expect(angleBox!.querySelector('.field-unit')?.textContent).toBe('deg')
  })
})

describe('circular pattern axis pick (via FeatureEditor)', () => {
  it('renders an empty axis chip flagged as a required pick', () => {
    renderEditor(makeFeature(), vi.fn())
    const chip = axisChip()
    expect(chip.classList.contains('empty')).toBe(true)
    expect(chip.querySelector('.feature-pick-chip-empty-text')?.textContent).toBe('(pick edge or face, required)')
  })

  it('picking an edge stores its inner query as the axis', () => {
    const onMutation = vi.fn()
    renderEditor(makeFeature(), onMutation)
    fireEvent.click(axisChip())
    pick('edge:ex1:?4;@ex1:edge')
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_circular_pattern_field', featureId: 'pt1', field: 'axis', value: '?4;@ex1:edge',
    })
  })

  it('toggling Invert axis dispatches an invert_axis field mutation', () => {
    const onMutation = vi.fn()
    renderEditor(makeFeature(), onMutation)
    const rows = [...document.querySelectorAll<HTMLElement>('.feature-field-row')]
    const invertRow = rows.find((r) => r.querySelector('.feature-field-label')?.textContent === 'Invert axis')!
    fireEvent.click(invertRow.querySelector('input[type="checkbox"]')!)
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_circular_pattern_field', featureId: 'pt1', field: 'invert_axis', value: true,
    })
  })
})
