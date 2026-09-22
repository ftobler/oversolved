// The Part page's callback layer: the Save button, the breadcrumb rename, the
// header debug toggles, the tree's rebuild and rollback hooks, and the body /
// feature / plane right-click actions. Each callback is a thin wrapper around a
// store or hook call, so these mount the real page and drive the seam the real
// component would, then assert the call the orchestration layer owes.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, within } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { Wrapper } from '@/__tests__/test-utils'
import { usePartEditorStore, DEFAULT_PART_EDITOR_DATA } from '@/stores/partEditorStore'
import { useSketchEditorStore, getSketchCallback } from '@/stores/sketchEditorStore'
import { useDevSettingsStore } from '@/stores/devSettingsStore'
import { executeCommand } from '@/utils/core/commandRegistry'
import { MAX_STEP_IMPORT_BYTES } from '@/stores/documentStore/stepImport'

const F = vi.hoisted(() => {
  const doc = {
    version: 1,
    kind: 'part',
    features: [
      { id: 'Origin', kind: 'origin' },
      { id: 'Front', kind: 'plane' },
      { id: 'sketch1', kind: 'sketch', label: 'Sketch 1', plane: '@builtin_plane_front', constraints: [{ id: 'c1', kind: 'superfluous' }] },
      { id: 'extrude1', kind: 'extrude', label: 'Extrude 1', extrude: { sketch: '$sketch1', distance: 10 } },
      { id: 'plane1', kind: 'plane', label: 'Plane 1' },
    ],
    part_style: { 'body-1': { name: 'Body One', color: '#FF0000' } },
  }
  const bodies = { 'body-1': { id: 'body-1', created_by: 'extrude1', modified_by: [] } }
  const self = {
    doc,
    bodies,
    solve: {
      sketch1: { solved: {}, constraints: { c1: { superfluous: true } } },
      extrude1: { solved: {} },
      plane1: { plane_transform: { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], origin: [1, 2, 3] } },
    },
  }
  return self
})

const h = vi.hoisted(() => ({
  reSolve: vi.fn(),
  handleMutation: vi.fn(),
  saveDoc: vi.fn(async () => true),
  renameDoc: vi.fn(async () => true),
  setError: vi.fn(),
  startPreviewMode: vi.fn(),
  commitPreview: vi.fn(),
  cancelPreview: vi.fn(),
  alignFace: vi.fn(),
  alignPlane: vi.fn(),
  exportOpen: vi.fn(),
  registryCreate: vi.fn(async () => ({ id: 'file-1' })),
}))

vi.mock('@/stores/fileRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/fileRegistry')>()
  return { ...actual, getFileRegistry: () => ({ create: h.registryCreate }) }
})

vi.mock('@/hooks/usePartDoc', async () =>
  (await import('@/__tests__/test-utils')).partDocMockModule({
    doc: F.doc,
    docRef: { current: F.doc },
    bodies: F.bodies,
    solveResults: F.solve,
    reSolve: h.reSolve,
    handleMutation: h.handleMutation,
    saveDoc: h.saveDoc,
    renameDoc: h.renameDoc,
    setError: h.setError,
    startPreviewMode: h.startPreviewMode,
    commitPreview: h.commitPreview,
    cancelPreview: h.cancelPreview,
    docName: 'Bracket',
  }))

vi.mock('@/pages/PartExportImport', async () => {
  const React = await import('react')
  return {
    __esModule: true,
    default: React.forwardRef(function PartExportImportMock(_props: unknown, ref: import('react').Ref<unknown>) {
      React.useImperativeHandle(ref, () => ({ openExport: h.exportOpen }))
      return null
    }),
  }
})

vi.mock('@/components/Viewport', async () => {
  const React = await import('react')
  return {
    __esModule: true,
    default: React.forwardRef(function MockViewport(
      props: { onRightClick?: (pos: [number, number]) => void; hud?: import('react').ReactNode },
      ref: import('react').Ref<unknown>,
    ) {
      React.useImperativeHandle(ref, () => ({
        autoZoomToFit: vi.fn(),
        cancelPendingFit: vi.fn(),
        captureScreenshotForSaving: vi.fn(),
        alignCameraToFace: h.alignFace,
        alignCameraToPlane: h.alignPlane,
      }))
      return (
        <div data-testid="viewport">
          <button data-testid="viewport-ctx" onClick={() => props.onRightClick?.([0, 0])} />
          <div data-testid="viewport-hud">{props.hud}</div>
        </div>
      )
    }),
  }
})

