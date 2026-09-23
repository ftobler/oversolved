import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Sidebar } from '@/components/layout/Sidebar'
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
    onMutation: vi.fn(),
    onSetRollbackPosition: vi.fn(),
    ...overrides,
  }
}

function renderSidebar(features: PartFeature[], editingFeatureId: string | null, callbacks: Partial<PartEditorCallbacks> = {}) {
  usePartEditorStore.setState({
    features,
    visibleFeatures: new Set(features.map(f => f.id)),
    editingFeatureId,
    rollbackPosition: null,
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
    activePickField: null, modeStack: [],
  })
  return render(
    <PartEditorProvider value={makeCallbacks(callbacks)}>
      <Sidebar />
    </PartEditorProvider>
  )
}

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
    activePickField: null, modeStack: [],
  })
})

const extrudeFeature: PartFeature = {
  id: 'ex1',
  kind: 'extrude',
  extrude: { sketch: '$sk1', distance: 10, direction: 'normal' },
}

const planeFeature: PartFeature = { id: 'pl1', kind: 'plane' }

const featureCases = [
  { kind: 'extrude', feature: extrudeFeature },
  { kind: 'plane', feature: planeFeature },
]

describe('feature edit and exit buttons', () => {
  it.each(featureCases)('$kind: edit button enters feature edit with its id', ({ kind, feature }) => {
    const onEnterEditFeature = vi.fn()
    renderSidebar([feature], null, { onEnterEditFeature })
    fireEvent.click(screen.getByTitle(`Edit ${kind}`))
    expect(onEnterEditFeature).toHaveBeenCalledWith(feature.id)
  })

  it.each(featureCases)('$kind: edit button does not move the rollback bar itself', ({ kind, feature }) => {
    const onSetRollbackPosition = vi.fn()
    renderSidebar([feature], null, { onSetRollbackPosition })
    fireEvent.click(screen.getByTitle(`Edit ${kind}`))
    expect(onSetRollbackPosition).not.toHaveBeenCalled()
  })

  it.each(featureCases)('$kind: OK commits the open edit without cancelling it', ({ feature }) => {
    // The component only forwards the click; closing the editor is the parent's
    // job, so the contract here is the call and its exclusivity, not a state the
    // callback itself would have to set.
    const onEditCommit = vi.fn()
    const onEditCancel = vi.fn()
    renderSidebar([feature], feature.id, { onEditCommit, onEditCancel })
    fireEvent.click(screen.getByTitle('OK'))
    expect(onEditCommit).toHaveBeenCalledOnce()
    expect(onEditCancel).not.toHaveBeenCalled()
  })
})
