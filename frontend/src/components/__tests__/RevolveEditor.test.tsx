import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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
    onToggleVisibility: vi.fn(),
    onRightClick: vi.fn(),
    onRollbackDragStart: vi.fn(),
    onMutation: vi.fn(),
    onSetRollbackPosition: vi.fn(),
    ...overrides,
  }
}

function renderSidebar(storeFeatures: PartFeature[], editingFeatureId: string | null, callbacks: Partial<PartEditorCallbacks> = {}, pendingPickField?: unknown) {
  usePartEditorStore.setState({
    features: storeFeatures,
    visibleFeatures: new Set(storeFeatures.map(f => f.id)),
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
    pendingPickField: (pendingPickField ?? null) as never,
    planeSelectionFeatureId: null,
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
    pendingPickField: null,
    planeSelectionFeatureId: null,
  })
})

const revolveFeature: PartFeature = {
  id: 'rev1',
  kind: 'revolve',
  revolve: { sketch: '$sk1', angle: 360 },
}

describe('merge target PickChip in RevolveEditor', () => {
  it('is shown for add operation (default)', () => {
    renderSidebar([revolveFeature], 'rev1')
    expect(screen.getByText('Merge Target')).toBeInTheDocument()
  })

  it('is shown for cut operation', () => {
    const cutFeature: PartFeature = {
      id: 'rev1', kind: 'revolve',
      revolve: { sketch: '$sk1', angle: 360, operation: 'cut' },
    }
    renderSidebar([cutFeature], 'rev1')
    expect(screen.getByText('Merge Target')).toBeInTheDocument()
  })

  it('is hidden for new operation', () => {
    const newFeature: PartFeature = {
      id: 'rev1', kind: 'revolve',
      revolve: { sketch: '$sk1', angle: 360, operation: 'new' },
    }
    renderSidebar([newFeature], 'rev1')
    expect(screen.queryByText('Merge Target')).toBeNull()
  })

  it('shows (all bodies) when no merge_target set', () => {
    renderSidebar([revolveFeature], 'rev1')
    expect(screen.getByText('(all bodies)')).toBeInTheDocument()
  })

  it('activates pick mode with hostKind revolve on chip click', () => {
    renderSidebar([revolveFeature], 'rev1')
    fireEvent.click(screen.getByText('(all bodies)'))
    expect(useSketchEditorStore.getState().pendingPickField).toEqual({
      featureId: 'rev1', field: 'merge_target', hostKind: 'revolve',
    })
  })

  it('deactivates pick mode when chip clicked while already picking', () => {
    renderSidebar([revolveFeature], 'rev1', {}, { featureId: 'rev1', field: 'merge_target', hostKind: 'revolve' })
    fireEvent.click(screen.getByText('(all bodies)'))
    expect(useSketchEditorStore.getState().pendingPickField).toBeNull()
  })
})
