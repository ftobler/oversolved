/**
 * The open feature editor is a floating card on the right side of the viewport
 * (floating-panels phase 1). The tree row only marks the edited feature and
 * carries its own OK/Cancel pair; this panel is the one place the editor body
 * renders, and it also carries a pair for working at that end. The features
 * list no longer grows by a whole form when a feature opens.
 *
 * The panel reuses FeatureItemEditors unchanged, so these pin what the row used
 * to render inline: the schema fields, the plane editor, the sketch plane
 * selector and the STEP file row. The feature's solve mark is a separate card
 * under the panel, pinned here for its place outside the panel and its icon.
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
import errorIcon from '@/assets/icons/status-error.svg'
import warningIcon from '@/assets/icons/status-warning.svg'

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
    const line = document.querySelector('.feature-status-panel .status-message')!
    expect(rowTitle).toBe('sketch not found')
    expect(line.textContent).toBe('sketch not found')
    expect(line.classList.contains('status-message--error')).toBe(true)
  })

  it('draws the solve mark as its own glass card below the edit panel', () => {
    seedStores([extrudeFeature])
    usePartEditorStore.setState({
      solveResults: { ex1: { status: 'ok', body_id: 'body_ex1', solver_warning: 'the sketch is underconstrained' } },
    })
    useEditorState.setState({ editingFeatureId: 'ex1' })
    render(
      <PartEditorProvider value={makeCallbacks()}>
        <FeatureEditPanel />
      </PartEditorProvider>,
    )

    const panel = document.querySelector('.feature-edit-panel') as HTMLElement
    const status = document.querySelector('.feature-status-panel') as HTMLElement
    expect(status).not.toBeNull()
    expect(status.classList.contains('glass-panel')).toBe(true)
    // A sibling card, not a row inside the form.
    expect(panel.contains(status)).toBe(false)
    expect(status.previousElementSibling).toBe(panel)
    expect(status.querySelector('.status-message')!.textContent).toBe('the sketch is underconstrained')
  })

  it('sits between the edit panel and the card below it in the column flow', () => {
    seedStores([extrudeFeature])
    usePartEditorStore.setState({ solveResults: { ex1: { status: 'exception', exception: 'sketch not found' } } })
    useEditorState.setState({ editingFeatureId: 'ex1' })
    render(
      <PartEditorProvider value={makeCallbacks()}>
        <div className="right-overlay-stack">
          <FeatureEditPanel />
          <div className="bug-report-panel" />
        </div>
      </PartEditorProvider>,
    )

    const panel = document.querySelector('.feature-edit-panel') as HTMLElement
    const status = document.querySelector('.feature-status-panel') as HTMLElement
    const report = document.querySelector('.bug-report-panel') as HTMLElement
    // Ordinary flow siblings, in the order the page mounts them: the card
    // pushes the bug report down instead of covering it.
    expect(status.previousElementSibling).toBe(panel)
    expect(status.nextElementSibling).toBe(report)
  })

  it('leaves the edit panel itself identical whether or not a mark shows', () => {
    // jsdom does not lay out, so the panel's own box is pinned by its markup:
    // a mark that leaves this markup untouched cannot move or resize it. Its
    // in-flow placement after the panel is pinned in
    // pages/__tests__/editorStatusLayout.test.ts.
    seedStores([extrudeFeature])
    useEditorState.setState({ editingFeatureId: 'ex1' })
    const healthy = render(
      <PartEditorProvider value={makeCallbacks()}>
        <FeatureEditPanel />
      </PartEditorProvider>,
    )
    const healthyPanel = (document.querySelector('.feature-edit-panel') as HTMLElement).outerHTML
    expect(document.querySelector('.feature-status-panel')).toBeNull()
    healthy.unmount()

    seedStores([extrudeFeature])
    usePartEditorStore.setState({ solveResults: { ex1: { status: 'exception', exception: 'sketch not found' } } })
    useEditorState.setState({ editingFeatureId: 'ex1' })
    render(
      <PartEditorProvider value={makeCallbacks()}>
        <FeatureEditPanel />
      </PartEditorProvider>,
    )

    expect(document.querySelector('.feature-status-panel')).not.toBeNull()
    expect((document.querySelector('.feature-edit-panel') as HTMLElement).outerHTML).toBe(healthyPanel)
    expect((document.querySelector('.feature-edit-panel') as HTMLElement).className).toBe('glass-panel feature-edit-panel')
  })

  it('shows the error icon for an error and the warning icon for a warning', () => {
    const cases = [
      { result: { status: 'exception', exception: 'sketch not found' }, icon: errorIcon },
      { result: { status: 'partial', body_id: 'body_ex1', exception: '2 edge(s) could not be applied' }, icon: warningIcon },
    ]
    for (const { result, icon } of cases) {
      seedStores([extrudeFeature])
      usePartEditorStore.setState({ solveResults: { ex1: result } })
      useEditorState.setState({ editingFeatureId: 'ex1' })
      const view = render(
        <PartEditorProvider value={makeCallbacks()}>
          <FeatureEditPanel />
        </PartEditorProvider>,
      )

      const status = document.querySelector('.feature-status-panel') as HTMLElement
      expect(status.querySelector('img')!.getAttribute('src')).toBe(icon)
      view.unmount()
    }
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