vi.mock('@/components/layout/Sidebar', async () => {
  const { usePartEditorStore: useStore } = await import('@/stores/partEditorStore')
  const { usePartEditorCallbacks } = await import('@/contexts/PartEditorContext')
  return {
    Sidebar: () => {
      const features = useStore(s => s.features)
      const bodies = useStore(s => s.bodies)
      const { onRightClick, onRebuild, onSetRollbackPosition, onRename } = usePartEditorCallbacks()
      return (
        <div data-testid="sidebar">
          {features.map(f => (
            <button key={f.id} data-testid={`feature-ctx-${f.id}`} onClick={() => onRightClick([0, 0], f.id)}>{f.id}</button>
          ))}
          {Object.keys(bodies ?? {}).map(id => (
            <button key={id} data-testid={`body-ctx-${id}`} onClick={() => onRightClick([0, 0], `body:${id}`)}>{id}</button>
          ))}
          <button data-testid="sidebar-rebuild" onClick={() => onRebuild?.()} />
          <button data-testid="sidebar-rollback" onClick={() => onSetRollbackPosition(2)} />
          <button data-testid="sidebar-rename" onClick={() => onRename?.('sketch1', 'New Name')} />
        </div>
      )
    },
  }
})

vi.mock('@/components/layout/AppHeader', () => ({
  default: ({ children, rightContent, breadcrumb }: { children?: import('react').ReactNode; rightContent?: import('react').ReactNode; breadcrumb?: import('react').ReactNode }) => (
    <div data-testid="header">{breadcrumb}{children}{rightContent}</div>
  ),
}))

vi.mock('@/components/Toolbar/SketchToolbar', () => ({ default: () => null }))
vi.mock('@/components/layout/MeasurementDisplay', () => ({ default: () => null }))
vi.mock('@/components/dialogs/LoadingOverlay', () => ({ default: () => null }))
vi.mock('@/components/dialogs/RightClickMenu', async () =>
  (await import('@/__tests__/test-utils')).rightClickMenuMockModule())
vi.mock('@/hooks/useWorkspaceName', () => ({ useWorkspaceName: () => 'WS' }))

function renderPart() {
  return render(
    <MemoryRouter initialEntries={['/workspaces/ws-1/entries/doc-1']}>
      <Routes>
        <Route path="/workspaces/:workspaceId/entries/:entryId" element={<Part />} />
      </Routes>
    </MemoryRouter>,
    { wrapper: Wrapper },
  )
}

const menuItem = (name: string | RegExp) => screen.getByRole('button', { name })

