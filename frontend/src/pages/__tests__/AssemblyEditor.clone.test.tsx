import { describe, it, expect, vi, beforeEach } from 'vitest'
import { forwardRef, useImperativeHandle, type ReactNode } from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA } from '@/stores/assemblyStore'

const navigateSpy = vi.fn()
vi.mock('react-router-dom', () => ({
  // AppHeader reads the path to decide whether its burger navigates or opens
  // the about notice; these assembly routes are never the documents overview.
  useLocation: () => ({ pathname: '/workspaces/ws/entries/test-uuid' }),
  // The breadcrumb reads the route's workspace to build its trail.
  useParams: () => ({ workspaceId: 'ws', entryId: 'test-uuid' }),
  useNavigate: () => navigateSpy,
  Link: ({ to, children, ...props }: { to: string; children?: ReactNode }) =>
    <a href={to} {...props}>{children}</a>,
}))

const h = vi.hoisted(() => ({
  loadContent: 'kind: assembly\nfeatures: []',
  clone: vi.fn(async () => ({ uuid: 'clone-uuid' })),
}))

vi.mock('@/adapters/backend', () => ({
  backendBundle: {
    documents: {
      load: vi.fn(async () => ({ content: h.loadContent, name: 'My Assembly' })),
      list: vi.fn(async () => []),
      save: vi.fn(),
      clone: h.clone,
      thumbnailUrl: () => null,
    },
    cloudDocuments: null,
  },
}))

vi.mock('@/components/Viewport/AssemblyViewport', () => ({
  default: forwardRef((_props, ref) => {
    useImperativeHandle(ref, () => ({ captureScreenshotForSaving: vi.fn() }))
    return <div data-testid="assembly-viewport" />
  }),
}))
vi.mock('@/kernel/worker/anchorSolverClient', () => ({
  solveAssemblyViaWorker: vi.fn(async () => ({ payload: { transforms: {}, bodies: {} } })),
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

const tick = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

function renderEditor() {
  return render(<ToastProvider><AssemblyEditor uuid="asm-1" /></ToastProvider>)
}

// Cloning used to fire the request with no try/catch, so a rejection produced
// an unhandled rejection instead of a user-facing message. These pin the fix:
// the request is awaited inside a try/catch, and a failure surfaces through the
// same error banner the solver error already uses.
describe('AssemblyEditor clone', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.loadContent = 'kind: assembly\nfeatures: []'
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
  })

  async function renderLoaded() {
    renderEditor()
    await tick()
    await tick()
  }

  it('clones immediately under the same uuid and navigates to the new document', async () => {
    await renderLoaded()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clone document' })) })
    expect(h.clone).toHaveBeenCalledWith('asm-1')
    expect(navigateSpy).toHaveBeenCalledWith('/workspaces/asm-1/entries/clone-uuid')
  })

  it('shows an error banner instead of an unhandled rejection when the clone fails', async () => {
    h.clone.mockRejectedValue(new Error('network down'))
    await renderLoaded()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clone document' })) })

    expect(await screen.findByText(/network down/)).toBeTruthy()
    expect(navigateSpy).not.toHaveBeenCalled()
  })
})
