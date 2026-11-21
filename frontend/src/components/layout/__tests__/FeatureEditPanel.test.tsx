/**
 * The open feature editor is a floating card on the right side of the viewport
 * (floating-panels phase 1). The tree row only marks the edited feature and
 * carries its own OK/Cancel pair; this panel is the one place the editor body
 * renders, and it also carries a pair for working at that end. The features
 * list no longer grows by a whole form when a feature opens.
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
import renameIcon from '@/assets/icons/rename.svg'

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

function seedStores(features: PartFeature[], doc: unknown = null, activeSketchFeatureId: string | null = null) {
  usePartEditorStore.setState({
    features,
    visibleFeatures: new Set(features.map(f => f.id)),
    doc: doc as never,
    visibleParts: new Set(),
    partLabels: {},
    solveResults: {},
    parts: {},
    isRebuilding: false,
    featureTimings: {},
  })
  useEditorState.setState({
    rollbackPosition: null,
    editingFeatureId: null,
    activeSketchFeatureId,
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
  activeSketchFeatureId: string | null = null,
) {
  seedStores(features, doc, activeSketchFeatureId)
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
    expect(screen.getByLabelText('Distance, millimetres')).toBeInTheDocument()
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

  // The card's rename is the tree menu's rename: one dialog, one mutation path.
  // It sits left of the verdict pair, before the title runs out of room.
  it('puts Rename left of OK and Cancel with the rename icon and name', () => {
    renderPanel([extrudeFeature], 'ex1', { onRequestRename: vi.fn() })

    const header = document.querySelector('.feature-edit-panel-header') as HTMLElement
    const titles = Array.from(header.querySelectorAll('button')).map(b => b.getAttribute('title'))
    expect(titles).toEqual(['Rename', 'OK', 'Cancel'])

    const rename = screen.getByRole('button', { name: 'Rename' })
    expect(rename.getAttribute('class')).toBe('feature-rename-btn')
    expect(rename.querySelector('img')!.getAttribute('src')).toBe(renameIcon)
  })

  it('requests a rename of the edited feature, named as the title shows it', () => {
    const onRequestRename = vi.fn()
    renderPanel([extrudeFeature], 'ex1', { onRequestRename })

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(onRequestRename).toHaveBeenCalledTimes(1)
    expect(onRequestRename).toHaveBeenCalledWith({ kind: 'feature', id: 'ex1', currentName: 'Extrude 1' })
  })

  it('falls back to the feature id for an unlabeled feature', () => {
    const unlabeled: PartFeature = { ...extrudeFeature, label: undefined }
    const onRequestRename = vi.fn()
    renderPanel([unlabeled], 'ex1', { onRequestRename })

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(onRequestRename).toHaveBeenCalledWith({ kind: 'feature', id: 'ex1', currentName: 'ex1' })
  })

  it('draws no Rename button when the page offers no rename opener', () => {
    renderPanel([extrudeFeature], 'ex1')
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull()
  })

  // The menu refuses to rename the sketch under edit because it would fight the
  // open session; the card shares that gate, so the sketch's own editor has no
  // Rename either.
  it('draws no Rename button for the sketch under edit', () => {
    const sketch: PartFeature = { id: 'sk1', kind: 'sketch', label: 'Sketch 1', plane: '@builtin_plane_top' }
    renderPanel([sketch], 'sk1', { onRequestRename: vi.fn() }, { version: 1, kind: 'part', features: [sketch] }, 'sk1')
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull()
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