describe('Part page actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.saveDoc.mockResolvedValue(true)
    h.renameDoc.mockResolvedValue(true)
    usePartEditorStore.setState({
      ...DEFAULT_PART_EDITOR_DATA,
      features: F.doc.features,
      doc: F.doc,
      bodies: F.bodies,
      solveResults: F.solve,
      partStyle: F.doc.part_style,
      editingFeatureId: null,
      rollbackPosition: null,
      pickBoundary: null,
    })
    useSketchEditorStore.setState({
      normalSelection: new Set(),
      hoveredSelectionId: null,
      hoveredVertexId: null,
      hoveredFaceNormal: null,
      hoveredFaceCenter: null,
      activeTool: null,
      activePickField: null,
      modeStack: [],
      showDebugHit: false,
      showConstraintTiles: false,
    })
    useDevSettingsStore.setState({ validateOnRebuild: false })
  })

  it('the toolbar Save writes the open document through saveDoc and clears the banner', async () => {
    renderPart()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })) })

    expect(h.saveDoc).toHaveBeenCalledWith('doc-1', F.doc, expect.any(Function))
    expect(h.setError).toHaveBeenCalledWith(null)
  })

  it('renaming from the breadcrumb routes to renameDoc with the route entry id', async () => {
    renderPart()

    fireEvent.click(screen.getByTitle('Rename document'))
    const input = screen.getByLabelText('Document name')
    fireEvent.change(input, { target: { value: 'New Bracket' } })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }) })

    expect(h.renameDoc).toHaveBeenCalledWith('doc-1', 'New Bracket')
  })

  it('the header toggle opens the debug drawer and the collision button flips its store flag', () => {
    renderPart()
    expect(document.querySelector('.debug-drawer')).toBeNull()

    fireEvent.click(screen.getByTitle('Toggle debug panel (F2)'))
    expect(document.querySelector('.debug-drawer')).not.toBeNull()

    expect(useSketchEditorStore.getState().showDebugHit).toBe(false)
    fireEvent.click(screen.getByTitle('Show debug collision rendering'))
    expect(useSketchEditorStore.getState().showDebugHit).toBe(true)
  })

  it('the tree Rebuild re-solves the current document with the cache bypassed', async () => {
    renderPart()

    await act(async () => { fireEvent.click(screen.getByTestId('sidebar-rebuild')) })

    expect(h.reSolve).toHaveBeenCalledWith(F.doc, { bypassCache: true, validate: false })
  })

  it('a rollback drag writes the position through the set_rollback mutation', () => {
    renderPart()

    fireEvent.click(screen.getByTestId('sidebar-rollback'))

    expect(usePartEditorStore.getState().rollbackPosition).toBe(2)
    expect(h.handleMutation).toHaveBeenCalledWith({ type: 'set_rollback', position: 2 })
  })

  it('the tree rename routes to the rename_feature mutation', () => {
    renderPart()

    fireEvent.click(screen.getByTestId('sidebar-rename'))

    expect(h.handleMutation).toHaveBeenCalledWith({ type: 'rename_feature', featureId: 'sketch1', label: 'New Name' })
  })

  it('the feature context menu Rebuild re-solves and closes the menu', () => {
    renderPart()

    fireEvent.click(screen.getByTestId('feature-ctx-extrude1'))
    fireEvent.click(menuItem('Rebuild'))

    expect(h.reSolve).toHaveBeenCalledWith(F.doc)
    expect(screen.queryByTestId('context-menu')).toBeNull()
  })

  it('the feature context menu Suppress toggles suppression through the mutation path', () => {
    renderPart()

    fireEvent.click(screen.getByTestId('feature-ctx-extrude1'))
    fireEvent.click(menuItem('Suppress'))

    expect(h.handleMutation).toHaveBeenCalledWith({ type: 'set_feature_suppression', featureId: 'extrude1', suppressed: true })
  })

  it('the feature context menu Rename seeds and commits a rename_feature mutation', () => {
    renderPart()

    fireEvent.click(screen.getByTestId('feature-ctx-extrude1'))
    fireEvent.click(menuItem('Rename'))

    const box = document.querySelector('.dialog-component') as HTMLElement
    const input = within(box).getByRole('textbox')
    expect(input).toHaveValue('Extrude 1')
    fireEvent.change(input, { target: { value: 'Base Extrude' } })
    fireEvent.click(within(box).getByRole('button', { name: 'Rename' }))

    expect(h.handleMutation).toHaveBeenCalledWith({ type: 'rename_feature', featureId: 'extrude1', label: 'Base Extrude' })
  })

  it('offers the cleanup only with flagged content and removes it in one mutation', () => {
    renderPart()

    fireEvent.click(screen.getByTestId('feature-ctx-extrude1'))
    fireEvent.click(menuItem(/Remove dangling/))

    expect(h.handleMutation).toHaveBeenCalledWith({
      type: 'remove_dangling_content',
      features: { sketch1: { entities: [], constraints: ['c1'] } },
    })
    expect(screen.queryByTestId('context-menu')).toBeNull()
  })

  it('the active sketch menu aligns the camera to its plane and toggles the constraint tiles', () => {
    usePartEditorStore.setState({ editingFeatureId: 'sketch1', rollbackPosition: F.doc.features.length })
    renderPart()

    fireEvent.click(screen.getByTestId('feature-ctx-sketch1'))
    fireEvent.click(menuItem('Align camera'))
    // The stored plane query is stripped of its @ before it reaches the camera.
    expect(h.alignPlane).toHaveBeenCalledWith('builtin_plane_front')

    expect(useSketchEditorStore.getState().showConstraintTiles).toBe(false)
    fireEvent.click(menuItem('Show Constraints'))
    expect(useSketchEditorStore.getState().showConstraintTiles).toBe(true)
  })

  it('the active sketch menu Exit Sketch closes the menu', () => {
    usePartEditorStore.setState({ editingFeatureId: 'sketch1', rollbackPosition: F.doc.features.length })
    renderPart()

    fireEvent.click(screen.getByTestId('feature-ctx-sketch1'))
    fireEvent.click(menuItem('Exit Sketch'))

    expect(screen.queryByTestId('context-menu')).toBeNull()
  })

  it('a viewport face right-click aligns the camera to the hovered face', () => {
    useSketchEditorStore.setState({
      hoveredSelectionId: '?face',
      hoveredFaceNormal: [0, 0, 1],
      hoveredFaceCenter: [0, 0, 5],
    })
    renderPart()

    fireEvent.click(screen.getByTestId('viewport-ctx'))
    fireEvent.click(menuItem('Normal to'))

    expect(h.alignFace).toHaveBeenCalledWith([0, 0, 1], [0, 0, 5])
  })

  it('a plane menu normal comes from the solved transform and can start a sketch on it', () => {
    renderPart()

    fireEvent.click(screen.getByTestId('feature-ctx-plane1'))
    fireEvent.click(menuItem('Normal to'))
    expect(h.alignFace).toHaveBeenCalledWith([0, 0, 1], [1, 2, 3])

    fireEvent.click(screen.getByTestId('feature-ctx-plane1'))
    fireEvent.click(menuItem('New Sketch'))
    expect(h.handleMutation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'add_sketch', plane: '@plane1' }),
    )
  })

  it('the body context menu Export opens the dialog targeting that body', () => {
    renderPart()

    fireEvent.click(screen.getByTestId('body-ctx-body-1'))
    fireEvent.click(menuItem('Export'))

    expect(h.exportOpen).toHaveBeenCalledWith('body-1', 'Body One')
  })

  it('body color and material setters normalize and route to their mutations', () => {
    renderPart()

    fireEvent.click(screen.getByTestId('body-ctx-body-1'))
    fireEvent.click(menuItem('Color'))

    fireEvent.change(screen.getByPlaceholderText('#RRGGBB'), { target: { value: '#00ff00' } })
    expect(h.handleMutation).toHaveBeenCalledWith({ type: 'set_part_color', bodyId: 'body-1', color: '#00FF00' })

    const [opacity, metalness, roughness, transmission] = screen.getAllByRole('slider') as HTMLInputElement[]
    fireEvent.change(opacity, { target: { value: '0.4' } })
    fireEvent.change(metalness, { target: { value: '0.6' } })
    fireEvent.change(roughness, { target: { value: '0.2' } })
    fireEvent.change(transmission, { target: { value: '0.1' } })

    expect(h.handleMutation).toHaveBeenCalledWith({ type: 'set_part_transparency', bodyId: 'body-1', transparency: 0.4 })
    expect(h.handleMutation).toHaveBeenCalledWith({ type: 'set_part_metalness', bodyId: 'body-1', metalness: 0.6 })
    expect(h.handleMutation).toHaveBeenCalledWith({ type: 'set_part_roughness', bodyId: 'body-1', roughness: 0.2 })
    expect(h.handleMutation).toHaveBeenCalledWith({ type: 'set_part_transmission', bodyId: 'body-1', transmission: 0.1 })
  })

  it('the toolbar Export opens the export dialog with the document name', () => {
    renderPart()

    fireEvent.click(screen.getByTitle('Feature mode'))
    fireEvent.click(screen.getByTitle('Export'))

    expect(h.exportOpen).toHaveBeenCalledWith(null, 'Bracket')
  })

  // A rollback while a session is open has to re-point the pick boundary at the
  // edited feature, or the solve-side editing invariant fires on the next solve.
  it('a rollback during an edit re-points the pick boundary at that feature', () => {
    usePartEditorStore.setState({ editingFeatureId: 'extrude1' })
    renderPart()

    fireEvent.click(screen.getByTestId('sidebar-rollback'))

    // extrude1 is the second non-builtin feature, so its index is 1.
    expect(usePartEditorStore.getState().pickBoundary).toBe(1)
    expect(h.handleMutation).toHaveBeenCalledWith({ type: 'set_rollback', position: 2 })
  })

  it('a builtin plane derives its camera normal locally, without a solve result', () => {
    renderPart()

    fireEvent.click(screen.getByTestId('feature-ctx-Front'))
    fireEvent.click(menuItem('Normal to'))

    expect(h.alignFace).toHaveBeenCalledWith([0, 0, 1], [0, 0, 0])
  })

  it('the plane visibility command routes to the toggle mutation', async () => {
    renderPart()

    await act(async () => { executeCommand('toggle_plane_visibility') })

    expect(h.handleMutation).toHaveBeenCalledWith({ type: 'toggle_plane_visibility' })
  })

  it('the registered getSketch callback answers with the feature solve result', () => {
    renderPart()

    expect(getSketchCallback('getSketch')?.('sketch1')).toBe(F.solve.sketch1.solved)
    expect(getSketchCallback('getSketch')?.('missing')).toBeNull()
  })

  // A constraint the store refuses (parallel across a line and a circle) has to
  // say why rather than do nothing, and the message box it raises has to close.
  it('a refused constraint surfaces a dismissible message dialog', async () => {
    renderPart()
    act(() => {
      useSketchEditorStore.setState({
        activeFeatureId: 'sketch1',
        normalSelection: new Set(['entity:sketch1:e1', 'entity:sketch1:e2']),
        entityKindMap: { 'entity:sketch1:e1': 'line', 'entity:sketch1:e2': 'circle' },
      })
    })

    await act(async () => { executeCommand('apply_parallel') })

    expect(screen.getByText('Cannot apply constraint')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(screen.queryByText('Cannot apply constraint')).toBeNull()
  })

  async function importStep(file: { name: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> }) {
    fireEvent.click(screen.getByTitle('Feature mode'))
    const created: HTMLInputElement[] = []
    const make = document.createElement.bind(document)
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation(((tag: string, opts?: ElementCreationOptions) => {
      const el = make(tag as never, opts)
      if (tag === 'input') created.push(el as HTMLInputElement)
      return el
    }) as typeof document.createElement)
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})

    fireEvent.click(screen.getByTitle('Import STEP'))

    const input = created[0]
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    await act(async () => { await input.onchange?.(new Event('change')) })

    createSpy.mockRestore()
    clickSpy.mockRestore()
  }

  it('an imported STEP file is stored and adds an import_step feature', async () => {
    h.registryCreate.mockResolvedValue({ id: 'file-9' })
    renderPart()

    await importStep({ name: 'bracket.step', size: 32, arrayBuffer: async () => new ArrayBuffer(8) })

    expect(h.registryCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'bracket.step', kind: 'step', mime: 'application/step' }),
    )
    // The label drops the extension. The registry write gates the feature, so
    // the mutation may only be dispatched after it resolves.
    expect(h.handleMutation).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'add_import_step', fileId: 'file-9', label: 'bracket' }),
    )
  })

  it('an oversize STEP file is rejected before it is read', async () => {
    renderPart()
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(8))

    await importStep({ name: 'huge.step', size: MAX_STEP_IMPORT_BYTES + 1, arrayBuffer })

    expect(h.setError).toHaveBeenCalledWith(expect.stringContaining('too large'))
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(h.handleMutation).not.toHaveBeenCalled()
  })

  it('an unreadable STEP file is reported rather than added', async () => {
    renderPart()

    await importStep({ name: 'broken.step', size: 32, arrayBuffer: async () => { throw new Error('io') } })

    expect(h.setError).toHaveBeenCalledWith('Failed to read STEP file')
    expect(h.handleMutation).not.toHaveBeenCalled()
  })

  it('an empty STEP file is reported rather than added', async () => {
    renderPart()

    await importStep({ name: 'empty.step', size: 0, arrayBuffer: async () => new ArrayBuffer(0) })

    expect(h.setError).toHaveBeenCalledWith('STEP file is empty')
    expect(h.handleMutation).not.toHaveBeenCalled()
  })

  it('a store failure on STEP import is reported and adds nothing', async () => {
    h.registryCreate.mockRejectedValue(new Error('quota exceeded'))
    renderPart()

    await importStep({ name: 'bracket.step', size: 32, arrayBuffer: async () => new ArrayBuffer(8) })

    expect(h.setError).toHaveBeenCalledWith('quota exceeded')
    expect(h.handleMutation).not.toHaveBeenCalled()
  })
})
