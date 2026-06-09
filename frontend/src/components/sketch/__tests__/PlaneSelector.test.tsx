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
    chipOwnedSelection: new Set(),
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

  it('strips the face:<featureId>: prefix when a 3D face is picked', () => {
    const onMutation = vi.fn()
    renderSelector(onMutation)

    act(() => {
      useSketchEditorStore.getState().setActivePickField({ featureId: 'sk1', field: 'plane' })
    })
    act(() => {
      useSketchEditorStore.getState().toggleNormalSelection('face:sketch0:?3;@sketch0abc')
    })

    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_feature_plane',
      featureId: 'sk1',
      plane: '?3;@sketch0abc',
    })
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
