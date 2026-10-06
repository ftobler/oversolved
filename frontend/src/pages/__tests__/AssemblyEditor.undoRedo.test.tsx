import { describe, it, expect, vi, beforeEach } from 'vitest'
import { forwardRef, useImperativeHandle, type ReactNode } from 'react'
import { screen, fireEvent, act } from '@testing-library/react'
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

import { executeCommand } from '@/utils/core/commandRegistry'
import { assemblyEntityKey } from '@/utils/anchorCandidates'
import { findMate } from '@/utils/assemblyMutations'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { tick, renderEditor, installSessionFromList, insertPart } from './AssemblyEditor.harness'

// Stage 10: assembly undo/redo. Every mutation funnels through the page's
// `mutate`, so these drive the real UI and assert the stack the store holds.
describe('AssemblyEditor undo/redo', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.loadContent = 'kind: assembly\nfeatures: []'
    h.list = [{ uuid: 'part-1', name: 'Bracket', kind: 'part', meta: { rev: 5 } }]
    h.solveAssemblyViaWorker.mockResolvedValue({
      payload: { transforms: {}, bodies: {} },
    })
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    // The stacks are store-owned, so setSnapshot does not clear them.
    useAssemblyStore.setState({ undoStack: [], redoStack: [] })
    useAssemblyStore.getState().setActiveMateField(null)
    useAssemblyStore.getState().selectMate(null)
    installSessionFromList(h)
  })

  const undoStack = () => useAssemblyStore.getState().undoStack
  const redoStack = () => useAssemblyStore.getState().redoStack

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

  it('undo with a stale selected subject does not crash the delete-selected render', async () => {
    renderEditor()
    await tick()
    await tick()
    await insertPart('Bracket')
    expect(undoStack()).toHaveLength(1)
    const handle = useAssemblyStore.getState().instances[0].handle
    act(() => { useAssemblyStore.getState().selectPart(handle) })

    act(() => { executeCommand('undo') })
    await tick()
    await tick()

    // The undo restored a doc without the selected instance. The viewport triad
    // lookup and the Delete key both no-op on a vanished handle, but the
    // dangling value is exactly the class the undo reset exists to prevent.
    expect(useAssemblyStore.getState().instances).toHaveLength(0)
    expect(useAssemblyStore.getState().subject).toBeNull()
  })

  // The safety effect, not the undo reset: a live doc change (a reload, or a
  // tree edit that removes the selected instance without routing through the
  // tree delete's own clear) must retire a handle the loaded doc cannot resolve.
  it('a live doc change removing the selected instance clears the handle on the next render', async () => {
    act(() => { useAssemblyStore.getState().selectPart('ghost') })

    renderEditor()
    await tick()
    await tick()

    expect(useAssemblyStore.getState().subject).toBeNull()
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
    // Undo reverts to the mate as inserted, which now carries its minted
    // default label rather than falling back to a render ordinal.
    expect(findMate(useAssemblyStore.getState().doc!, id)!.label).toBe('Fixed 1')
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

  // The L3 split: the callback effect used to commit the open session in its
  // cleanup, so every re-registration closed it. This pins the close-commit
  // invariant (one entry per editor close) that the split protects.
  it('an instance edit commits as exactly one coalesced entry on OK', async () => {
    renderEditor()
    await tick()
    await tick()
    await insertPart('Bracket')
    expect(undoStack()).toHaveLength(1)  // Add part

    fireEvent.click(screen.getByLabelText('Edit part instance'))
    fireEvent.change(screen.getByLabelText('Position X'), { target: { value: '7' } })
    await tick()
    // The keystroke is already in the doc but coalesced behind the open editor.
    expect(useAssemblyStore.getState().instances[0].transform.tx).toBe(7)
    expect(undoStack()).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await tick()
    expect(undoStack().map(e => e.label)).toEqual(['Add part', 'Set position'])

    act(() => { executeCommand('undo') })
    await tick()
    await tick()
    expect(useAssemblyStore.getState().instances[0].transform.tx).toBe(0)
  })

  it('switching instance editors keeps each edit in its own undo step', async () => {
    renderEditor()
    await tick()
    await tick()
    await insertPart('Bracket')
    await insertPart('Bracket')
    expect(undoStack()).toHaveLength(2)  // two Add part steps

    // Editor A: edit instance 0; its own Edit button is replaced by OK/Cancel,
    // so the one Edit button left is instance 1's.
    fireEvent.click(screen.getAllByLabelText('Edit part instance')[0])
    fireEvent.change(screen.getByLabelText('Position X'), { target: { value: '7' } })
    await tick()
    expect(undoStack()).toHaveLength(2)  // still coalesced

    // Opening editor B closes A: A's edit lands as its own step, not merged.
    fireEvent.click(screen.getAllByLabelText('Edit part instance')[0])
    await tick()
    expect(undoStack().map(e => e.label)).toEqual(['Add part', 'Add part', 'Set position'])

    fireEvent.change(screen.getByLabelText('Position X'), { target: { value: '9' } })
    await tick()
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await tick()
    expect(undoStack().map(e => e.label)).toEqual(['Add part', 'Add part', 'Set position', 'Set position'])

    // Undo reverts only B's edit; A's stays.
    act(() => { executeCommand('undo') })
    await tick()
    await tick()
    expect(useAssemblyStore.getState().instances[1].transform.tx).toBe(0)
    expect(useAssemblyStore.getState().instances[0].transform.tx).toBe(7)
  })
})
