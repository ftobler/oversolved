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
import { render } from '@testing-library/react'
import { Sidebar } from '@/components/layout/Sidebar'
import { FeatureEditPanel } from '@/components/layout/FeatureEditPanel'
import type { PartFeature } from '@/types/cad'
import { usePartEditorStore } from '@/stores/partEditorStore'

import { PartEditorProvider } from '@/contexts/PartEditorContext'
import type { PartEditorCallbacks } from '@/contexts/PartEditorContext'
import { useEditorState } from '@/hooks/useEditorState'

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
    onMutation: vi.fn(),
    onSetRollbackPosition: vi.fn(),
    ...overrides,
  }
}

const sketchFeature: PartFeature = { id: 'sk1', kind: 'sketch', label: 'sketch 1' }

beforeEach(() => {
  usePartEditorStore.setState({
    features: [],
    visibleFeatures: new Set(),
    doc: null,
    visibleBodies: new Set(),
    partLabels: {},
    solveResults: {},
    bodies: {},
    isRebuilding: false,
    featureTimings: {},
  })
  useEditorState.setState({
    rollbackPosition: null,
    editingFeatureId: null,
  })
  useEditorState.setState({
    normalSelection: new Set(),
    activePickField: null,
    modeStack: [],
  })
})

describe('plane pick-chip on new sketch', () => {
  it('renders pick-chip in picking state when editingFeatureId and activePickField both match the sketch', () => {
    usePartEditorStore.setState({
    features: [sketchFeature],
    visibleFeatures: new Set(['sk1']),
  })
  useEditorState.setState({
    editingFeatureId: 'sk1',
  })
    // An armed pick field owns the top of the mode stack, so seeding one by hand
    // has to seed its entry too.
    useEditorState.setState({
    activePickField: { featureId: 'sk1', field: 'plane' },
    modeStack: ['pick'],
  })

    render(
      <PartEditorProvider value={makeCallbacks()}>
        <Sidebar />
        <FeatureEditPanel />
      </PartEditorProvider>
    )

    const chip = document.querySelector('.feature-pick-chip')
    expect(chip).not.toBeNull()
    expect(chip!.classList.contains('picking')).toBe(true)
  })

  it('pick-chip is NOT in picking state when activePickField is null', () => {
    usePartEditorStore.setState({
    features: [sketchFeature],
    visibleFeatures: new Set(['sk1']),
  })
  useEditorState.setState({
    editingFeatureId: 'sk1',
  })
    useEditorState.setState({
    activePickField: null,
    modeStack: [],
  })

    render(
      <PartEditorProvider value={makeCallbacks()}>
        <Sidebar />
        <FeatureEditPanel />
      </PartEditorProvider>
    )

    const chip = document.querySelector('.feature-pick-chip')
    expect(chip).not.toBeNull()
    expect(chip!.classList.contains('picking')).toBe(false)
  })
})
