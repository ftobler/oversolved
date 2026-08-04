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

const sketchFeature: PartFeature = {
  id: 'sk1',
  kind: 'sketch',
}

describe('edit commit / cancel buttons', () => {
  it('shows OK and Cancel buttons when editing a feature', () => {
    renderSidebar([extrudeFeature], 'ex1')
    expect(screen.getByTitle('OK')).toBeDefined()
    expect(screen.getByTitle('Cancel')).toBeDefined()
  })

  it('shows OK and Cancel buttons when editing a sketch', () => {
    renderSidebar([sketchFeature], 'sk1')
    expect(screen.getByTitle('OK')).toBeDefined()
    expect(screen.getByTitle('Cancel')).toBeDefined()
  })

  it('shows no exit button when not editing', () => {
    renderSidebar([extrudeFeature], null)
    expect(screen.queryByTitle('OK')).toBeNull()
    expect(screen.queryByTitle('Cancel')).toBeNull()
  })

  it('calls onEditCommit when OK is clicked on extrude', () => {
    const onEditCommit = vi.fn()
    renderSidebar([extrudeFeature], 'ex1', { onEditCommit })
    fireEvent.click(screen.getByTitle('OK'))
    expect(onEditCommit).toHaveBeenCalled()
  })

  it('calls onEditCancel when Cancel is clicked on extrude', () => {
    const onEditCancel = vi.fn()
    renderSidebar([extrudeFeature], 'ex1', { onEditCancel })
    fireEvent.click(screen.getByTitle('Cancel'))
    expect(onEditCancel).toHaveBeenCalled()
  })

  it('calls onEditCommit when OK is clicked on sketch', () => {
    const onEditCommit = vi.fn()
    renderSidebar([sketchFeature], 'sk1', { onEditCommit })
    fireEvent.click(screen.getByTitle('OK'))
    expect(onEditCommit).toHaveBeenCalled()
  })

  it('calls onEditCancel when Cancel is clicked on sketch', () => {
    const onEditCancel = vi.fn()
    renderSidebar([sketchFeature], 'sk1', { onEditCancel })
    fireEvent.click(screen.getByTitle('Cancel'))
    expect(onEditCancel).toHaveBeenCalled()
  })

  it('Cancel does not call onEditCommit', () => {
    const onEditCommit = vi.fn()
    const onEditCancel = vi.fn()
    renderSidebar([extrudeFeature], 'ex1', { onEditCommit, onEditCancel })
    fireEvent.click(screen.getByTitle('Cancel'))
    expect(onEditCommit).not.toHaveBeenCalled()
    expect(onEditCancel).toHaveBeenCalled()
  })

  it('OK does not call onEditCancel', () => {
    const onEditCommit = vi.fn()
    const onEditCancel = vi.fn()
    renderSidebar([extrudeFeature], 'ex1', { onEditCommit, onEditCancel })
    fireEvent.click(screen.getByTitle('OK'))
    expect(onEditCancel).not.toHaveBeenCalled()
    expect(onEditCommit).toHaveBeenCalled()
  })
})

describe('commit does not call cancel', () => {
  it('commit does not call onEditCancel', () => {
    const onEditCancel = vi.fn()
    renderSidebar([extrudeFeature], 'ex1', { onEditCancel })
    fireEvent.click(screen.getByTitle('OK'))
    expect(onEditCancel).not.toHaveBeenCalled()
  })
})
