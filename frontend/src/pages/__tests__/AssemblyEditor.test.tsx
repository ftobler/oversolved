import { describe, it, expect, vi, beforeEach } from 'vitest'
import { forwardRef, useImperativeHandle, type ReactNode } from 'react'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { executeCommand } from '@/utils/core/commandRegistry'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA } from '@/stores/assemblyStore'
import { assemblyEntityKey, type EntityMateRefs } from '@/utils/anchorCandidates'
import { findMate } from '@/utils/assemblyMutations'

const navigateSpy = vi.fn()
vi.mock('react-router-dom', () => ({
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
    },
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
      payload: { transforms: {}, bodies: {}, mateResults: {} },
    })
    h.save.mockResolvedValue(undefined)
    h.captureScreenshotForSaving.mockResolvedValue('data:image/png;base64,QVNN')
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.getState().setActivePartHandle(null)
    useAssemblyStore.getState().setSelectedPartHandle(null)
    useAssemblyStore.getState().setActiveMateField(null)
    useAssemblyStore.getState().setSelectedMateId(null)
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
    screen.getAllByText(name).find(el => el.closest('.assembly-part-picker-item'))

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

  it('ground toggle (in the options menu) marks the instance fixed', async () => {
    await renderLoaded()
    await insertPart('Bracket')
    fireEvent.click(screen.getByLabelText('Part options'))
    fireEvent.click(screen.getByText('Ground (fix)'))
    await tick()
    expect(useAssemblyStore.getState().instances[0].fixed).toBe(true)
  })

  // Grounding a part that is already in place must not re-solve: a re-solve can
  // slide the whole assembly along the solver's gauge freedom, which the user
  // sees as the camera jumping. The flag flips; nothing re-poses.
  it('ground toggle does not trigger a re-solve', async () => {
    await renderLoaded()
    await insertPart('Bracket')
    await waitFor(() => expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByLabelText('Part options'))
    fireEvent.click(screen.getByText('Ground (fix)'))
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

  it('editing an instance opens the pink inline editor and grounds via its checkbox', async () => {
    await renderLoaded()
    await insertPart('Bracket')
    fireEvent.click(screen.getByLabelText('Edit part instance'))
    const grounded = screen.getByLabelText('Grounded') as HTMLInputElement
    expect(grounded.checked).toBe(false)
    fireEvent.click(grounded)
    await tick()
    expect(useAssemblyStore.getState().instances[0].fixed).toBe(true)
  })

  it('cancelling an instance edit reverts the grounded flag from the snapshot', async () => {
    await renderLoaded()
    await insertPart('Bracket')
    fireEvent.click(screen.getByLabelText('Edit part instance'))
    fireEvent.click(screen.getByLabelText('Grounded'))
    await tick()
    expect(useAssemblyStore.getState().instances[0].fixed).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await tick()
    await tick()  // let the revert's re-solve settle
    expect(useAssemblyStore.getState().instances[0].fixed).toBeFalsy()
  })

  it('editing an instance sets its position from the numeric fields', async () => {
    await renderLoaded()
    await insertPart('Bracket')
    fireEvent.click(screen.getByLabelText('Edit part instance'))
    fireEvent.change(screen.getByLabelText('Position X'), { target: { value: '7' } })
    await tick()
    expect(useAssemblyStore.getState().instances[0].transform.tx).toBe(7)
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
    expect(useAssemblyStore.getState().activePartHandle).toBeNull()
    expect(navigateSpy).not.toHaveBeenCalledWith('/documents/part-1')
  })

  it('the options menu opens the part document', async () => {
    await renderLoaded()
    await insertPart('Bracket')
    const handle = useAssemblyStore.getState().instances[0].handle
    await waitFor(() => screen.getByText('Bracket'))
    fireEvent.click(screen.getByLabelText('Part options'))
    fireEvent.click(screen.getByText('Open'))
    await tick()
    expect(useAssemblyStore.getState().activePartHandle).toBe(handle)
    expect(navigateSpy).toHaveBeenCalledWith('/documents/part-1')
    // Assembly state is unchanged by opening the part.
    expect(useAssemblyStore.getState().instances).toHaveLength(1)
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
      payload: { transforms: {}, bodies: {}, mateResults: {} },
    })
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.getState().setActiveMateField(null)
    useAssemblyStore.getState().setSelectedMateId(null)
  })

  /** Stand in for a solve that has published the bundle's entity → anchor join. */
  function publishPickLookup() {
    act(() => {
      useAssemblyStore.getState().setSolveResult({
        transforms: {}, bodies: {}, edgeCurves: {}, anchors: {}, pickGeometry: [],
        entityMateRefs: ENTITY_MATE_REFS, mateResults: {},
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

  /** Clicking the armed chip disarms it, leaving the editor open. */
  function disarm() {
    fireEvent.click(screen.getAllByText('Pick a reference')[0])
  }

  it('a mate parameter edit re-solves once no chip is armed', async () => {
    await renderWithMate('fixed')
    await waitFor(() => expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1))
    disarm()
    fireEvent.change(screen.getByLabelText('Offset'), { target: { value: '5' } })
    await tick()
    expect(mateDef().offset).toBe(5)
    await waitFor(() => expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2))
  })

  // The deferral is not just about picks: a solve fired here would clear the
  // candidate set the still-armed field is cycling.
  it('a parameter edit while a chip is armed defers its solve to the disarm', async () => {
    await renderWithMate('fixed')
    await waitFor(() => expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByLabelText('Offset'), { target: { value: '5' } })
    await tick()
    expect(mateDef().offset).toBe(5)
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

    it('a third +90 click is rejected rather than wrapping to -90', async () => {
      await renderWithMate('fixed')
      disarm()
      const plus90 = () => screen.getByRole('button', { name: '+90°' })
      fireEvent.click(plus90())
      await tick()
      fireEvent.click(plus90())
      await tick()
      fireEvent.click(plus90())
      await tick()
      expect(mateDef().angle).toBe(180)
      expect(screen.getByText(/must stay within/)).toBeTruthy()
    })

    it('typing an out-of-range angle is rejected with a visible message', async () => {
      await renderWithMate('fixed')
      disarm()
      fireEvent.change(screen.getByLabelText('Angle'), { target: { value: '270' } })
      await tick()
      expect(mateDef().angle).toBeUndefined()
      expect(screen.getByText(/must stay within/)).toBeTruthy()
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

    it('a rejected keystroke keeps the digits the user typed visible', async () => {
      await renderWithMate('fixed')
      disarm()
      const input = screen.getByLabelText('Angle') as HTMLInputElement
      // Typed digit by digit: "2" -> "27" both commit (in range), "270" is
      // rejected. The box must still show "270", not snap back to "27" --
      // a controlled input bound straight to the last-committed value would
      // erase the very keystroke that triggered the rejection.
      fireEvent.change(input, { target: { value: '2' } })
      await tick()
      fireEvent.change(input, { target: { value: '27' } })
      await tick()
      fireEvent.change(input, { target: { value: '270' } })
      await tick()
      expect(input.value).toBe('270')
      expect(mateDef().angle).toBe(27)
      expect(screen.getByText(/must stay within/)).toBeTruthy()
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
      payload: { transforms: {}, bodies: {}, mateResults: { [id]: { stale: true, staleRefs: ['ref_a'] } } },
    })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(useAssemblyStore.getState().mateResults[id]?.stale).toBe(true))

    expect(document.querySelector('.mate-item.stale')).toBeTruthy()
    expect(mateDef().ref_a).toEqual({ part: 'hA', anchor: 'a_v' })
  })

  it('renaming a mate writes its label and shows it in the tree', async () => {
    await renderWithMate('fixed')
    disarm()
    fireEvent.change(screen.getByLabelText('Mate name'), { target: { value: 'top clamp' } })
    await tick()
    expect(mateDef().label).toBe('top clamp')
    expect(screen.getByText('top clamp')).toBeTruthy()
  })

  it('cancelling a mate edit reverts its parameters and closes the editor', async () => {
    await renderWithMate('fixed')
    disarm()
    fireEvent.change(screen.getByLabelText('Offset'), { target: { value: '5' } })
    await tick()
    expect(mateDef().offset).toBe(5)

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

  it('inserts a mate from the toolbar kind menu', async () => {
    renderEditor()
    await tick()
    await tick()
    fireEvent.click(screen.getByLabelText('Insert mate'))
    fireEvent.click(screen.getByText('Rotating'))
    await tick()
    expect(useAssemblyStore.getState().mates).toHaveLength(1)
    expect(mateDef().kind).toBe('rotating')
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
      payload: { transforms: { hA: SOLVED_TRANSFORM }, bodies: SOLVED_BODIES, mateResults: {} },
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
      payload: { transforms: { hA: SOLVED_TRANSFORM }, bodies: {}, mateResults: {} },
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
