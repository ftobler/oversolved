import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Sidebar } from '@/components/layout/Sidebar'
import type { PartFeature } from '@/types/cad'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { PartEditorProvider } from '@/contexts/PartEditorContext'
import type { PartEditorCallbacks } from '@/contexts/PartEditorContext'

const sketchFeature: PartFeature = { id: 'sk1', kind: 'sketch' }

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

function renderSidebar(
  features: PartFeature[],
  editingFeatureId: string | null,
  callbacks: Partial<PartEditorCallbacks> = {},
) {
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
    </PartEditorProvider>,
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

describe('sketch enter without viewport', () => {
  it('calls onEnterEditSketch with the sketch feature id', () => {
    const onEnterEditSketch = vi.fn()
    renderSidebar([sketchFeature], null, { onEnterEditSketch })
    fireEvent.click(screen.getByTitle('Edit sketch'))
    expect(onEnterEditSketch).toHaveBeenCalledWith('sk1')
  })

  it('partEditorStore reflects editingFeatureId after sketch enter', () => {
    const onEnterEditSketch = vi.fn((id: string) => {
      // Simulate what Part.tsx does when enterEditSketch fires
      usePartEditorStore.setState({ editingFeatureId: id })
    })
    renderSidebar([sketchFeature], null, { onEnterEditSketch })
    fireEvent.click(screen.getByTitle('Edit sketch'))
    expect(usePartEditorStore.getState().editingFeatureId).toBe('sk1')
  })
})

describe('sketch exit without viewport', () => {
  it('calls onEditCommit when the exit button is clicked', () => {
    const onEditCommit = vi.fn()
    renderSidebar([sketchFeature], 'sk1', { onEditCommit })
    fireEvent.click(screen.getByTitle('OK'))
    expect(onEditCommit).toHaveBeenCalled()
  })

  it('partEditorStore editingFeatureId is cleared after sketch exit', () => {
    const onEditCommit = vi.fn(() => {
      // Simulate what Part.tsx does when exitEditSketch fires
      usePartEditorStore.setState({ editingFeatureId: null })
    })
    renderSidebar([sketchFeature], 'sk1', { onEditCommit })
    fireEvent.click(screen.getByTitle('OK'))
    expect(usePartEditorStore.getState().editingFeatureId).toBeNull()
  })
})

describe('entity selection without viewport', () => {
  it('toggleNormalSelection adds an entity id to the selection', () => {
    useSketchEditorStore.getState().toggleNormalSelection('entity:sk1:e1')
    expect(useSketchEditorStore.getState().normalSelection.has('entity:sk1:e1')).toBe(true)
  })

  it('toggleNormalSelection removes an already-selected entity id', () => {
    useSketchEditorStore.setState({ normalSelection: new Set(['entity:sk1:e1']) })
    useSketchEditorStore.getState().toggleNormalSelection('entity:sk1:e1')
    expect(useSketchEditorStore.getState().normalSelection.has('entity:sk1:e1')).toBe(false)
  })

  it('sketchEditorStore.activeFeatureId can be set without a Viewport present', () => {
    useSketchEditorStore.getState().setActiveFeatureId('sk1')
    expect(useSketchEditorStore.getState().activeFeatureId).toBe('sk1')
  })
})
