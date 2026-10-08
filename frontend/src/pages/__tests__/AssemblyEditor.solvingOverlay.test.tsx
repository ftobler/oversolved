import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { forwardRef, useImperativeHandle, type ReactNode } from 'react'
import { render, act, waitFor } from '@testing-library/react'
import AssemblyEditor from '@/pages/AssemblyEditor'
import { ToastProvider } from '@/contexts/ToastContext'
import { useSolverStore } from '@/stores/solverStore'
import { useAssemblyStore } from '@/stores/assemblyStore'

const navigateSpy = vi.fn()
vi.mock('react-router-dom', () => ({
  // AppHeader reads the path to decide whether its burger navigates or opens
  // the about notice; these assembly routes are never the documents overview.
  useLocation: () => ({ pathname: '/workspaces/ws/entries/test-uuid' }),
  // The breadcrumb reads the route's workspace to build its trail.
  useParams: () => ({ workspaceId: 'ws', entryId: 'test-uuid' }),
  useNavigate: () => navigateSpy,
  useHref: (to: string) => to,
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
  cancelAssemblySolver: vi.fn(),
  setRelayHandlers: vi.fn(),
  clearRelayHandlers: vi.fn(),
  buildBundleViaWorker: vi.fn(),
  exportAssemblyViaWorker: vi.fn(),
  downloadBlob: vi.fn(),
}))

vi.mock('@/adapters/backend', () => ({
  backendBundle: {
    documents: {
      load: vi.fn(async (id: string) => ({
        content: id === 'asm-1' ? h.loadContent : h.partContent,
        name: 'My Assembly',
      })),
      list: vi.fn(async () => h.list),
      save: h.save,
      thumbnailUrl: () => null,
    },
    cloudDocuments: null,
  },
}))

// The viewport needs WebGL; it is not what these tests exercise. The mock
// forwards a ref exposing the thumbnail capturer so the save path keeps
// working (the real viewport never mounts).
vi.mock('@/components/Viewport/AssemblyViewport', () => ({
  default: forwardRef((_props, ref) => {
    useImperativeHandle(ref, () => ({ captureScreenshotForSaving: h.captureScreenshotForSaving }))
    return <div data-testid="assembly-viewport" />
  }),
}))

vi.mock('@/kernel/worker/anchorSolverClient', () => ({
  solveAssemblyViaWorker: h.solveAssemblyViaWorker,
  cancelAssemblySolver: h.cancelAssemblySolver,
  setRelayHandlers: h.setRelayHandlers,
  clearRelayHandlers: h.clearRelayHandlers,
}))
vi.mock('@/kernel/worker/solverClient', () => ({
  buildBundleViaWorker: h.buildBundleViaWorker,
  exportAssemblyViaWorker: h.exportAssemblyViaWorker,
}))
vi.mock('@/utils/core/downloadBlob', () => ({ downloadBlob: h.downloadBlob }))

describe('AssemblyEditor solving overlay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSolverStore.setState({ isSolving: false, onCancelSolve: null })
    h.loadContent = 'kind: assembly\nfeatures: []'
    h.list = []
  })

  afterEach(() => {
    vi.useRealTimers()
    useSolverStore.setState({ isSolving: false, onCancelSolve: null })
  })

  function renderEditor() {
    return render(<ToastProvider><AssemblyEditor uuid="asm-1" /></ToastProvider>)
  }

  it('shows the overlay for a hung solve and the cancel button recovers it', async () => {
    // shouldAdvanceTime lets the doc load and mount solve proceed on real time
    // while the overlay's 5s cancel delay stays deterministic.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let rejectSolve!: (e: unknown) => void
    const hung = new Promise<never>((_, reject) => { rejectSolve = reject })
    h.solveAssemblyViaWorker.mockImplementation(() => hung)
    h.cancelAssemblySolver.mockImplementation(() => {
      // The real cancelAssemblySolver drops the worker, rejecting the in-flight
      // request; the mock mirrors that so the hook's promise settles.
      rejectSolve(new Error('assembly solve cancelled'))
    })

    const { container } = renderEditor()

    // The mount solve never replies: the shared overlay shows the spinner and
    // the mirror flag is up for the assembly solve. Effect-fed, so asserted
    // inside waitFor (the documentpage-remount-flake convention).
    await waitFor(() => {
      expect(useSolverStore.getState().isSolving).toBe(true)
      expect(container.querySelector('.loading-overlay.visible')).not.toBeNull()
    }, { timeout: 10000 })

    // The cancel button appears after the overlay's delay; cancelling drops the
    // anchor worker (rejecting the hung solve benignly) and hides the overlay.
    await act(async () => { vi.advanceTimersByTime(5000) })
    await waitFor(() => {
      expect(container.querySelector('.loading-cancel-btn')).not.toBeNull()
    }, { timeout: 10000 })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('.loading-cancel-btn')?.click()
    })

    expect(h.cancelAssemblySolver).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(useSolverStore.getState().isSolving).toBe(false)
      expect(useAssemblyStore.getState().solveStatus).toBeNull()
      expect(container.querySelector('.loading-overlay.visible')).toBeNull()
    }, { timeout: 10000 })
  })

  it('does not show the overlay once a normal solve has settled', async () => {
    let release!: (v: unknown) => void
    const gate = new Promise(r => { release = r })
    h.solveAssemblyViaWorker.mockImplementationOnce(() => gate)

    const { container } = renderEditor()
    await act(async () => {})

    // A successful solve settles the mirror; waitFor's act wrapper absorbs the
    // store-driven overlay re-render, so the overlay leaves.
    await act(async () => {
      release({
        id: 1,
        kind: 'solveAssembly' as const,
        ok: true as const,
        payload: { transforms: {}, bodies: {} },
      })
    })

    await waitFor(() => {
      expect(useSolverStore.getState().isSolving).toBe(false)
      expect(container.querySelector('.loading-overlay.visible')).toBeNull()
    }, { timeout: 10000 })
  })
})
