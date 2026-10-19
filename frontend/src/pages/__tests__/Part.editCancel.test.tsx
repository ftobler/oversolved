// The OK/Cancel pair is reachable at both ends of an edit: in the feature row
// (where Edit was clicked) and in the floating FeatureEditPanel beside the
// fields. These drive the row pair; FeatureEditPanel.test.tsx pins the panel's.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { PartDocumentPanel } from '@/components/layout/PartDocumentPanel'
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

function renderSidebar(features: PartFeature[], editingFeatureId: string | null, callbacks: Partial<PartEditorCallbacks> = {}) {
  usePartEditorStore.setState({
    features,
    visibleFeatures: new Set(features.map(f => f.id)),
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
    editingFeatureId,
  })
  useEditorState.setState({
    normalSelection: new Set(),
    activePickField: null,
    modeStack: [],
  })
  return render(
    <PartEditorProvider value={makeCallbacks(callbacks)}>
      <PartDocumentPanel />
      <FeatureEditPanel />
    </PartEditorProvider>
  )
}

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

const extrudeFeature: PartFeature = {
  id: 'ex1',
  kind: 'extrude',
  extrude: { sketch: '$sk1', distance: 10, direction: 'normal' },
}

const sketchFeature: PartFeature = {
  id: 'sk1',
  kind: 'sketch',
}

/** Queries scoped to the edited row, since the panel carries the same pair. */
function editedRow() {
  return within(document.querySelector('.feature-item.editing') as HTMLElement)
}

describe('edit commit / cancel buttons', () => {
  it('shows OK and Cancel buttons when editing a feature', () => {
    renderSidebar([extrudeFeature], 'ex1')
    expect(editedRow().getByTitle('OK')).toBeDefined()
    expect(editedRow().getByTitle('Cancel')).toBeDefined()
  })

  it('shows OK and Cancel buttons when editing a sketch', () => {
    renderSidebar([sketchFeature], 'sk1')
    expect(editedRow().getByTitle('OK')).toBeDefined()
    expect(editedRow().getByTitle('Cancel')).toBeDefined()
  })

  it('shows no exit button when not editing', () => {
    renderSidebar([extrudeFeature], null)
    expect(screen.queryByTitle('OK')).toBeNull()
    expect(screen.queryByTitle('Cancel')).toBeNull()
  })

  it('calls onEditCommit when OK is clicked on extrude', () => {
    const onEditCommit = vi.fn()
    renderSidebar([extrudeFeature], 'ex1', { onEditCommit })
    fireEvent.click(editedRow().getByTitle('OK'))
    expect(onEditCommit).toHaveBeenCalled()
  })

  it('calls onEditCancel when Cancel is clicked on extrude', () => {
    const onEditCancel = vi.fn()
    renderSidebar([extrudeFeature], 'ex1', { onEditCancel })
    fireEvent.click(editedRow().getByTitle('Cancel'))
    expect(onEditCancel).toHaveBeenCalled()
  })

  it('calls onEditCommit when OK is clicked on sketch', () => {
    const onEditCommit = vi.fn()
    renderSidebar([sketchFeature], 'sk1', { onEditCommit })
    fireEvent.click(editedRow().getByTitle('OK'))
    expect(onEditCommit).toHaveBeenCalled()
  })

  it('calls onEditCancel when Cancel is clicked on sketch', () => {
    const onEditCancel = vi.fn()
    renderSidebar([sketchFeature], 'sk1', { onEditCancel })
    fireEvent.click(editedRow().getByTitle('Cancel'))
    expect(onEditCancel).toHaveBeenCalled()
  })

  it('Cancel does not call onEditCommit', () => {
    const onEditCommit = vi.fn()
    const onEditCancel = vi.fn()
    renderSidebar([extrudeFeature], 'ex1', { onEditCommit, onEditCancel })
    fireEvent.click(editedRow().getByTitle('Cancel'))
    expect(onEditCommit).not.toHaveBeenCalled()
    expect(onEditCancel).toHaveBeenCalled()
  })

  it('OK does not call onEditCancel', () => {
    const onEditCommit = vi.fn()
    const onEditCancel = vi.fn()
    renderSidebar([extrudeFeature], 'ex1', { onEditCommit, onEditCancel })
    fireEvent.click(editedRow().getByTitle('OK'))
    expect(onEditCancel).not.toHaveBeenCalled()
    expect(onEditCommit).toHaveBeenCalled()
  })
})

describe('commit does not call cancel', () => {
  it('commit does not call onEditCancel', () => {
    const onEditCancel = vi.fn()
    renderSidebar([extrudeFeature], 'ex1', { onEditCancel })
    fireEvent.click(editedRow().getByTitle('OK'))
    expect(onEditCancel).not.toHaveBeenCalled()
  })
})
