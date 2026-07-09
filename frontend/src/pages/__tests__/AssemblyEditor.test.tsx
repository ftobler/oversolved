import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { executeCommand } from '@/utils/core/commandRegistry'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA } from '@/stores/assemblyStore'

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
