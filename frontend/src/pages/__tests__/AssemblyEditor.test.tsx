import { describe, it, expect, vi, beforeEach } from 'vitest'
import { forwardRef, useImperativeHandle, type ReactNode } from 'react'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { executeCommand, registerCommand } from '@/utils/core/commandRegistry'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA } from '@/stores/assemblyStore'
import { assemblyEntityKey, type EntityMateRefs } from '@/utils/anchorCandidates'
import { findMate } from '@/utils/assemblyMutations'
import { MATE_KINDS } from '@/utils/mateKinds'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { useEditorModeStore } from '@/stores/editorModeStore'

const navigateSpy = vi.fn()
vi.mock('react-router-dom', () => ({
  // AppHeader reads the path to decide whether its burger navigates or opens
  // the about notice; these assembly routes are never the documents overview.
  useLocation: () => ({ pathname: '/documents/test-uuid' }),
  useNavigate: () => navigateSpy,
  // AppHeader (rendered via AssemblyToolbar) navigates with <Link>; a plain
  // anchor is enough for these tests, which assert on useNavigate instead.
  Link: ({ to, children, ...props }: { to: string; children?: ReactNode }) =>
    <a href={to} {...props}>{children}</a>,
}))

const h = vi.hoisted(() => ({
  loadContent: 'kind: assembly\nfeatures: []',
  partContent: 'features: []',
  list: [] as Array<{ uuid: string; name: string; meta?: { rev: number } }>,
  save: vi.fn(),
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

import AssemblyEditor from '@/pages/AssemblyEditor'
import { ToastProvider } from '@/contexts/ToastContext'

const tick = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

// The export dialog notifies on failure, so the page needs a toast host, exactly
// as it has under `main.tsx`.
function renderEditor() {
  return render(<ToastProvider><AssemblyEditor uuid="asm-1" /></ToastProvider>)
}

describe('AssemblyEditor (Stage 6b)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.loadContent = 'kind: assembly\nfeatures: []'
    h.list = [
      { uuid: 'part-1', name: 'Bracket', meta: { rev: 5 } },
      { uuid: 'part-2', name: 'Bolt', meta: { rev: 2 } },
    ]
    h.solveAssemblyViaWorker.mockResolvedValue({
      payload: { transforms: {}, bodies: {} },
    })
    h.save.mockResolvedValue(undefined)
    h.captureScreenshotForSaving.mockResolvedValue('data:image/png;base64,QVNN')
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.getState().setSelectedPartHandle(null)
    useAssemblyStore.getState().setActiveMateField(null)
    useAssemblyStore.getState().setSelectedMateId(null)
    useAssemblyStore.setState({ editingSubject: { kind: 'none' } })
  })

  async function renderLoaded() {
    renderEditor()
    await tick()
    await tick()
  }

  // The tree now labels an instance by its document name, so a same-named part
  // already in the tree collides with the picker item text. Scope the lookup to
  // the picker so a second insert of the same part still finds the right node.
  const pickerItem = (name: string) =>
    screen.getAllByText(name).find(el => el.closest('.doc-browser-tile'))

  async function insertPart(name: string) {
    act(() => { executeCommand('insert_part_instance') })
    // Picker lists owned docs (minus the assembly itself).
    await waitFor(() => expect(pickerItem(name)).toBeTruthy())
    fireEvent.click(pickerItem(name)!)
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }))
    await tick()
  }

  it('starts empty and shows the insert affordance', async () => {
    await renderLoaded()
    expect(screen.getByText(/Empty assembly/)).toBeTruthy()
    expect(screen.getByLabelText('Insert part')).toBeTruthy()
  })

  it('captures a viewport thumbnail and saves it as preview_image', async () => {
    await renderLoaded()
    fireEvent.click(screen.getByLabelText('Save'))
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1))
    expect(h.captureScreenshotForSaving).toHaveBeenCalled()
    const [savedUuid, body] = h.save.mock.calls[0]
    expect(savedUuid).toBe('asm-1')
    // saveDoc strips the data: prefix, storing the raw base64 the backend expects.
    expect(body.preview_image).toBe('QVNN')
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
    useAssemblyStore.getState().setSelectedPartHandle(handle)

    fireEvent.click(screen.getByLabelText('Part options'))
    fireEvent.click(screen.getByText('Delete'))
    await tick()
    await tick()  // let the delete's re-solve settle

    expect(useAssemblyStore.getState().selectedPartHandle).toBeNull()
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
    expect(useAssemblyStore.getState().selectedPartHandle).toBe(handle)
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
    expect(openSpy).toHaveBeenCalledWith('/documents/part-1', '_blank')
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

