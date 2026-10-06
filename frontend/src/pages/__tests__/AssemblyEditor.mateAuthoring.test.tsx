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

import { executeCommand } from '@/utils/core/commandRegistry'
import { assemblyEntityKey, type EntityMateRefs } from '@/utils/anchorCandidates'
import { findMate } from '@/utils/assemblyMutations'
import { MATE_KINDS } from '@/utils/mateKinds'
import { tick, renderEditor, installSessionFromList } from './AssemblyEditor.harness'

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
    useAssemblyStore.getState().selectMate(null)
    useAssemblyStore.setState({ editingSubject: { kind: 'none' } })
    installSessionFromList(h)
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

    // The dialog seeds from the name the row was showing: the mate's stored
    // default label, not the bare kind.
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
    expect(useAssemblyStore.getState().subject).toBeNull()
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
