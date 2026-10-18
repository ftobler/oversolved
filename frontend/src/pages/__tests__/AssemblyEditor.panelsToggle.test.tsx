// The phone-width navigator drawer, assembly side: the editor mounts the same
// one panels control the part editor does (components/layout/PanelsToggle), and
// clicking it flips the `.panels-open` class on `.doc-container` that Part.css
// keys the drawer on. Mirrors PartEditorPanel.panelsToggle.test.tsx; the CSS
// rules themselves are pinned in narrowChrome.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { forwardRef, useImperativeHandle, type ReactNode } from 'react'
import { screen, fireEvent, waitFor } from '@testing-library/react'
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
  useLocation: () => ({ pathname: '/workspaces/ws/entries/test-uuid' }),
  // The breadcrumb reads the route's workspace to build its trail.
  useParams: () => ({ workspaceId: 'ws', entryId: 'test-uuid' }),
  useNavigate: () => vi.fn(),
  useHref: (to: string) => to,
  Link: ({ to, children, ...props }: { to: string; children?: ReactNode }) =>
    <a href={to} {...props}>{children}</a>,
}))

// The viewport needs WebGL; its mock is not what this suite exercises.
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

import { tick, renderEditor, installSessionFromList } from './AssemblyEditor.harness'

describe('AssemblyEditor panels toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.loadContent = 'kind: assembly\nfeatures: []'
    h.list = []
    h.solveAssemblyViaWorker.mockResolvedValue({ payload: { transforms: {}, bodies: {} } })
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    installSessionFromList(h)
  })

  async function renderLoaded() {
    renderEditor()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Show panels' })).toBeTruthy())
    await tick()
    return document.querySelector('.doc-container') as HTMLElement
  }

  it('opens and closes the drawer through one button, reported on the container', async () => {
    const container = await renderLoaded()
    expect(container.classList.contains('panels-open')).toBe(false)
    expect(screen.getByRole('button', { name: 'Show panels' })).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(screen.getByRole('button', { name: 'Show panels' }))
    expect(container.classList.contains('panels-open')).toBe(true)
    expect(screen.getByRole('button', { name: 'Hide panels' })).toHaveAttribute('aria-expanded', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Hide panels' }))
    expect(container.classList.contains('panels-open')).toBe(false)
    expect(screen.getByRole('button', { name: 'Show panels' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('offers exactly one panels control, not one per panel', async () => {
    await renderLoaded()
    expect(screen.getAllByRole('button', { name: /panels/i })).toHaveLength(1)
  })
})
