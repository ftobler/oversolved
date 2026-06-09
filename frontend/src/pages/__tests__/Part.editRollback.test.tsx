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
    onRollbackDragStart: vi.fn(),
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
    activePickField: null,
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
    activePickField: null,
  })
})

const extrudeFeature: PartFeature = {
  id: 'ex1',
  kind: 'extrude',
  extrude: { sketch: '$sk1', distance: 10, direction: 'normal' },
}

const planeFeature: PartFeature = { id: 'pl1', kind: 'plane' }

describe('extrude edit button', () => {
  it('calls onEnterEditFeature with the feature id', () => {
    const onEnterEditFeature = vi.fn()
    renderSidebar([extrudeFeature], null, { onEnterEditFeature })
    fireEvent.click(screen.getByTitle('Edit extrude'))
    expect(onEnterEditFeature).toHaveBeenCalledWith('ex1')
  })

  it('does not call onSetRollbackPosition directly', () => {
    const onSetRollbackPosition = vi.fn()
    renderSidebar([extrudeFeature], null, { onSetRollbackPosition })
    fireEvent.click(screen.getByTitle('Edit extrude'))
    expect(onSetRollbackPosition).not.toHaveBeenCalled()
  })
})

describe('extrude exit button', () => {
  it('calls onEditCommit when closing extrude editor', () => {
    const onEditCommit = vi.fn()
    renderSidebar([extrudeFeature], 'ex1', { onEditCommit })
    fireEvent.click(screen.getByTitle('OK'))
    expect(onEditCommit).toHaveBeenCalled()
  })

})

describe('plane edit button', () => {
  it('calls onEnterEditFeature with the feature id', () => {
    const onEnterEditFeature = vi.fn()
    renderSidebar([planeFeature], null, { onEnterEditFeature })
    fireEvent.click(screen.getByTitle('Edit plane'))
    expect(onEnterEditFeature).toHaveBeenCalledWith('pl1')
  })

  it('does not call onSetRollbackPosition directly', () => {
    const onSetRollbackPosition = vi.fn()
    renderSidebar([planeFeature], null, { onSetRollbackPosition })
    fireEvent.click(screen.getByTitle('Edit plane'))
    expect(onSetRollbackPosition).not.toHaveBeenCalled()
  })
})

describe('plane exit button', () => {
  it('calls onEditCommit when closing plane editor', () => {
    const onEditCommit = vi.fn()
    renderSidebar([planeFeature], 'pl1', { onEditCommit })
    fireEvent.click(screen.getByTitle('OK'))
    expect(onEditCommit).toHaveBeenCalled()
  })
})
