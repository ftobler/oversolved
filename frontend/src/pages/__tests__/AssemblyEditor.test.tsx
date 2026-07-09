import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { executeCommand } from '@/utils/core/commandRegistry'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA } from '@/stores/assemblyStore'
import { assemblyEntityKey, type EntityMateRefs } from '@/utils/anchorCandidates'
import { findMate } from '@/utils/assemblyMutations'

const navigateSpy = vi.fn()
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateSpy,
}))

const h = vi.hoisted(() => ({
  loadContent: 'kind: assembly\nfeatures: []',
  list: [] as Array<{ uuid: string; name: string; meta?: { rev: number } }>,
  solveAssemblyViaWorker: vi.fn(),
  setRelayHandlers: vi.fn(),
  buildBundleViaWorker: vi.fn(),
}))

vi.mock('@/adapters/backend', () => ({
  backendBundle: {
    documents: {
      load: vi.fn(async () => ({ content: h.loadContent, name: 'My Assembly' })),
      list: vi.fn(async () => h.list),
    },
  },
}))

// The viewport needs WebGL; its logic is covered viewport-free (assemblyRender,
// assemblyPointer). The page's job here is to mount it and drive the solve.
vi.mock('@/components/Viewport/AssemblyViewport', () => ({
  default: () => <div data-testid="assembly-viewport" />,
}))
vi.mock('@/kernel/worker/anchorSolverClient', () => ({
  solveAssemblyViaWorker: h.solveAssemblyViaWorker,
  setRelayHandlers: h.setRelayHandlers,
}))
vi.mock('@/kernel/worker/solverClient', () => ({ buildBundleViaWorker: h.buildBundleViaWorker }))

import AssemblyEditor from '@/pages/AssemblyEditor'

const tick = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

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
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.getState().setActivePartHandle(null)
    useAssemblyStore.getState().setSelectedPartHandle(null)
    useAssemblyStore.getState().setActiveMateField(null)
    useAssemblyStore.getState().setSelectedMateId(null)
  })

  async function renderLoaded() {
    render(<AssemblyEditor uuid="asm-1" />)
    await tick()
    await tick()
  }

  async function insertPart(name: string) {
    act(() => { executeCommand('insert_part_instance') })
    // Picker lists owned docs (minus the assembly itself).
    await waitFor(() => screen.getByText(name))
    fireEvent.click(screen.getByText(name))
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }))
    await tick()
  }

  it('starts empty and shows the insert affordance', async () => {
    await renderLoaded()
    expect(screen.getByText(/Empty assembly/)).toBeTruthy()
    expect(screen.getByLabelText('Insert part')).toBeTruthy()
  })

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

    fireEvent.click(screen.getByLabelText('Delete part'))
    await tick()
    await tick()  // let the delete's re-solve settle

    expect(useAssemblyStore.getState().selectedPartHandle).toBeNull()
    expect(useAssemblyStore.getState().instances).toHaveLength(0)
  })

  it('insert_part_instance command appends an instance shown in the tree', async () => {
    await renderLoaded()
    await insertPart('Bracket')
    // Tree lists the instance (label falls back to doc_id).
    expect(screen.getByText('part-1')).toBeTruthy()
    const instances = useAssemblyStore.getState().instances
    expect(instances).toHaveLength(1)
    expect(instances[0].doc_id).toBe('part-1')
    expect(instances[0].doc_rev).toBe(5)
  })

  it('two instances of the same part get distinct handles', async () => {
    await renderLoaded()
    await insertPart('Bracket')
    await insertPart('Bracket')
    const instances = useAssemblyStore.getState().instances
    expect(instances).toHaveLength(2)
    expect(instances[0].handle).not.toBe(instances[1].handle)
  })

  it('ground toggle marks the instance fixed', async () => {
    await renderLoaded()
    await insertPart('Bracket')
    fireEvent.click(screen.getByLabelText('Ground part'))
    await tick()
    expect(useAssemblyStore.getState().instances[0].fixed).toBe(true)
  })

  it('delete removes the instance', async () => {
    await renderLoaded()
    await insertPart('Bracket')
    fireEvent.click(screen.getByLabelText('Delete part'))
    await tick()
    expect(useAssemblyStore.getState().instances).toHaveLength(0)
  })

  it('opening a part sets activePartHandle and navigates without disturbing the assembly', async () => {
    await renderLoaded()
    await insertPart('Bracket')
    const handle = useAssemblyStore.getState().instances[0].handle
    fireEvent.click(screen.getByText('part-1'))
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
    render(<AssemblyEditor uuid="asm-1" />)
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
    expect(screen.getByText(/Spherical: Pick a reference to Pick a reference/)).toBeTruthy()
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

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(useAssemblyStore.getState().mateResults[id]?.stale).toBe(true))

    expect(document.querySelector('.assembly-tree-mate.stale')).toBeTruthy()
    expect(mateDef().ref_a).toEqual({ part: 'hA', anchor: 'a_v' })
  })

  it('deleting a mate drops it and re-solves', async () => {
    await renderWithMate('fixed')
    await waitFor(() => expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByLabelText('Delete mate'))
    await tick()
    expect(useAssemblyStore.getState().mates).toHaveLength(0)
    await waitFor(() => expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2))
  })

  it('inserts a mate from the tree kind menu', async () => {
    render(<AssemblyEditor uuid="asm-1" />)
    await tick()
    await tick()
    fireEvent.click(screen.getByLabelText('Insert mate'))
    fireEvent.click(screen.getByText('Rotating'))
    await tick()
    expect(useAssemblyStore.getState().mates).toHaveLength(1)
    expect(mateDef().kind).toBe('rotating')
  })
})
