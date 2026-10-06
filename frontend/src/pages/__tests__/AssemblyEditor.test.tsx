import { describe, it, expect, vi, beforeEach } from 'vitest'
import { forwardRef, useImperativeHandle, type ReactNode } from 'react'
import { screen, fireEvent, act, waitFor } from '@testing-library/react'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA } from '@/stores/assemblyStore'

const navigateSpy = vi.fn()
vi.mock('react-router-dom', () => ({
  // AppHeader reads the path to decide whether its burger navigates or opens
  // the about notice; these assembly routes are never the documents overview.
  useLocation: () => ({ pathname: '/workspaces/ws/entries/test-uuid' }),
  // The breadcrumb reads the route's workspace to build its trail.
  useParams: () => ({ workspaceId: 'ws', entryId: 'test-uuid' }),
  useNavigate: () => navigateSpy,
  // AppHeader (rendered via AssemblyToolbar) navigates with <Link>; a plain
  // anchor is enough for these tests, which assert on useNavigate instead.
  Link: ({ to, children, ...props }: { to: string; children?: ReactNode }) =>
    <a href={to} {...props}>{children}</a>,
}))

const h = vi.hoisted(() => ({
  loadContent: 'kind: assembly\nfeatures: []',
  partContent: 'features: []',
  list: [] as Array<{ uuid: string; name: string; kind?: string; meta?: { rev: number } }>,
  save: vi.fn(),
  previewPut: vi.fn(),
  captureScreenshotForSaving: vi.fn(),
  solveAssemblyViaWorker: vi.fn(),
  setRelayHandlers: vi.fn(),
  clearRelayHandlers: vi.fn(),
  buildBundleViaWorker: vi.fn(),
  exportAssemblyViaWorker: vi.fn(),
  downloadBlob: vi.fn(),
}))

vi.mock('@/adapters/backend', () => ({
  backendBundle: {
    documents: {
      // The assembly export loads its referenced PartDocs through the same store,
      // so `load` has to answer per document id, not with one canned content.
      load: vi.fn(async (id: string) => ({
        content: id === 'asm-1' ? h.loadContent : h.partContent,
        name: 'My Assembly',
      })),
      list: vi.fn(async () => h.list),
      save: h.save,
      // The picker's tile preview asks the store for a thumbnail URL.
      thumbnailUrl: () => null,
    },
    cloudDocuments: null,
  },
}))

// The viewport needs WebGL; its logic is covered viewport-free (assemblyRender,
// assemblyPointer). The page's job here is to mount it and drive the solve. The
// mock forwards a ref exposing the thumbnail capturer, so the save path can be
// asserted end to end without a GL context.
vi.mock('@/components/Viewport/AssemblyViewport', () => ({
  default: forwardRef((_props, ref) => {
    useImperativeHandle(ref, () => ({ captureScreenshotForSaving: h.captureScreenshotForSaving }))
    return <div data-testid="assembly-viewport" />
  }),
}))
vi.mock('@/kernel/worker/anchorSolverClient', () => ({
  solveAssemblyViaWorker: h.solveAssemblyViaWorker,
  setRelayHandlers: h.setRelayHandlers,
  clearRelayHandlers: h.clearRelayHandlers,
}))
vi.mock('@/kernel/worker/solverClient', () => ({
  buildBundleViaWorker: h.buildBundleViaWorker,
  exportAssemblyViaWorker: h.exportAssemblyViaWorker,
}))
vi.mock('@/utils/core/downloadBlob', () => ({ downloadBlob: h.downloadBlob }))
vi.mock('@/stores/previewStore', () => ({
  getPreviewStore: () => ({ put: h.previewPut, get: vi.fn(), remove: vi.fn() }),
  usePreview: () => undefined,
}))

import { executeCommand, registerCommand } from '@/utils/core/commandRegistry'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { useEditorModeStore } from '@/stores/editorModeStore'
import { backendBundle } from '@/adapters/backend'
import { tick, renderEditor, installSessionFromList, insertPart } from './AssemblyEditor.harness'

