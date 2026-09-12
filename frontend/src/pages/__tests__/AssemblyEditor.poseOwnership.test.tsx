// The page-level half of the pose-ownership fix: a duplicate requested between a
// drag commit and its re-solve must bake the dragged (settled) pose, not the raw
// transform the bodies are still baked at. The viewport is mocked out, so this
// exercises the page callbacks with no WebGL.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { forwardRef, useImperativeHandle, type ReactNode } from 'react'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { executeCommand } from '@/utils/core/commandRegistry'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA } from '@/stores/assemblyStore'

const h = vi.hoisted(() => ({
  loadContent: 'kind: assembly\nfeatures: []',
  partContent: 'features: []',
  list: [] as Array<{ uuid: string; name: string; kind?: string; meta?: { rev: number } }>,
  solveAssemblyViaWorker: vi.fn(),
}))

vi.mock('@/adapters/backend', () => ({
  backendBundle: {
    documents: {
      load: vi.fn(async (id: string) => ({
        content: id === 'asm-1' ? h.loadContent : h.partContent,
        name: 'My Assembly',
      })),
      list: vi.fn(async () => h.list),
      save: vi.fn(),
      thumbnailUrl: () => null,
    },
    cloudDocuments: null,
  },
}))

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/documents/test-uuid' }),
  useNavigate: () => vi.fn(),
  Link: ({ to, children, ...props }: { to: string; children?: ReactNode }) =>
    <a href={to} {...props}>{children}</a>,
}))

vi.mock('@/components/Viewport/AssemblyViewport', () => ({
  default: forwardRef((_props, ref) => {
    useImperativeHandle(ref, () => ({ captureScreenshotForSaving: vi.fn(async () => null) }))
    return <div data-testid="assembly-viewport" />
  }),
}))
vi.mock('@/kernel/worker/anchorSolverClient', () => ({
  solveAssemblyViaWorker: h.solveAssemblyViaWorker,
  setRelayHandlers: vi.fn(),
  clearRelayHandlers: vi.fn(),
}))
vi.mock('@/kernel/worker/solverClient', () => ({
  buildBundleViaWorker: vi.fn(),
  exportAssemblyViaWorker: vi.fn(),
}))
vi.mock('@/utils/core/downloadBlob', () => ({ downloadBlob: vi.fn() }))

import AssemblyEditor from '@/pages/AssemblyEditor'
import { ToastProvider } from '@/contexts/ToastContext'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { findInstance } from '@/utils/assemblyMutations'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'

const tick = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

// The editor's tree labels and the picker's source come from the open workspace
// session, so the suite installs one that reads its `h.list` live.
function installSessionFromList() {
  useWorkspaceSessionStore.setState({
    session: {
      workspace: 'asm-1',
      open: vi.fn(),
      listEntries: async () => h.list.map(d => ({
        id: d.uuid,
        path: `documents/${d.name}.yaml`,
        kind: 'document' as const,
        name: d.name,
        docKind: d.kind,
        rev: d.meta?.rev,
      })),
      readEntry: vi.fn(),
      writeEntry: vi.fn(),
      resolveFile: vi.fn(),
      referencesOf: vi.fn(),
      referenceEdges: vi.fn(async () => ({})),
      savedRevs: async () => new Map(),
      originOf: async () => undefined,
      provenance: async () => [],
    },
  })
}

describe('AssemblyEditor pose ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.loadContent = 'kind: assembly\nfeatures: []'
    h.list = [{ uuid: 'part-1', name: 'Bracket', kind: 'part', meta: { rev: 5 } }]
    h.solveAssemblyViaWorker.mockResolvedValue({
      payload: { transforms: {}, bodies: {} },
    })
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.getState().selectPart(null)
    useAssemblyStore.getState().setActiveMateField(null)
    useAssemblyStore.getState().selectMate(null)
    installSessionFromList()
  })

  const pickerItem = (name: string) =>
    screen.getAllByText(name).find(el => el.closest('.doc-browser-tile'))

  async function insertPart(name: string) {
    act(() => { executeCommand('insert_part_instance') })
    await waitFor(() => expect(pickerItem(name)).toBeTruthy())
    fireEvent.click(pickerItem(name)!)
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }))
    await tick()
  }

  it('duplicating the dragged part before its solve lands keeps the dragged pose', async () => {
    // The load solve resolves; every later solve hangs, so the settle window
    // stays open through the duplicate.
    let calls = 0
    h.solveAssemblyViaWorker.mockImplementation(() => {
      calls++
      if (calls === 1) return Promise.resolve({ payload: { transforms: {}, bodies: {} } })
      return new Promise(() => {})
    })

    render(<ToastProvider><AssemblyEditor uuid="asm-1" /></ToastProvider>)
    await tick()
    await tick()
    await insertPart('Bracket')
    await insertPart('Bracket')

    const [h1, h2] = useAssemblyStore.getState().instances.map(i => i.handle)
    // A solve left h1 displayed at 10 while the doc seed is still the origin.
    useAssemblyStore.setState({
      transforms: { [h1]: { ...IDENTITY_TRANSFORM, tx: 10 }, [h2]: { ...IDENTITY_TRANSFORM } },
    })

    // Drive the drag through the store, as the viewport would.
    act(() => {
      const s = useAssemblyStore.getState()
      s.beginPartManipulation(h1)
      s.dragPartTranslate([3, 0, 0])
      useAssemblyStore.getState().endPartManipulation()
    })
    await tick()
    expect(useAssemblyStore.getState().settlingOffsets[h1]).toBeTruthy()

    await waitFor(() => expect(screen.getAllByText('Bracket').length).toBeGreaterThanOrEqual(2))
    fireEvent.click(screen.getAllByLabelText('Part options')[0])  // h1's row
    fireEvent.click(screen.getByText('Duplicate'))
    await tick()
    await tick()

    const doc = useAssemblyStore.getState().doc!
    // Before the fix this bake wrote raw `transforms` back over h1, reading 10.
    expect(findInstance(doc, h1)!.transform.tx).toBe(13)
    const copy = useAssemblyStore.getState().instances.find(i => i.handle !== h1 && i.handle !== h2)!
    expect(findInstance(doc, copy.handle)!.transform.tx).toBe(13)
  })
})