// Stage 8: mate authoring. The picks are synthetic ID-buffer hits fed straight
// to the store, because the viewport is mocked out here; the pointer surface
// that produces them is AssemblyViewport's, tested in assemblyPointer.
describe('AssemblyEditor mate authoring (Stage 8)', () => {
  const VERT_A = assemblyEntityKey('hA', 0, 'vertex', 0)
  const VERT_B = assemblyEntityKey('hB', 0, 'vertex', 0)
  const FREEFORM = assemblyEntityKey('hA', 0, 'face', 9)

  const ENTITY_MATE_REFS: EntityMateRefs = {
    [VERT_A]: [{ part: 'hA', anchor: 'a_v' }],
    [VERT_B]: [{ part: 'hB', anchor: 'b_v' }],
    [FREEFORM]: [],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    h.loadContent = 'kind: assembly\nfeatures: []'
    h.list = []
    h.solveAssemblyViaWorker.mockResolvedValue({
      payload: { transforms: {}, bodies: {} },
    })
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.getState().setActiveMateField(null)
    useAssemblyStore.getState().setSelectedMateId(null)
    useAssemblyStore.setState({ editingSubject: { kind: 'none' } })
  })

  // Stand in for a solve that has published the bundle's entity → anchor join.
  function publishPickLookup() {
    act(() => {
      useAssemblyStore.getState().setSolveResult({
        transforms: {}, bodies: {}, edgeCurves: {}, anchors: {}, pickGeometry: [],
        entityMateRefs: ENTITY_MATE_REFS, solveStatus: null,
      })
    })
  }

  async function renderWithMate(kind: string) {
    renderEditor()
    await tick()
    await tick()
    act(() => { executeCommand(`insert_mate_${kind}`) })
    await tick()
    publishPickLookup()
  }

  function pick(entityKey: string) {
    act(() => { useAssemblyStore.getState().pickFromHitsOrCycle([{ entityKey }]) })
  }

  function mateId(): string {
    return useAssemblyStore.getState().mates[0].id
  }

  function mateDef() {
    return findMate(useAssemblyStore.getState().doc!, mateId())!
  }

  it('an insert_mate command appends the mate and arms its first reference', async () => {
    await renderWithMate('spherical')
    expect(useAssemblyStore.getState().mates).toHaveLength(1)
    expect(mateDef().kind).toBe('spherical')
    expect(useAssemblyStore.getState().activeMateField).toEqual({ featureId: mateId(), field: 'ref_a' })
    // The row shows the mate's default name; its inline editor shows two empty
    // reference chips prompting a pick.
    expect(screen.getByText('Spherical 1')).toBeTruthy()
    expect(screen.getAllByText('Pick a reference')).toHaveLength(2)
  })

  it('picks on two different parts populate ref_a and ref_b as MateRefs', async () => {
    await renderWithMate('spherical')
    pick(VERT_A)
    await tick()

    // ref_a now names its pick, so the only prompting chip left is ref_b. Clicking
    // it arms that slot; the ID buffer emits globally unique keys, so the pick can
    // land on a different part without any selection-id change.
    fireEvent.click(screen.getByText('Pick a reference'))
    expect(useAssemblyStore.getState().activeMateField).toEqual({ featureId: mateId(), field: 'ref_b' })
    pick(VERT_B)
    await tick()

    expect(mateDef().ref_a).toEqual({ part: 'hA', anchor: 'a_v' })
    expect(mateDef().ref_b).toEqual({ part: 'hB', anchor: 'b_v' })
  })

  it('the armed chip shows the reference the document holds', async () => {
    await renderWithMate('fixed')
    pick(VERT_A)
    await tick()
    expect(screen.getByText('hA / a_v')).toBeTruthy()
  })

  it('a pick on an anchor-less entity commits nothing and leaves the slot empty', async () => {
    await renderWithMate('fixed')
    pick(FREEFORM)
    await tick()
    expect(mateDef().ref_a).toEqual({ part: '', anchor: '' })
  })

  it('picking does not re-solve; closing the field does, exactly once', async () => {
    await renderWithMate('fixed')
    await waitFor(() => expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1))  // the load solve
    pick(VERT_A)
    await tick()
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2))
  })

  // Clicking the armed chip disarms it, leaving the editor open.
  function disarm() {
    fireEvent.click(screen.getAllByText('Pick a reference')[0])
  }

  it('a mate parameter edit re-solves once no chip is armed', async () => {
    await renderWithMate('fixed')
    await waitFor(() => expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1))
    disarm()
    fireEvent.change(screen.getByLabelText('Offset X'), { target: { value: '5' } })
    await tick()
    expect(mateDef().offset).toEqual({ x: 5 })
    await waitFor(() => expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2))
  })

  // The deferral is not just about picks: a solve fired here would clear the
  // candidate set the still-armed field is cycling.
  it('a parameter edit while a chip is armed defers its solve to the disarm', async () => {
    await renderWithMate('fixed')
    await waitFor(() => expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByLabelText('Offset X'), { target: { value: '5' } })
    await tick()
    expect(mateDef().offset).toEqual({ x: 5 })
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1)

    disarm()
    await waitFor(() => expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2))
  })

  it('offers only the parameters the mate kind reads', async () => {
    await renderWithMate('spherical')
    expect(screen.queryByLabelText('Offset')).toBeNull()
    expect(screen.queryByLabelText('Ratio')).toBeNull()
  })

  describe('fixed mate angle', () => {
    it('clicking +90 twice stores angle: 180', async () => {
      await renderWithMate('fixed')
      disarm()
      fireEvent.click(screen.getByRole('button', { name: '+90°' }))
      await tick()
      fireEvent.click(screen.getByRole('button', { name: '+90°' }))
      await tick()
      expect(mateDef().angle).toBe(180)
    })

    it('keeps stepping +90 past 180, wrapping a full turn back to zero', async () => {
      // A third click used to be refused on the theory that a wrapped angle
      // locks the wrong roll. It does not: abs_roll_residual (mate_residuals.rs)
      // wraps the target-to-measured difference, so 270 and -90 are one pose.
      await renderWithMate('fixed')
      disarm()
      const plus90 = () => screen.getByRole('button', { name: '+90°' })
      for (const expected of [90, 180, 270, 0]) {
        fireEvent.click(plus90())
        await tick()
        expect(mateDef().angle).toBe(expected)
      }
    })

    it('normalises a typed out-of-range angle instead of refusing it', async () => {
      await renderWithMate('fixed')
      disarm()
      const input = screen.getByLabelText('Angle')
      fireEvent.change(input, { target: { value: '400' } })
      await tick()
      fireEvent.blur(input)
      await tick()
      expect(mateDef().angle).toBe(40)
    })

    it('an angle edit re-solves once no chip is armed, like offset', async () => {
      await renderWithMate('fixed')
      await waitFor(() => expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1))
      disarm()
      fireEvent.change(screen.getByLabelText('Angle'), { target: { value: '45' } })
      await tick()
      expect(mateDef().angle).toBe(45)
      await waitFor(() => expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2))
    })

    it('keeps every digit the user typed visible while the number grows', async () => {
      await renderWithMate('fixed')
      disarm()
      const input = screen.getByLabelText('Angle') as HTMLInputElement
      // Typed digit by digit: each keystroke commits, and the box must show
      // what was typed rather than snapping back. A controlled input bound
      // straight to the last-committed value would erase the keystroke in
      // flight; normalising per keystroke would fight the typist the same way.
      for (const typed of ['2', '27', '270']) {
        fireEvent.change(input, { target: { value: typed } })
        await tick()
        expect(input.value).toBe(typed)
      }
      expect(mateDef().angle).toBe(270)
    })

    it('an angle edit while a chip is armed defers its solve to the disarm', async () => {
      await renderWithMate('fixed')
      await waitFor(() => expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1))
      fireEvent.change(screen.getByLabelText('Angle'), { target: { value: '45' } })
      await tick()
      expect(mateDef().angle).toBe(45)
      expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1)

      disarm()
      await waitFor(() => expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2))
    })
  })

  // Fail-safe over fail-wrong: the dead ref is retained for a manual re-pick, and
  // the row goes red rather than silently re-targeting a different face.
  it('a stale ref renders the mate red with the dead reference retained', async () => {
    await renderWithMate('fixed')
    pick(VERT_A)
    await tick()

    const id = mateId()
    h.solveAssemblyViaWorker.mockResolvedValue({
      payload: {
        transforms: {}, bodies: {},
        status: {
          verdict: 'none', residualNorm: 0, rank: 0, dof: 0, iters: 0,
          mates: { [id]: { stale: true, staleRefs: ['ref_a'] } }, parts: {},
        },
      },
    })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(useAssemblyStore.getState().solveStatus?.mates[id]?.stale).toBe(true))

    expect(document.querySelector('.mate-item.stale')).toBeTruthy()
    expect(mateDef().ref_a).toEqual({ part: 'hA', anchor: 'a_v' })
  })

  it('renaming a mate from the tridot menu writes its label and shows it in the tree', async () => {
    await renderWithMate('fixed')
    disarm()
    fireEvent.click(screen.getByLabelText('Mate options'))
    fireEvent.click(screen.getByText('Rename'))

    // The dialog seeds from the name the row was showing, so an unlabelled mate
    // starts at its default rather than blank.
    const input = screen.getByLabelText('Name') as HTMLInputElement
    expect(input.value).toBe('Fixed 1')

    fireEvent.change(input, { target: { value: 'top clamp' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await tick()

    expect(mateDef().label).toBe('top clamp')
    expect(screen.getByText('top clamp')).toBeTruthy()
  })

  it('the mate parameter panel no longer carries a Name field', async () => {
    await renderWithMate('fixed')
    disarm()
    expect(screen.queryByLabelText('Mate name')).toBeNull()
    const labels = [...document.querySelectorAll('.mate-editor .feature-field-label')]
      .map(n => n.textContent)
    expect(labels).not.toContain('Name')
  })

  it('cancelling a mate edit reverts its parameters and closes the editor', async () => {
    await renderWithMate('fixed')
    disarm()
    fireEvent.change(screen.getByLabelText('Offset X'), { target: { value: '5' } })
    await tick()
    expect(mateDef().offset).toEqual({ x: 5 })

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await tick()
    await tick()  // let the revert's re-solve settle
    expect(useAssemblyStore.getState().selectedMateId).toBeNull()
    expect(mateDef().offset).toBeUndefined()
  })

  it('deleting a mate drops it and re-solves', async () => {
    await renderWithMate('fixed')
    await waitFor(() => expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByLabelText('Mate options'))
    fireEvent.click(screen.getByText('Delete'))
    await tick()
    expect(useAssemblyStore.getState().mates).toHaveLength(0)
    await waitFor(() => expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2))
  })

  it('inserts a mate from its toolbar button', async () => {
    renderEditor()
    await tick()
    await tick()
    fireEvent.click(screen.getByLabelText('Insert Rotating mate'))
    await tick()
    expect(useAssemblyStore.getState().mates).toHaveLength(1)
    expect(mateDef().kind).toBe('rotating')
  })

  it('shows one toolbar button per mate kind', async () => {
    renderEditor()
    await tick()
    const buttons = screen.getAllByLabelText(/^Insert .* mate$/)
    expect(buttons).toHaveLength(MATE_KINDS.length)
  })
})

