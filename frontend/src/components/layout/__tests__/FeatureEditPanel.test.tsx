/**
 * The open feature editor is a floating card on the right side of the viewport
 * (floating-panels phase 1). The tree row only marks the edited feature; this
 * panel is the one place the editor body and the OK/Cancel pair render, so the
 * features list no longer grows by a whole form when a feature opens.
 *
 * The panel reuses FeatureItemEditors unchanged, so these pin what the row used
 * to render inline: the status line, the schema fields, the plane editor, the
 * sketch plane selector and the STEP file row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FeatureEditPanel } from '@/components/layout/FeatureEditPanel'
import { FeatureTree } from '@/components/layout/FeatureTree'
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

function seedStores(features: PartFeature[], doc: unknown = null) {
  usePartEditorStore.setState({
    features,
    visibleFeatures: new Set(features.map(f => f.id)),
    doc: doc as never,
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
    normalSelection: new Set(),
    activePickField: null,
    modeStack: [],
  })
}

function renderPanel(
  features: PartFeature[],
  editingFeatureId: string | null,
  callbacks: Partial<PartEditorCallbacks> = {},
  doc: unknown = null,
) {
  seedStores(features, doc)
  useEditorState.setState({ editingFeatureId })
  return render(
    <PartEditorProvider value={makeCallbacks(callbacks)}>
      <FeatureEditPanel />
    </PartEditorProvider>,
  )
}

const extrudeFeature: PartFeature = {
  id: 'ex1',
  kind: 'extrude',
  label: 'Extrude 1',
  extrude: { sketch: '$sk1', distance: 10, direction: 'normal' },
}

beforeEach(() => {
  seedStores([])
})

describe('FeatureEditPanel', () => {
  it('renders nothing when no feature is being edited', () => {
    renderPanel([extrudeFeature], null)
    expect(document.querySelector('.feature-edit-panel')).toBeNull()
    expect(screen.queryByTitle('OK')).toBeNull()
  })

  it('shows the feature name, its fields and the OK/Cancel pair while editing', () => {
    renderPanel([extrudeFeature], 'ex1')

    expect(screen.getByText('Extrude 1')).toBeInTheDocument()
    // The schema editor, not a stub: the extrude's Distance field renders.
    expect(screen.getByLabelText('Distance')).toBeInTheDocument()
    expect(screen.getByTitle('OK')).toBeInTheDocument()
    expect(screen.getByTitle('Cancel')).toBeInTheDocument()
  })

  it('calls onEditCommit only from OK and onEditCancel only from Cancel', () => {
    const onEditCommit = vi.fn()
    const onEditCancel = vi.fn()

    const { unmount } = renderPanel([extrudeFeature], 'ex1', { onEditCommit, onEditCancel })
    fireEvent.click(screen.getByTitle('OK'))
    expect(onEditCommit).toHaveBeenCalledTimes(1)
    expect(onEditCancel).not.toHaveBeenCalled()
    unmount()

    renderPanel([extrudeFeature], 'ex1', { onEditCommit, onEditCancel })
    fireEvent.click(screen.getByTitle('Cancel'))
    expect(onEditCancel).toHaveBeenCalledTimes(1)
    expect(onEditCommit).toHaveBeenCalledTimes(1)
  })

  it('draws the same solve mark the tree row carries', () => {
    seedStores([extrudeFeature])
    usePartEditorStore.setState({ solveResults: { ex1: { status: 'exception', exception: 'sketch not found' } } })
    useEditorState.setState({ editingFeatureId: 'ex1' })
    render(
      <PartEditorProvider value={makeCallbacks()}>
        <FeatureTree />
        <FeatureEditPanel />
      </PartEditorProvider>,
    )

    const rowTitle = document.querySelector('.feature-name')!.getAttribute('title')
    const line = document.querySelector('.feature-edit-panel .status-message')!
    expect(rowTitle).toBe('sketch not found')
    expect(line.textContent).toBe('sketch not found')
    expect(line.classList.contains('status-message--error')).toBe(true)
  })

  it('renders the plane editor for a not-built-in plane', () => {
    const plane: PartFeature = { id: 'pl1', kind: 'plane', definition: { mode: 'offset' } }
    renderPanel([plane], 'pl1', {}, { version: 1, kind: 'part', features: [plane] })

    expect(screen.getByText('Type')).toBeInTheDocument()
    expect(screen.getByText('Offset')).toBeInTheDocument()
  })

  it('renders the sketch plane selector for a sketch', () => {
    const sketch: PartFeature = { id: 'sk1', kind: 'sketch', plane: '@builtin_plane_top' }
    renderPanel([sketch], 'sk1', {}, { version: 1, kind: 'part', features: [sketch] })

    expect(document.querySelector('.feature-edit-panel .feature-pick-chip')).not.toBeNull()
  })

  it('renders the STEP file row for an import', () => {
    const imp: PartFeature = { id: 'IM1', kind: 'import_step', file_id: '' }
    renderPanel([imp], 'IM1')

    expect(screen.getByText('Missing file')).toBeInTheDocument()
  })

  it('stays closed for an edited feature that has no editor body', () => {
    // A built-in plane can never open an editor, but the panel must not draw a
    // frame with an empty body if one ever does.
    renderPanel([{ id: 'Top', kind: 'plane' }], 'Top')
    expect(document.querySelector('.feature-edit-panel')).toBeNull()
  })
})
