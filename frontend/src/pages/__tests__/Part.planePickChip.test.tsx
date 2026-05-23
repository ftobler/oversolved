/**
 * Regression test: when a new sketch is added, the PlaneSelector pick-chip
 * must render in picking mode as soon as the sketch feature exists in the
 * feature list (and planeSelectionFeatureId matches).
 *
 * Before the fix, editingFeatureId was only set AFTER the plane was picked
 * (via pendingSketchOnFaceId effect), so the pick-chip was never shown
 * during the actual selection phase.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Sidebar } from '@/components/Sidebar'
import type { PartFeature } from '@/types/cad'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { PartEditorProvider } from '@/contexts/PartEditorContext'
import type { PartEditorCallbacks } from '@/contexts/PartEditorContext'

function makeCallbacks(overrides: Partial<PartEditorCallbacks> = {}): PartEditorCallbacks {
  return {
    onToggleSelect: vi.fn(),
    onEnterEditSketch: vi.fn(),
    onExitEditSketch: vi.fn(),
    onEnterEditFeature: vi.fn(),
    onExitEditFeature: vi.fn(),
    onEditCommit: vi.fn(),
    onEditCancel: vi.fn(),
    onToggleVisibility: vi.fn(),
    onRightClick: vi.fn(),
    onRollbackDragStart: vi.fn(),
    onMutation: vi.fn(),
    onSetRollbackPosition: vi.fn(),
    ...overrides,
  }
}

const sketchFeature: PartFeature = { id: 'sk1', kind: 'sketch', label: 'sketch 1' }

beforeEach(() => {
  usePartEditorStore.setState({
    features: [],
    rollbackPosition: null,
    visibleFeatures: new Set(),
    editingFeatureId: null,
    doc: null,
    visibleBodies: new Set(),
    partLabels: {},
    solveResults: {},
    bodies: {},
    isRebuilding: false,
    featureTimings: {},
  })
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    planeSelectionFeatureId: null,
  })
})

describe('plane pick-chip on new sketch', () => {
  it('renders pick-chip in picking state when editingFeatureId and planeSelectionFeatureId both match the sketch', () => {
    usePartEditorStore.setState({
      features: [sketchFeature],
      visibleFeatures: new Set(['sk1']),
      editingFeatureId: 'sk1',
    })
    useSketchEditorStore.setState({ planeSelectionFeatureId: 'sk1' })

    render(
      <PartEditorProvider value={makeCallbacks()}>
        <Sidebar />
      </PartEditorProvider>
    )

    const chip = document.querySelector('.feature-pick-chip')
    expect(chip).not.toBeNull()
    expect(chip!.classList.contains('picking')).toBe(true)
  })

  it('pick-chip is NOT in picking state when planeSelectionFeatureId is null', () => {
    usePartEditorStore.setState({
      features: [sketchFeature],
      visibleFeatures: new Set(['sk1']),
      editingFeatureId: 'sk1',
    })
    useSketchEditorStore.setState({ planeSelectionFeatureId: null })

    render(
      <PartEditorProvider value={makeCallbacks()}>
        <Sidebar />
      </PartEditorProvider>
    )

    const chip = document.querySelector('.feature-pick-chip')
    expect(chip).not.toBeNull()
    expect(chip!.classList.contains('picking')).toBe(false)
  })
})