// Stage 9: assembly export. Two paths that must not be confused: STEP rebuilds
// each part's B-rep on the OCC worker, STL re-encodes the solved meshes in place.
describe('AssemblyEditor export (Stage 9)', () => {
  const ASSEMBLY_WITH_PART = [
    'kind: assembly',
    'features:',
    '  - id: f1',
    '    kind: part_instance',
    '    instance:',
    '      handle: hA',
    '      doc_id: part-1',
    '      doc_rev: 1',
    '      transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }',
  ].join('\n')

  // One triangle, in the typed-array form the anchor solver always emits.
  const SOLVED_BODIES = {
    hA: [{
      vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      faceIdsPerTriangle: new Uint32Array([0]),
      edges: [],
    }],
  }
  const SOLVED_TRANSFORM = { tx: 3, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }

  beforeEach(() => {
    vi.clearAllMocks()
    h.loadContent = ASSEMBLY_WITH_PART
    h.partContent = 'features:\n  - id: Origin\n    kind: origin\n  - id: ex1\n    kind: extrude'
    h.list = [{ uuid: 'part-1', name: 'Bracket', meta: { rev: 1 } }]
    h.solveAssemblyViaWorker.mockResolvedValue({
      payload: { transforms: { hA: SOLVED_TRANSFORM }, bodies: SOLVED_BODIES },
    })
    h.exportAssemblyViaWorker.mockResolvedValue(new Uint8Array([1, 2, 3]))
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.getState().setActiveMateField(null)
    useAssemblyStore.getState().setSelectedMateId(null)
  })

  async function openExportDialog() {
    renderEditor()
    await tick()
    await tick()
    await waitFor(() => expect(useAssemblyStore.getState().transforms.hA).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Export assembly'))
    await waitFor(() => screen.getByText('Export Model'))
  }

  const download = () => fireEvent.click(screen.getByRole('button', { name: 'Download' }))

  it('opens from the sidebar button and from the export_assembly command', async () => {
    await openExportDialog()
    fireEvent.click(screen.getByTitle('Close'))
    expect(screen.queryByText('Export Model')).toBeNull()
    act(() => { executeCommand('export_assembly') })
    expect(screen.getByText('Export Model')).toBeTruthy()
  })

  it('hides the tessellation slider: assembly STL comes from the bundle meshes', async () => {
    await openExportDialog()
    fireEvent.click(screen.getByLabelText('STL'))
    expect(screen.queryByText('Tessellation Detail')).toBeNull()
  })

  it('STEP: sends every part with its solved transform, then downloads the bytes', async () => {
    await openExportDialog()
    download()
    await waitFor(() => expect(h.exportAssemblyViaWorker).toHaveBeenCalledTimes(1))

    const [parts, options] = h.exportAssemblyViaWorker.mock.calls[0]
    expect(options.format).toBe('step')
    expect(parts).toHaveLength(1)
    expect(parts[0].transform).toEqual(SOLVED_TRANSFORM)
    // Built-ins are seeded by initGlobalRepo, never solved as features.
    expect(parts[0].spec.features).toEqual([{ id: 'ex1', kind: 'extrude' }])
    expect(parts[0].spec.id).toBe('part-1')

    await waitFor(() => expect(h.downloadBlob).toHaveBeenCalledTimes(1))
    expect(h.downloadBlob.mock.calls[0][1]).toBe('My_Assembly.step')
    expect(screen.queryByText('Export Model')).toBeNull()  // dialog closes
  })

  it('STL: encodes the solved meshes without touching the OCC worker', async () => {
    await openExportDialog()
    fireEvent.click(screen.getByLabelText('STL'))
    download()
    await waitFor(() => expect(h.downloadBlob).toHaveBeenCalledTimes(1))

    expect(h.exportAssemblyViaWorker).not.toHaveBeenCalled()
    const [blob, name] = h.downloadBlob.mock.calls[0]
    expect(name).toBe('My_Assembly.stl')
    // 84-byte prefix + one 50-byte triangle: the solved mesh, re-encoded.
    expect(blob.size).toBe(84 + 50)
  })

  it('reports rather than downloads when the assembly has no visible geometry', async () => {
    h.solveAssemblyViaWorker.mockResolvedValue({
      payload: { transforms: { hA: SOLVED_TRANSFORM }, bodies: {} },
    })
    await openExportDialog()
    fireEvent.click(screen.getByLabelText('STL'))
    download()
    await waitFor(() => screen.getByText(/no solid geometry/i))
    expect(h.downloadBlob).not.toHaveBeenCalled()
  })

  it('surfaces a worker export failure as a notice, not an unhandled rejection', async () => {
    h.exportAssemblyViaWorker.mockRejectedValue(new Error('STEP export: Write failed'))
    await openExportDialog()
    download()
    await waitFor(() => screen.getByText(/Write failed/))
    expect(h.downloadBlob).not.toHaveBeenCalled()
  })

  it('refuses an assembly whose only part is hidden', async () => {
    h.loadContent = ASSEMBLY_WITH_PART + '\n      visible: false'
    await openExportDialog()
    download()
    await waitFor(() => screen.getByText(/no visible parts/i))
    expect(h.exportAssemblyViaWorker).not.toHaveBeenCalled()
  })
})

// Stage 10: assembly undo/redo. Every mutation funnels through the page's
// `mutate`, so these drive the real UI and assert the stack the store holds.
describe('AssemblyEditor undo/redo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.loadContent = 'kind: assembly\nfeatures: []'
    h.list = [{ uuid: 'part-1', name: 'Bracket', meta: { rev: 5 } }]
    h.solveAssemblyViaWorker.mockResolvedValue({
      payload: { transforms: {}, bodies: {} },
    })
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    // The stacks are store-owned, so setSnapshot does not clear them.
    useAssemblyStore.setState({ undoStack: [], redoStack: [] })
    useAssemblyStore.getState().setActiveMateField(null)
    useAssemblyStore.getState().setSelectedMateId(null)
  })

  const undoStack = () => useAssemblyStore.getState().undoStack
  const redoStack = () => useAssemblyStore.getState().redoStack

  const pickerItem = (name: string) =>
    screen.getAllByText(name).find(el => el.closest('.doc-browser-tile'))

  async function insertPart(name: string) {
    act(() => { executeCommand('insert_part_instance') })
    await waitFor(() => expect(pickerItem(name)).toBeTruthy())
    fireEvent.click(pickerItem(name)!)
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }))
    await tick()
  }

  it('add instance, undo -> instance gone; redo -> back; a fresh edit clears the redo branch', async () => {
    renderEditor()
    await tick()
    await tick()
    await insertPart('Bracket')
    expect(undoStack()).toHaveLength(1)
    const handle = useAssemblyStore.getState().instances[0].handle

    act(() => { executeCommand('undo') })
    await tick()
    await tick()
    expect(useAssemblyStore.getState().instances).toHaveLength(0)
    expect(undoStack()).toHaveLength(0)
    expect(redoStack()).toHaveLength(1)

    act(() => { executeCommand('redo') })
    await tick()
    await tick()
    expect(useAssemblyStore.getState().instances).toHaveLength(1)
    expect(useAssemblyStore.getState().instances[0].handle).toBe(handle)
    expect(undoStack()).toHaveLength(1)
    expect(redoStack()).toHaveLength(0)

    act(() => { executeCommand('undo') })
    await tick()
    await tick()
    expect(redoStack()).toHaveLength(1)
    await insertPart('Bracket')
    // A fresh edit after an undo discards the redo branch.
    expect(redoStack()).toHaveLength(0)
    expect(undoStack()).toHaveLength(1)
  })

  it('undo with a stale selectedPartHandle does not crash the delete-selected render', async () => {
    renderEditor()
    await tick()
    await tick()
    await insertPart('Bracket')
    expect(undoStack()).toHaveLength(1)
    const handle = useAssemblyStore.getState().instances[0].handle
    act(() => { useAssemblyStore.getState().setSelectedPartHandle(handle) })

    act(() => { executeCommand('undo') })
    await tick()
    await tick()

    // The undo restored a doc without the selected instance. The viewport triad
    // lookup and the Delete key both no-op on a vanished handle, but the
    // dangling value is exactly the class the undo reset exists to prevent.
    expect(useAssemblyStore.getState().instances).toHaveLength(0)
    expect(useAssemblyStore.getState().selectedPartHandle).toBeNull()
  })

  // The safety effect, not the undo reset: a live doc change (a reload, or a
  // tree edit that removes the selected instance without routing through the
  // tree delete's own clear) must retire a handle the loaded doc cannot resolve.
  it('a live doc change removing the selected instance clears the handle on the next render', async () => {
    act(() => { useAssemblyStore.getState().setSelectedPartHandle('ghost') })

    renderEditor()
    await tick()
    await tick()

    expect(useAssemblyStore.getState().selectedPartHandle).toBeNull()
  })

  it('Ctrl+Z in the assembly dispatches undo instead of being eaten', async () => {
    renderEditor()
    await tick()
    await tick()
    await insertPart('Bracket')
    expect(undoStack()).toHaveLength(1)

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    })
    await tick()
    await tick()

    expect(useAssemblyStore.getState().instances).toHaveLength(0)
    expect(undoStack()).toHaveLength(0)
  })

  it('a fix toggle from the options menu records one undo step and undo reverts it', async () => {
    renderEditor()
    await tick()
    await tick()
    await insertPart('Bracket')
    expect(undoStack()).toHaveLength(1)

    fireEvent.click(screen.getByLabelText('Part options'))
    fireEvent.click(screen.getByText('Fix'))
    await tick()
    expect(useAssemblyStore.getState().instances[0].fixed).toBe(true)
    expect(undoStack()).toHaveLength(2)

    act(() => { executeCommand('undo') })
    await tick()
    await tick()
    expect(useAssemblyStore.getState().instances[0].fixed).toBeFalsy()
  })

  // The editor's Fixed checkbox is a session edit (it folds into the coalesced
  // step the Accept commits), so a Cancel that reverts it must not charge a
  // phantom entry to the stack. The earlier test (Stage 6b) pins the flag
  // revert; this pins the stack stays exactly as it was.
  it('cancelling an instance edit charges no undo entry', async () => {
    renderEditor()
    await tick()
    await tick()
    await insertPart('Bracket')
    expect(undoStack()).toHaveLength(1)

    fireEvent.click(screen.getByLabelText('Edit part instance'))
    fireEvent.click(screen.getByLabelText('Fixed'))
    await tick()
    expect(useAssemblyStore.getState().instances[0].fixed).toBe(true)
    // The toggle pinned a coalescing session but pushed nothing on its own.
    expect(undoStack()).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await tick()
    await tick()
    expect(useAssemblyStore.getState().instances[0].fixed).toBeFalsy()
    // Cancel reverted the doc from its snapshot and dropped the session: no
    // step for the toggled flag, no redo branch either.
    expect(undoStack()).toHaveLength(1)
    expect(redoStack()).toHaveLength(0)

    // The surviving stack still works: undo removes the part itself.
    act(() => { executeCommand('undo') })
    await tick()
    await tick()
    expect(useAssemblyStore.getState().instances).toHaveLength(0)
    expect(undoStack()).toHaveLength(0)
  })

  // Solve results that actually place the parts. The shared beforeEach answers
  // with an empty transforms map, under which bakeSolvedTransforms is a silent
  // no-op and the whole class of bug below cannot appear.
  function solveWithPoses(pose: { tx: number; ty: number }) {
    h.solveAssemblyViaWorker.mockImplementation(async (_uuid: string, parts: Array<{ handle: string }>) => ({
      payload: {
        transforms: Object.fromEntries(parts.map(p => [
          p.handle, { tx: pose.tx, ty: pose.ty, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
        ])),
        bodies: {},
      },
    }))
  }

  const seeds = () => useAssemblyStore.getState().instances.map(i => ({ ...i.transform }))

  // Stand in for a save without driving the save path: what these tests need is
  // a meaningful pre-session value for Cancel to restore, not a persisted doc.
  const markSaved = () => act(() => { useUnsavedChangesStore.getState().setDirty(false) })

  // Every control in the instance editor (position, rotation, Fixed) bakes the
  // solved pose of EVERY non-fixed instance into its seed before applying the
  // edit, so a Cancel that restored only the edited instance left the other
  // instances' rewritten seeds in the document: no undo entry reaches them and
  // the restored clean flag tells the unsaved-changes guard there is nothing to
  // warn about. Repeated open/edit/cancel cycles compound solver error into the
  // seeds that way, which is exactly what the bake's own comment warns against.
  // The single-instance test above cannot see it: with one instance, the edited
  // one and the baked set are the same part.
  it('cancelling an instance edit reverts every instance the session baked, not just the edited one', async () => {
    solveWithPoses({ tx: 4, ty: 5 })
    renderEditor()
    await tick()
    await tick()
    await insertPart('Bracket')
    await insertPart('Bracket')
    markSaved()
    const before = seeds()
    const stackBefore = undoStack().length

    // Edit the FIRST instance; the second is the innocent bystander whose seed
    // the bake rewrites.
    fireEvent.click(screen.getAllByLabelText('Edit part instance')[0])
    fireEvent.change(screen.getByLabelText('Position X'), { target: { value: '7' } })
    await tick()
    expect(useAssemblyStore.getState().instances[0].transform.tx).toBe(7)
    expect(seeds()[1]).not.toEqual(before[1])  // the bake landed on the other part too

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await tick()
    await tick()  // let the rewind's re-solve settle

    expect(seeds()).toEqual(before)
    expect(undoStack()).toHaveLength(stackBefore)
    expect(redoStack()).toHaveLength(0)
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  // The other half of the same contract: a Cancel that reverts a real change is
  // only safe because a Cancel that reverts nothing touches nothing. With no
  // session pinned there is no pre-session doc, so the doc object must survive
  // the close by identity and the dirty flag must be left where it stands.
  it('cancelling an instance edit that changed nothing rewinds nothing', async () => {
    solveWithPoses({ tx: 4, ty: 5 })
    renderEditor()
    await tick()
    await tick()
    await insertPart('Bracket')
    markSaved()
    const docBefore = useAssemblyStore.getState().doc
    const stackBefore = undoStack().length

    fireEvent.click(screen.getByLabelText('Edit part instance'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await tick()
    await tick()

    expect(useAssemblyStore.getState().doc).toBe(docBefore)
    expect(undoStack()).toHaveLength(stackBefore)
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  // The dirty flag is pinned by the session's first edit, not by the editor
  // opening: a one-shot landing in between (here a visibility toggle on the
  // other row) is a real unsaved change with its own undo entry, and the Cancel
  // must leave the save prompt lit for it.
  it('cancelling an instance edit keeps the doc dirty for a one-shot that landed mid-editor', async () => {
    solveWithPoses({ tx: 4, ty: 5 })
    renderEditor()
    await tick()
    await tick()
    await insertPart('Bracket')
    await insertPart('Bracket')
    markSaved()

    fireEvent.click(screen.getAllByLabelText('Edit part instance')[0])
    // The editor is open but has pinned nothing yet; the other row's eye is a
    // one-shot with its own step.
    fireEvent.click(screen.getByLabelText('Hide part'))
    await tick()
    expect(useAssemblyStore.getState().instances[1].visible).toBe(false)
    const afterToggle = seeds()
    const stackAfterToggle = undoStack().length

    fireEvent.change(screen.getByLabelText('Position X'), { target: { value: '7' } })
    await tick()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await tick()
    await tick()

    expect(seeds()).toEqual(afterToggle)
    expect(useAssemblyStore.getState().instances[1].visible).toBe(false)
    expect(undoStack()).toHaveLength(stackAfterToggle)
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })

  it('a visibility toggle records one undo step and undo restores it', async () => {
    renderEditor()
    await tick()
    await tick()
    await insertPart('Bracket')
    expect(undoStack()).toHaveLength(1)

    fireEvent.click(screen.getByLabelText('Hide part'))
    await tick()
    expect(useAssemblyStore.getState().instances[0].visible).toBe(false)
    expect(undoStack()).toHaveLength(2)

    act(() => { executeCommand('undo') })
    await tick()
    await tick()
    expect(useAssemblyStore.getState().instances[0].visible).toBe(true)
  })

  it('a duplicate records one undo step and undo removes the copy', async () => {
    renderEditor()
    await tick()
    await tick()
    await insertPart('Bracket')
    expect(undoStack()).toHaveLength(1)

    fireEvent.click(screen.getByLabelText('Part options'))
    fireEvent.click(screen.getByText('Duplicate'))
    await tick()
    expect(useAssemblyStore.getState().instances).toHaveLength(2)
    expect(undoStack()).toHaveLength(2)

    act(() => { executeCommand('undo') })
    await tick()
    await tick()
    expect(useAssemblyStore.getState().instances).toHaveLength(1)
  })

  it('a mate rename records one undo step and undo reverts the label', async () => {
    renderEditor()
    await tick()
    await tick()
    act(() => { executeCommand('insert_mate_fixed') })
    await tick()
    expect(undoStack()).toHaveLength(1)  // the Add mate step

    // The row's tridot opens the rename dialog; it must not fold into the open
    // authoring session as a per-keystroke edit.
    fireEvent.click(screen.getByLabelText('Mate options'))
    fireEvent.click(screen.getByText('Rename'))
    const input = screen.getByLabelText('Name') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'top clamp' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await tick()

    const id = useAssemblyStore.getState().mates[0].id
    expect(findMate(useAssemblyStore.getState().doc!, id)!.label).toBe('top clamp')
    expect(undoStack()).toHaveLength(2)

    act(() => { executeCommand('undo') })
    await tick()
    await tick()
    expect(findMate(useAssemblyStore.getState().doc!, id)!.label).toBeUndefined()
  })

  // The funnel's content-level no-op guard: a rename that writes back the label
  // already held mints a fresh doc but changes nothing, so it must not push a
  // dead entry, mark the doc dirty or clear the redo branch.
  it('renaming a mate to its current label pushes nothing, stays clean and keeps redo', async () => {
    renderEditor()
    await tick()
    await tick()
    act(() => { executeCommand('insert_mate_fixed') })
    await tick()
    expect(undoStack()).toHaveLength(1)

    const renameTo = async (name: string) => {
      fireEvent.click(screen.getByLabelText('Mate options'))
      fireEvent.click(screen.getByText('Rename'))
      const input = screen.getByLabelText('Name') as HTMLInputElement
      fireEvent.change(input, { target: { value: name } })
      fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
      await tick()
    }
    await renameTo('top clamp')
    expect(undoStack()).toHaveLength(2)
    await renameTo('other')
    expect(undoStack()).toHaveLength(3)

    // Undo back to 'top clamp', filling the redo branch.
    act(() => { executeCommand('undo') })
    await tick()
    await tick()
    expect(undoStack()).toHaveLength(2)
    expect(redoStack()).toHaveLength(1)
    const id = useAssemblyStore.getState().mates[0].id
    expect(findMate(useAssemblyStore.getState().doc!, id)!.label).toBe('top clamp')
    useUnsavedChangesStore.getState().setDirty(false)

    // Renaming to the label already held is a value no-op: no step, no dirty,
    // and the redo branch survives because nothing new was recorded.
    await renameTo('top clamp')
    expect(undoStack()).toHaveLength(2)
    expect(redoStack()).toHaveLength(1)
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  it('a mate delete records one undo step and undo restores the mate', async () => {
    renderEditor()
    await tick()
    await tick()
    act(() => { executeCommand('insert_mate_fixed') })
    await tick()
    expect(undoStack()).toHaveLength(1)

    fireEvent.click(screen.getByLabelText('Mate options'))
    fireEvent.click(screen.getByText('Delete'))
    await tick()
    expect(useAssemblyStore.getState().mates).toHaveLength(0)
    expect(undoStack()).toHaveLength(2)

    act(() => { executeCommand('undo') })
    await tick()
    await tick()
    expect(useAssemblyStore.getState().mates).toHaveLength(1)
  })

  it('typing a mate offset is ONE undo entry per field close, not per keystroke', async () => {
    renderEditor()
    await tick()
    await tick()
    act(() => { executeCommand('insert_mate_fixed') })
    await tick()
    // A fresh mate opens straight into its editor, which is the coalescing
    // session; the insert itself already recorded its own step.
    expect(undoStack()).toHaveLength(1)

    // Each keystroke fires a mutate; all must fold into the open session.
    const offset = screen.getByLabelText('Offset X')
    fireEvent.change(offset, { target: { value: '5' } })
    await tick()
    fireEvent.change(offset, { target: { value: '50' } })
    await tick()
    fireEvent.change(offset, { target: { value: '500' } })
    await tick()
    const id = useAssemblyStore.getState().mates[0].id
    expect(findMate(useAssemblyStore.getState().doc!, id)!.offset).toEqual({ x: 500 })
    expect(undoStack()).toHaveLength(1)

    // Closing the field (OK) commits exactly one coalesced step.
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await tick()
    expect(undoStack()).toHaveLength(2)

    act(() => { executeCommand('undo') })
    await tick()
    await tick()
    expect(findMate(useAssemblyStore.getState().doc!, id)!.offset).toBeUndefined()
  })

  it('undo while authoring a mate disarms the field and drops its candidates', async () => {
    const VERT = assemblyEntityKey('hA', 0, 'vertex', 0)
    renderEditor()
    await tick()
    await tick()
    act(() => { executeCommand('insert_mate_fixed') })
    await tick()
    const id = useAssemblyStore.getState().mates[0].id
    expect(useAssemblyStore.getState().activeMateField).toEqual({ featureId: id, field: 'ref_a' })

    // The armed field has a candidate aimed; the undo restores a doc without the
    // mate, so nothing may keep aiming into it.
    act(() => {
      useAssemblyStore.getState().setSolveResult({
        transforms: {}, bodies: {}, edgeCurves: {}, anchors: {}, pickGeometry: [],
        entityMateRefs: { [VERT]: [{ part: 'hA', anchor: 'a_v' }] }, solveStatus: null,
      })
      useAssemblyStore.getState().setPickFromHits([{ entityKey: VERT }])
    })
    expect(useAssemblyStore.getState().pickCandidates).toHaveLength(1)

    act(() => { executeCommand('undo') })
    await tick()
    await tick()

    expect(useAssemblyStore.getState().activeMateField).toBeNull()
    expect(useAssemblyStore.getState().pickCandidates).toEqual([])
    expect(useAssemblyStore.getState().mates).toHaveLength(0)
  })

  it('a fresh document load clears the previous document history', async () => {
    const first = renderEditor()
    await tick()
    await tick()
    await insertPart('Bracket')
    expect(undoStack()).toHaveLength(1)

    // Unmounting and reloading the same route re-runs useAssemblyDoc's load,
    // which must not let the previous document's undo steps leak into the new
    // document (Ctrl+Z would otherwise restore A's content under B's uuid).
    first.unmount()
    renderEditor()
    await tick()
    await tick()

    expect(undoStack()).toHaveLength(0)
  })

  // Route-level unmount with an editor open: the page keys by uuid, so this is
  // the key-remount path. The unmount must commit the pinned session BEFORE the
  // load clears the stacks, or the pending edits would die unreachable by undo.
  it('route-level unmount commits a pending session; history survives until the next load clears it', async () => {
    const first = renderEditor()
    await tick()
    await tick()
    act(() => { executeCommand('insert_mate_fixed') })
    await tick()
    expect(undoStack()).toHaveLength(1)  // the Add mate step

    // A mate offset edit pins a coalescing session on its keystroke.
    fireEvent.change(screen.getByLabelText('Offset X'), { target: { value: '5' } })
    await tick()
    const id = useAssemblyStore.getState().mates[0].id
    expect(findMate(useAssemblyStore.getState().doc!, id)!.offset).toEqual({ x: 5 })
    expect(undoStack()).toHaveLength(1)  // still coalesced behind the open editor

    // Navigating away unmounts the page with the editor open. The unmount must
    // commit the pinned session (the edit is already in the doc, so leaving it
    // without an undo entry would make it unreachable by undo for good) before
    // it resets the store's mirrored scene to default, which the unmount does
    // too now so the next assembly's first render never paints this document's
    // stale bodies/transforms/doc.
    first.unmount()
    expect(undoStack().map(e => e.label)).toEqual(['Add mate', 'Edit mate'])
    // The store's mirrored doc is cleared with the rest of the scene on unmount;
    // the committed edit survives only in the undo stack's pre-session snapshot
    // until the next load's clearAssemblyHistory retires it below.
    expect(useAssemblyStore.getState().doc).toBeNull()

    // The next load clears history (out by design), so the remount starts empty.
    renderEditor()
    await tick()
    await tick()
    expect(undoStack()).toHaveLength(0)
  })

  it('a reorder of instances records one undo step and undo restores the order', async () => {
    renderEditor()
    await tick()
    await tick()
    await insertPart('Bracket')
    await insertPart('Bracket')
    const before = useAssemblyStore.getState().instances.map(i => i.handle)
    expect(undoStack()).toHaveLength(2)

    const rows = screen.getAllByText('Bracket').map(n => n.closest('li')!)
    fireEvent.dragStart(rows[1], { dataTransfer: { effectAllowed: 'move' } })
    fireEvent.dragOver(rows[0], { dataTransfer: { effectAllowed: 'move' } })
    fireEvent.drop(rows[0], { dataTransfer: { effectAllowed: 'move' } })
    await tick()

    const after = useAssemblyStore.getState().instances.map(i => i.handle)
    expect(after[0]).toBe(before[1])
    expect(undoStack()).toHaveLength(3)

    act(() => { executeCommand('undo') })
    await tick()
    await tick()
    expect(useAssemblyStore.getState().instances.map(i => i.handle)).toEqual(before)
  })

  it('a reorder of mates records one undo step and undo restores the order', async () => {
    renderEditor()
    await tick()
    await tick()
    act(() => { executeCommand('insert_mate_fixed') })
    await tick()
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))  // close mate 1's editor
    await tick()
    act(() => { executeCommand('insert_mate_fixed') })
    await tick()
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))  // close mate 2's editor
    await tick()
    expect(undoStack()).toHaveLength(2)
    const before = useAssemblyStore.getState().mates.map(m => m.id)

    const rows = screen.getAllByText(/^Fixed \d+$/).map(n => n.closest('li')!)
    fireEvent.dragStart(rows[1], { dataTransfer: { effectAllowed: 'move' } })
    fireEvent.dragOver(rows[0], { dataTransfer: { effectAllowed: 'move' } })
    fireEvent.drop(rows[0], { dataTransfer: { effectAllowed: 'move' } })
    await tick()

    expect(useAssemblyStore.getState().mates.map(m => m.id)[0]).toBe(before[1])
    expect(undoStack()).toHaveLength(3)

    act(() => { executeCommand('undo') })
    await tick()
    await tick()
    expect(useAssemblyStore.getState().mates.map(m => m.id)).toEqual(before)
  })

  // The coalescing linchpin under interleaving: a structural op mid-session must
  // not fold into (or duplicate) the session's pinned pre-doc. The session
  // closes before the one-shot, so the stack's pre-docs are distinct and in
  // order, and undoing the one-shot does not drag the session's edits along.
  it('a structural op between mate keystrokes keeps each undo step distinct', async () => {
    renderEditor()
    await tick()
    await tick()
    await insertPart('Bracket')
    act(() => { executeCommand('insert_mate_fixed') })
    await tick()
    expect(undoStack().map(e => e.label)).toEqual(['Add part', 'Add mate'])

    // Session A: type an offset (coalesced).
    const offset = screen.getByLabelText('Offset X')
    fireEvent.change(offset, { target: { value: '5' } })
    await tick()

    // Structural op mid-session: a visibility toggle must close session A and
    // push its own step with the post-offset doc as its pre-doc.
    fireEvent.click(screen.getByLabelText('Hide part'))
    await tick()
    expect(undoStack().map(e => e.label)).toEqual(['Add part', 'Add mate', 'Edit mate', 'Toggle visibility'])

    // Session B: keep typing, then accept.
    fireEvent.change(offset, { target: { value: '50' } })
    await tick()
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await tick()
    expect(undoStack().map(e => e.label)).toEqual([
      'Add part', 'Add mate', 'Edit mate', 'Toggle visibility', 'Edit mate',
    ])

    // Every entry captured a real step: adjacent snapshots never collapse into
    // the same document (no-op mutations are guarded away from pushUndo).
    // Entries are cloned since pushUndo, so reference identity can no longer
    // pin anything here.
    const docs = undoStack().map(e => e.doc)
    for (let i = 1; i < docs.length; i++) {
      expect(docs[i]).not.toEqual(docs[i - 1])
    }

    // Undo 1 reverts only the second offset batch; the visibility stays off.
    act(() => { executeCommand('undo') })
    await tick()
    await tick()
    const id = useAssemblyStore.getState().mates[0].id
    expect(findMate(useAssemblyStore.getState().doc!, id)!.offset).toEqual({ x: 5 })
    expect(useAssemblyStore.getState().instances[0].visible).toBe(false)

    // Undo 2 reverts only the visibility toggle; the offset stays at 5.
    act(() => { executeCommand('undo') })
    await tick()
    await tick()
    expect(useAssemblyStore.getState().instances[0].visible).toBe(true)
    expect(findMate(useAssemblyStore.getState().doc!, id)!.offset).toEqual({ x: 5 })
  })

  // SHOULD FIX 3: inserting a mate while another editor is open pushes its own
  // step, so cancelling the new editor cannot lose the insert.
  it('an insert while another editor is open stays undoable even if the new editor is cancelled', async () => {
    renderEditor()
    await tick()
    await tick()
    act(() => { executeCommand('insert_mate_fixed') })
    await tick()
    expect(undoStack()).toHaveLength(1)

    // A second insert lands while mate 1's editor is open.
    act(() => { executeCommand('insert_mate_fixed') })
    await tick()
    expect(undoStack()).toHaveLength(2)

    // Cancel the new mate's editor: the empty mate stays and keeps its step.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await tick()
    await tick()
    expect(useAssemblyStore.getState().mates).toHaveLength(2)
    expect(undoStack()).toHaveLength(2)

    act(() => { executeCommand('undo') })
    await tick()
    await tick()
    expect(useAssemblyStore.getState().mates).toHaveLength(1)
  })

  // Editor switches commit the open session so each edited mate's changes land
  // in their own step rather than merging under the first mate's pre-doc.
  it('switching between mate editors commits each session separately', async () => {
    renderEditor()
    await tick()
    await tick()
    act(() => { executeCommand('insert_mate_fixed') })
    await tick()
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))  // close mate 1
    await tick()
    act(() => { executeCommand('insert_mate_fixed') })
    await tick()
    const second = useAssemblyStore.getState().mates[1].id

    // Type an offset into mate 2's editor, then pencil-edit mate 1.
    fireEvent.change(screen.getByLabelText('Offset X'), { target: { value: '7' } })
    await tick()
    expect(undoStack()).toHaveLength(2)  // the keystrokes stay coalesced

    fireEvent.click(screen.getAllByLabelText('Edit mate')[0])
    await tick()
    // The switch commits mate 2's session as its own step.
    expect(undoStack()).toHaveLength(3)

    act(() => { executeCommand('undo') })
    await tick()
    await tick()
    // The undone step is mate 2's edit, not a merge of both.
    expect(findMate(useAssemblyStore.getState().doc!, second)!.offset).toBeUndefined()
    const first = useAssemblyStore.getState().mates[0].id
    expect(findMate(useAssemblyStore.getState().doc!, first)!.offset).toBeUndefined()
  })

  // Session hygiene: a toolbar mate insert while the instance editor is open
  // must close and commit the instance session FIRST, so no two editors share
  // the coalescing buffer and cancelling the mate cannot drop the instance's
  // already-applied edits.
  it('a toolbar mate insert closes an open instance editor and commits its session first', async () => {
    renderEditor()
    await tick()
    await tick()
    await insertPart('Bracket')

    // Instance editor open; type a position so a coalesced session pins.
    fireEvent.click(screen.getByLabelText('Edit part instance'))
    fireEvent.change(screen.getByLabelText('Position X'), { target: { value: '7' } })
    await tick()
    expect(useAssemblyStore.getState().instances[0].transform.tx).toBe(7)
    expect(undoStack()).toHaveLength(1)  // the Add part step; the position edit stays coalesced

    fireEvent.click(screen.getByLabelText('Insert Fixed mate'))
    await tick()
    // The instance editor is closed, the mate editor took its place.
    expect(screen.queryByLabelText('Position X')).toBeNull()
    expect(screen.getByLabelText('Offset X')).toBeTruthy()
    // The switch committed the instance session as its own step, and the insert
    // pushed its own: three distinct pre-docs, nothing shared.
    expect(undoStack().map(e => e.label)).toEqual(['Add part', 'Set position', 'Add mate'])

    // Cancel the mate drops only its own session.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await tick()
    await tick()
    expect(undoStack().map(e => e.label)).toEqual(['Add part', 'Set position', 'Add mate'])
    expect(useAssemblyStore.getState().instances[0].transform.tx).toBe(7)
  })

  it('after an instance edit, a mate insert then cancel, undo still reverts the instance edit', async () => {
    renderEditor()
    await tick()
    await tick()
    await insertPart('Bracket')

    fireEvent.click(screen.getByLabelText('Edit part instance'))
    fireEvent.change(screen.getByLabelText('Position X'), { target: { value: '7' } })
    await tick()
    fireEvent.click(screen.getByLabelText('Insert Fixed mate'))
    await tick()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await tick()
    await tick()
    expect(useAssemblyStore.getState().instances[0].transform.tx).toBe(7)

    // Undo 1 removes the inserted mate; undo 2 reverts the committed instance edit.
    act(() => { executeCommand('undo') })
    await tick()
    await tick()
    expect(useAssemblyStore.getState().mates).toHaveLength(0)
    expect(useAssemblyStore.getState().instances[0].transform.tx).toBe(7)

    act(() => { executeCommand('undo') })
    await tick()
    await tick()
    expect(useAssemblyStore.getState().instances[0].transform.tx).toBe(0)
  })
})

