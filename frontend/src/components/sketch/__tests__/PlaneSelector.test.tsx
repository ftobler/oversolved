/**
 * Regression: a sketch's plane pick chip must go through normal selection like
 * every other chip (not a parallel commitPlaneSelection path). Activating it and
 * then clicking a plane/face in the viewport (which only ever
 * toggleNormalSelection) must dispatch set_feature_plane via the consumer layer.
 *
 * See feature/selection-unification.md.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render } from '@testing-library/react'
import { PlaneSelector } from '@/components/sketch/PlaneSelector'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { PartFeature, Mutation } from '@/types/cad'

const sketch: PartFeature = { id: 'sk1', kind: 'sketch', label: 'sketch 1' }

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

function renderSelector(onMutation: (m: Mutation) => void, featureDef?: PartFeature) {
  return render(
    <PlaneSelector
      feature={sketch}
      featureDef={featureDef}
      onMutation={onMutation}
      features={[sketch]}
      partLabels={{}}
    />,
  )
}

describe('PlaneSelector (plane field as a consumer of normal selection)', () => {
  it('clicking a builtin plane while picking dispatches set_feature_plane', () => {
    const onMutation = vi.fn()
    renderSelector(onMutation)

    // Activate the chip (manual activate clears any existing selection).
    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'sk1', field: 'plane' })
    })

    // A viewport click only ever toggles normal selection.
    act(() => {
      useSketchEditorStore.getState().toggleNormalSelection('@builtin_plane_top')
    })

    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_feature_plane',
      featureId: 'sk1',
      plane: '@builtin_plane_top',
    })
    // Single-pick field auto-closes.
    expect(useSketchEditorStore.getState().activePickField).toBeNull()
  })

  it('stores a picked face query verbatim', () => {
    const onMutation = vi.fn()
    renderSelector(onMutation)

    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'sk1', field: 'plane' })
    })
    act(() => {
      useSketchEditorStore.getState().toggleNormalSelection('?3;@sketch0abc')
    })

    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_feature_plane',
      featureId: 'sk1',
      plane: '?3;@sketch0abc',
    })
  })

  it('mirrors a legacy bare plane name as its query', () => {
    // Documents predating the query ids still carry plane: 'Top', and the kernel
    // still resolves it, so the chip has to translate rather than mirror junk.
    renderSelector(vi.fn(), { ...sketch, plane: 'Top' })

    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'sk1', field: 'plane' })
    })

    expect(useSketchEditorStore.getState().normalSelection.has('@builtin_plane_top')).toBe(true)
    expect(useSketchEditorStore.getState().normalSelection.has('Top')).toBe(false)
  })

  it('mirrors the picked plane query (not its label) into the selection', () => {
    // The chip's values become chipOwnedSelection, so a display label there
    // would highlight nothing and could never match a viewport re-click.
    renderSelector(vi.fn(), { ...sketch, plane: '@builtin_plane_top' })

    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'sk1', field: 'plane' })
    })

    expect(useSketchEditorStore.getState().chipOwnedSelection.has('@builtin_plane_top')).toBe(true)
    expect(useSketchEditorStore.getState().normalSelection.has('@builtin_plane_top')).toBe(true)
  })

  it('re-clicking the picked plane dispatches the remove mutation once', () => {
    const onMutation = vi.fn()
    renderSelector(onMutation, { ...sketch, plane: '@builtin_plane_top' })

    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'sk1', field: 'plane' })
    })
    // The viewport re-click toggles the already-selected plane back out.
    act(() => {
      useSketchEditorStore.getState().toggleNormalSelection('@builtin_plane_top')
    })

    expect(onMutation).toHaveBeenCalledTimes(1)
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_feature_plane',
      featureId: 'sk1',
      plane: '',
    })
    // The mutation is async, so the chip re-syncs from the unchanged featureDef
    // until the re-solve lands. What must not survive is an orphan: whatever the
    // chip owns has to be back in the selection.
    const s = useSketchEditorStore.getState()
    for (const v of s.chipOwnedSelection) expect(s.normalSelection.has(v)).toBe(true)
  })

  it('does not dispatch when the chip is not picking', () => {
    const onMutation = vi.fn()
    renderSelector(onMutation)

    act(() => {
      useSketchEditorStore.getState().toggleNormalSelection('@builtin_plane_top')
    })

    expect(onMutation).not.toHaveBeenCalled()
  })
})
