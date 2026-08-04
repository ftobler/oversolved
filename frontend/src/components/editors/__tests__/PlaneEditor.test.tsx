/**
 * PlaneEditor as a pick-field consumer. It routes every mode's chip through one
 * `usePickField` observer, so it owes the same re-click-to-remove behaviour the
 * generic PickFieldWidget has: a chip-owned id that drops out of normalSelection
 * is a toggle-off and must dispatch the matching clear mutation.
 *
 * See feature/chip-selection-consistency.md.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render } from '@testing-library/react'
import { PlaneEditor } from '@/components/editors/PlaneEditor'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { PartFeature, PlaneDef, Mutation } from '@/types/cad'

const sketch: PartFeature = { id: 'sk1', kind: 'sketch', label: 'sketch 1' }
const plane: PartFeature = { id: 'pl1', kind: 'plane', label: 'plane 1' }

beforeEach(() => {
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    selectedPicks: new Map(),
    chipOwnedSelection: new Set(),
    selectionDomain: 'sketch_2d',
    activePickField: null,
    activeTool: null,
    modeStack: [],
  })
})

function renderEditor(onMutation: (m: Mutation) => void, definition: PlaneDef) {
  return render(
    <PlaneEditor
      feature={plane}
      featureDef={{ ...plane, definition }}
      onMutation={onMutation}
      features={[sketch, plane]}
      partLabels={{}}
    />,
  )
}

describe('PlaneEditor pick chips', () => {
  it('mirrors the plane query (not its label) into the selection', () => {
    renderEditor(vi.fn(), { mode: 'offset', plane: '@builtin_plane_top' })

    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'pl1', field: 'plane' })
    })

    const s = useSketchEditorStore.getState()
    expect(s.chipOwnedSelection.has('@builtin_plane_top')).toBe(true)
    expect(s.normalSelection.has('@builtin_plane_top')).toBe(true)
    expect(s.selectionDomain).toBe('plane_3d')
  })

  it('renders the query through the shared label resolver', () => {
    renderEditor(vi.fn(), { mode: 'plane_point', plane: '@builtin_plane_top', point: '@builtin_origin' })
    const items = [...document.querySelectorAll('.feature-pick-chip-item-text')]
    expect(items.map(i => i.textContent)).toEqual(['Top', 'Origin'])
  })

  it('picking a plane dispatches set_plane_definition_field', () => {
    const onMutation = vi.fn()
    renderEditor(onMutation, { mode: 'offset' })

    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'pl1', field: 'plane' })
    })
    act(() => {
      useSketchEditorStore.getState().toggleNormalSelection('@builtin_plane_front')
    })

    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_plane_definition_field',
      featureId: 'pl1',
      field: 'plane',
      value: '@builtin_plane_front',
    })
  })

  it('re-clicking the picked plane dispatches the field clear once', () => {
    const onMutation = vi.fn()
    renderEditor(onMutation, { mode: 'offset', plane: '@builtin_plane_top' })

    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'pl1', field: 'plane' })
    })
    act(() => {
      useSketchEditorStore.getState().toggleNormalSelection('@builtin_plane_top')
    })

    expect(onMutation).toHaveBeenCalledTimes(1)
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_plane_definition_field',
      featureId: 'pl1',
      field: 'plane',
      value: '',
    })
  })

  // Pins a known gap rather than a desired behaviour. `emitAbsoluteSelectionQuery`
  // rewrites a sketch vertex id ('vertex:sk1:l1:start') into '@sk1l1start' before
  // it is stored, but the viewport toggles the unrewritten id, so the mirrored
  // value can never match a click. The re-click therefore lands as a fresh pick
  // that re-dispatches the value already held instead of clearing the field. See
  // the KNOWN GAP note in usePickField. Change this test only together with the
  // normalization that closes it.
  it('re-clicking a sketch vertex re-picks it instead of clearing (known gap)', () => {
    const onMutation = vi.fn()
    renderEditor(onMutation, { mode: 'plane_point', plane: '@builtin_plane_top', point: '@sk1l1start' })

    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'pl1', field: 'point' })
    })
    act(() => {
      useSketchEditorStore.getState().toggleNormalSelection('vertex:sk1:l1:start')
    })

    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_plane_definition_field',
      featureId: 'pl1',
      field: 'point',
      value: '@sk1l1start',  // re-set to the value it already had, not ''
    })
    expect(onMutation).not.toHaveBeenCalledWith(
      expect.objectContaining({ field: 'point', value: '' }),
    )
  })

  it('clears the field the user is actually picking, not the first one', () => {
    const onMutation = vi.fn()
    renderEditor(onMutation, { mode: 'plane_point', plane: '@builtin_plane_top', point: '@builtin_origin' })

    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'pl1', field: 'point' })
    })
    act(() => {
      useSketchEditorStore.getState().toggleNormalSelection('@builtin_origin')
    })

    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_plane_definition_field',
      featureId: 'pl1',
      field: 'point',
      value: '',
    })
  })
})