describe('AssemblyEditor (Stage 6b)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.loadContent = 'kind: assembly\nfeatures: []'
    h.list = [
      { uuid: 'part-1', name: 'Bracket', kind: 'part', meta: { rev: 5 } },
      { uuid: 'part-2', name: 'Bolt', kind: 'part', meta: { rev: 2 } },
    ]
    h.solveAssemblyViaWorker.mockResolvedValue({
      payload: { transforms: {}, bodies: {} },
    })
    h.save.mockResolvedValue(undefined)
    h.previewPut.mockResolvedValue(undefined)
    h.captureScreenshotForSaving.mockResolvedValue('data:image/png;base64,QVNN')
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.getState().selectPart(null)
    useAssemblyStore.getState().setActiveMateField(null)
    useAssemblyStore.getState().selectMate(null)
    useAssemblyStore.setState({ editingSubject: { kind: 'none' } })
    installSessionFromList(h)
  })

  async function renderLoaded() {
    renderEditor()
    await tick()
    await tick()
  }

  it('starts empty and shows the insert affordance', async () => {
    await renderLoaded()
    expect(screen.getByText(/Empty assembly/)).toBeTruthy()
    expect(screen.getByLabelText('Insert part')).toBeTruthy()
  })

  it('captures a viewport thumbnail into the preview store and saves the content', async () => {
    await renderLoaded()
    fireEvent.click(screen.getByLabelText('Save'))
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1))
    expect(h.captureScreenshotForSaving).toHaveBeenCalled()
    const [savedUuid, body] = h.save.mock.calls[0]
    expect(savedUuid).toBe('asm-1')
    expect(body).toEqual({ content: expect.any(String) })
    // saveDoc strips the data: prefix; the preview lives off the record now.
    expect(h.previewPut).toHaveBeenCalledWith('asm-1', 'asm-1', 'QVNN')
  }, 10000)

  it('mounts the assembly viewport and solves once on load', async () => {
    await renderLoaded()
    expect(screen.getByTestId('assembly-viewport')).toBeTruthy()
    // Bodies only exist after a solve, so the load must ask for one.
    await waitFor(() => expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1))
  })

  // The store is module-level: without this reset, the very first render of the
  // NEXT assembly (a different uuid mounted in this store's place) would paint
  // this assembly's leftover bodies/transforms until its own first solve lands.
  it('unmounting resets the solved scene to default, not just the transient interaction state', async () => {
    h.solveAssemblyViaWorker.mockResolvedValue({
      payload: {
        transforms: { hA: { tx: 5, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 } },
        bodies: {
          hA: [{
            vertices: new Float32Array([0, 0, 0]),
            indices: new Uint32Array([0]),
            faceIdsPerTriangle: new Uint32Array([0]),
            edges: [],
          }],
        },
      },
    })
    const first = renderEditor()
    await tick()
    await tick()
    await insertPart('Bracket')
    await waitFor(() => expect(Object.keys(useAssemblyStore.getState().bodies).length).toBeGreaterThan(0))
    expect(useAssemblyStore.getState().doc).not.toBeNull()
    expect(useAssemblyStore.getState().instances).toHaveLength(1)

    first.unmount()

    const store = useAssemblyStore.getState()
    expect(store.doc).toBeNull()
    expect(store.instances).toEqual([])
    expect(store.mates).toEqual([])
    expect(store.bodies).toEqual({})
    expect(store.transforms).toEqual({})
    expect(store.solveStatus).toBeNull()
    expect(store.edgeCurves).toEqual({})
    expect(store.anchors).toEqual({})
    expect(store.pickGeometry).toEqual([])
    expect(store.entityMateRefs).toEqual({})
  })

  it('inserting a part re-solves so its bodies enter the scene', async () => {
    await renderLoaded()
    await waitFor(() => expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1))
    await insertPart('Bracket')
    await waitFor(() => expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2))
  })

  it('deleting the selected instance clears the selection', async () => {
    await renderLoaded()
    await insertPart('Bracket')
    const handle = useAssemblyStore.getState().instances[0].handle
    useAssemblyStore.getState().selectPart(handle)

    fireEvent.click(screen.getByLabelText('Part options'))
    fireEvent.click(screen.getByText('Delete'))
    await tick()
    await tick()  // let the delete's re-solve settle

    expect(useAssemblyStore.getState().subject).toBeNull()
    expect(useAssemblyStore.getState().instances).toHaveLength(0)
  })

  it('insert_part_instance command appends an instance shown in the tree', async () => {
    await renderLoaded()
    await insertPart('Bracket')
    // Tree lists the instance by the part document's name, not its uuid.
    await waitFor(() => expect(screen.getByText('Bracket')).toBeTruthy())
    const instances = useAssemblyStore.getState().instances
    expect(instances).toHaveLength(1)
    expect(instances[0].doc_id).toBe('part-1')
    expect(instances[0].doc_rev).toBe(5)
  })

  it('lists the assembly origin planes hidden by default and toggles one visible', async () => {
    await renderLoaded()
    // The Origin section lists the frame's origin and three reference planes,
    // each with a Show affordance because they start hidden.
    for (const label of ['Origin', 'Top', 'Front', 'Right']) {
      expect(screen.getByLabelText(`Show ${label}`)).toBeTruthy()
    }

    fireEvent.click(screen.getByLabelText('Show Top'))
    await tick()

    // The eye flips to Hide and the doc records the plane as shown.
    expect(screen.getByLabelText('Hide Top')).toBeTruthy()
    const top = (useAssemblyStore.getState().doc?.features ?? []).find(f => f.id === 'AssemblyTop')
    expect(top?.visible).toBe(true)
    // Showing a plane never triggers a solve: it constrains nothing.
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1)
  })

  it('two instances of the same part get distinct handles', async () => {
    await renderLoaded()
    await insertPart('Bracket')
    await insertPart('Bracket')
    const instances = useAssemblyStore.getState().instances
    expect(instances).toHaveLength(2)
    expect(instances[0].handle).not.toBe(instances[1].handle)
  })

  it('fix toggle (in the options menu) marks the instance fixed', async () => {
    await renderLoaded()
    await insertPart('Bracket')
    fireEvent.click(screen.getByLabelText('Part options'))
    fireEvent.click(screen.getByText('Fix'))
    await tick()
    expect(useAssemblyStore.getState().instances[0].fixed).toBe(true)
  })

  // The menu verb pair is Fix/Unfix. The old wording (Ground/Unground) is gone,
  // and asserting its absence keeps a half-done rename from passing.
  it('offers Fix, then Unfix once the instance is fixed, and never the old wording', async () => {
    await renderLoaded()
    await insertPart('Bracket')
    fireEvent.click(screen.getByLabelText('Part options'))
    expect(screen.getByText('Fix')).toBeTruthy()
    expect(screen.queryByText('Ground (fix)')).toBeNull()
    fireEvent.click(screen.getByText('Fix'))
    await tick()

    fireEvent.click(screen.getByLabelText('Part options'))
    expect(screen.getByText('Unfix')).toBeTruthy()
    expect(screen.queryByText('Unground')).toBeNull()
  })

  // Fixing a part that is already in place must not re-solve: a re-solve can
  // slide the whole assembly along the solver's gauge freedom, which the user
  // sees as the camera jumping. The flag flips; nothing re-poses.
  it('fix toggle does not trigger a re-solve', async () => {
    await renderLoaded()
    await insertPart('Bracket')
    await waitFor(() => expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByLabelText('Part options'))
    fireEvent.click(screen.getByText('Fix'))
    await tick()
    expect(useAssemblyStore.getState().instances[0].fixed).toBe(true)
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2)
  })

  it('delete removes the instance', async () => {
    await renderLoaded()
    await insertPart('Bracket')
    fireEvent.click(screen.getByLabelText('Part options'))
    fireEvent.click(screen.getByText('Delete'))
    await tick()
    expect(useAssemblyStore.getState().instances).toHaveLength(0)
  })

  it('editing an instance opens the pink inline editor and fixes via its checkbox', async () => {
    await renderLoaded()
    await insertPart('Bracket')
    fireEvent.click(screen.getByLabelText('Edit part instance'))
    const fixed = screen.getByLabelText('Fixed') as HTMLInputElement
    expect(fixed.checked).toBe(false)
    fireEvent.click(fixed)
    await tick()
    expect(useAssemblyStore.getState().instances[0].fixed).toBe(true)
  })

  it('cancelling an instance edit reverts the fixed flag from the snapshot', async () => {
    await renderLoaded()
    await insertPart('Bracket')
    fireEvent.click(screen.getByLabelText('Edit part instance'))
    fireEvent.click(screen.getByLabelText('Fixed'))
    await tick()
    expect(useAssemblyStore.getState().instances[0].fixed).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await tick()
    await tick()  // let the revert's re-solve settle
    expect(useAssemblyStore.getState().instances[0].fixed).toBeFalsy()
  })

  it('cancelling an instance edit on a clean document does not mark it dirty', async () => {
    // The revert re-runs through `mutate`, which always sets dirty true; Cancel
    // must restore the flag to what it was when the editor opened, so a Cancel
    // on a saved doc cannot leave the save prompt lit.
    await renderLoaded()
    await insertPart('Bracket')
    fireEvent.click(screen.getByLabelText('Save'))
    await tick()
    await tick()
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)

    fireEvent.click(screen.getByLabelText('Edit part instance'))
    fireEvent.click(screen.getByLabelText('Fixed'))
    await tick()
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await tick()
    await tick()  // let the revert's re-solve settle
    expect(useAssemblyStore.getState().instances[0].fixed).toBeFalsy()
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  it('editing an instance sets its position from the numeric fields', async () => {
    await renderLoaded()
    await insertPart('Bracket')
    fireEvent.click(screen.getByLabelText('Edit part instance'))
    fireEvent.change(screen.getByLabelText('Position X'), { target: { value: '7' } })
    await tick()
    expect(useAssemblyStore.getState().instances[0].transform.tx).toBe(7)
  })

  // The viewport draws the settled solved pose while the stored transform is the
  // placement seed. A position edit must carry the two untouched axes from the
  // drawn pose; building them from the seed writes the seed back over the bake.
  it('edits an instance from the drawn solved pose, not the seed', async () => {
    await renderLoaded()
    await insertPart('Bracket')
    const handle = useAssemblyStore.getState().instances[0].handle
    act(() => {
      useAssemblyStore.setState({
        transforms: { [handle]: { tx: 10, ty: 20, tz: 30, qx: 0, qy: 0, qz: 0, qw: 1 } },
      })
    })

    fireEvent.click(screen.getByLabelText('Edit part instance'))
    await tick()
    fireEvent.change(screen.getByLabelText('Position X'), { target: { value: '5' } })
    await tick()
    expect(useAssemblyStore.getState().instances[0].transform).toMatchObject({ tx: 5, ty: 20, tz: 30 })
  })

  // The basis is frozen when the editor opens, so a background solve cannot
  // move the number fields under the typist. Switching the edited instance
  // recaptures it and resyncs.
  it('freezes the open instance editor basis and resyncs only when the edited instance changes', async () => {
    await renderLoaded()
    await insertPart('Bracket')
    await insertPart('Bolt')
    const [a, b] = useAssemblyStore.getState().instances

    fireEvent.click(screen.getAllByLabelText('Edit part instance')[0])
    await tick()

    // A background solve moves A while its editor is open.
    act(() => {
      useAssemblyStore.setState({
        transforms: { [a.handle]: { tx: 10, ty: 20, tz: 30, qx: 0, qy: 0, qz: 0, qw: 1 } },
      })
    })
    await tick()
    // The fields keep the frozen basis (the seed), not the solved pose.
    expect((screen.getByLabelText('Position Y') as HTMLInputElement).value).toBe('0')

    // Switching to B recaptures its drawn pose and resyncs the fields. While A
    // is editing its row shows OK/Cancel, so B's is the only pencil left.
    act(() => {
      useAssemblyStore.setState({
        transforms: {
          [a.handle]: { tx: 10, ty: 20, tz: 30, qx: 0, qy: 0, qz: 0, qw: 1 },
          [b.handle]: { tx: 0, ty: 6, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
        },
      })
    })
    fireEvent.click(screen.getAllByLabelText('Edit part instance')[0])
    await tick()
    expect((screen.getByLabelText('Position Y') as HTMLInputElement).value).toBe('6')
  })

  // A failed load has no document. The editor previously rendered its toolbar,
  // tree and viewport over the null doc (every mutation a silent no-op) with the
  // empty hint on top; now it is terminal, with one way back.
  it('shows a terminal panel and no live editor when the load fails', async () => {
    vi.mocked(backendBundle.documents.load).mockRejectedValueOnce(new Error('boom'))
    renderEditor()
    await tick()
    await tick()
    expect(screen.getByText(/Error: boom/)).toBeTruthy()
    expect(screen.queryByText(/Empty assembly/)).toBeNull()
    expect(screen.queryByLabelText('Insert part')).toBeNull()
  })

  it('the failed-load shell navigates back to the workspace, not the documents grid', async () => {
    vi.mocked(backendBundle.documents.load).mockRejectedValueOnce(new Error('boom'))
    renderEditor()
    await tick()
    await tick()
    fireEvent.click(screen.getByRole('button', { name: 'Back to documents' }))
    expect(navigateSpy).toHaveBeenCalledWith('/workspaces')
    expect(navigateSpy).not.toHaveBeenCalledWith('/documents')
  })

  // The editing subject is one tagged value, so an instance editor replaces an
  // open mate editor rather than stacking a second one. The store makes this
  // structural; the page test pins that the tree renders exactly one.
  it('opening an instance editor closes an open mate editor', async () => {
    await renderLoaded()
    await insertPart('Bracket')
    act(() => { executeCommand('insert_mate_fixed') })
    await tick()
    expect(screen.getAllByText('Pick a reference').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByLabelText('Edit part instance'))
    await tick()
    expect(screen.queryAllByText('Pick a reference')).toHaveLength(0)
    expect(useAssemblyStore.getState().editingSubject.kind).toBe('instance')
  })

  // Every toolbar button routes through the command registry, so a test can
  // replace the registered handler and prove the click reaches it.
  it('routes the toolbar through the command registry', async () => {
    await renderLoaded()
    const insertPart = vi.fn()
    const insertMate = vi.fn()
    const exportAssembly = vi.fn()
    registerCommand('insert_part_instance', insertPart)
    registerCommand('insert_mate_fixed', insertMate)
    registerCommand('export_assembly', exportAssembly)

    fireEvent.click(screen.getByLabelText('Insert part'))
    expect(insertPart).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByLabelText('Insert Fixed mate'))
    expect(insertMate).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByLabelText('Export assembly'))
    expect(exportAssembly).toHaveBeenCalledOnce()
  })

  // Escape is shared with modals. While a dialog claims it, the assembly
  // cancel_edit must stand down so dismissing the dialog does not also rewind an
  // open edit session (the assembly analogue of cancel_draw's stand-down).
  it('Escape while a modal is open does not cancel the open edit', async () => {
    await renderLoaded()
    await insertPart('Bracket')
    fireEvent.click(screen.getByLabelText('Edit part instance'))
    fireEvent.change(screen.getByLabelText('Position X'), { target: { value: '7' } })
    await tick()
    expect(useAssemblyStore.getState().instances[0].transform.tx).toBe(7)

    // Open the part picker: its Dialog claims Escape while it is up.
    act(() => { executeCommand('insert_part_instance') })
    await tick()

    // dispatchKey only maps Escape to cancel_edit while DocumentPage says the
    // assembly editor is active; set that here since this test mounts the page.
    useEditorModeStore.getState().setActiveEditor('assembly')
    fireEvent.keyDown(window, { key: 'Escape' })
    await tick()

    // The edit is still open and was not rewound to its pre-session position.
    expect(useAssemblyStore.getState().editingSubject.kind).toBe('instance')
    expect(useAssemblyStore.getState().instances[0].transform.tx).toBe(7)
    useEditorModeStore.getState().setActiveEditor(null)
  })

  it('clicking a part row selects it without opening the part document', async () => {
    await renderLoaded()
    await insertPart('Bracket')
    const handle = useAssemblyStore.getState().instances[0].handle
    await waitFor(() => screen.getByText('Bracket'))
    fireEvent.click(screen.getByText('Bracket'))
    await tick()
    // A click selects, it does not navigate into the part.
    expect(useAssemblyStore.getState().subject).toEqual({ kind: 'part', handle })
    expect(navigateSpy).not.toHaveBeenCalledWith('/documents/part-1')
  })

  it('the options menu opens the part in a new tab, never in place', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    await renderLoaded()
    await insertPart('Bracket')
    await waitFor(() => screen.getByText('Bracket'))
    fireEvent.click(screen.getByLabelText('Part options'))
    // Opening in place was dropped: a part now only ever opens in a new tab, so
    // the assembly it was reached from stays on screen behind it.
    expect(screen.queryByText('Open')).toBeNull()
    fireEvent.click(screen.getByText('Open in new tab'))
    await tick()
    expect(openSpy).toHaveBeenCalledWith('/workspaces/asm-1/entries/part-1', '_blank')
    expect(navigateSpy).not.toHaveBeenCalledWith('/documents/part-1')
    // Assembly state is unchanged by opening the part.
    expect(useAssemblyStore.getState().instances).toHaveLength(1)
    openSpy.mockRestore()
  })

  it('the options menu duplicates a part in place', async () => {
    await renderLoaded()
    await insertPart('Bracket')
    const original = useAssemblyStore.getState().instances[0]
    await waitFor(() => screen.getByText('Bracket'))
    fireEvent.click(screen.getByLabelText('Part options'))
    fireEvent.click(screen.getByText('Duplicate'))
    await tick()

    const insts = useAssemblyStore.getState().instances
    expect(insts).toHaveLength(2)
    expect(insts[1].doc_id).toBe(original.doc_id)
    expect(insts[1].handle).not.toBe(original.handle)
    // Both rows read the same name: an instance has no label of its own, it is
    // named after the document it references.
    expect(screen.getAllByText('Bracket')).toHaveLength(2)
  })
})
