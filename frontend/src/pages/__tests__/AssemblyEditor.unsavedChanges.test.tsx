import { describe, it, expect, vi, beforeEach } from 'vitest'
import { forwardRef, type ReactNode } from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA } from '@/stores/assemblyStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'

vi.mock('react-router-dom', () => ({
  // AppHeader reads the path to decide whether its burger navigates or opens
  // the about notice; these assembly routes are never the documents overview.
  useLocation: () => ({ pathname: '/documents/test-uuid' }),
  useNavigate: () => vi.fn(),
  Link: ({ to, children, ...props }: { to: string; children?: ReactNode }) =>
    <a href={to} {...props}>{children}</a>,
}))

const h = vi.hoisted(() => ({
  save: vi.fn(),
  solveAssemblyViaWorker: vi.fn(),
  setRelayHandlers: vi.fn(),
  clearRelayHandlers: vi.fn(),
  buildBundleViaWorker: vi.fn(),
  exportAssemblyViaWorker: vi.fn(),
}))

vi.mock('@/adapters/backend', () => ({
  backendBundle: {
    documents: {
      load: vi.fn(async () => ({ content: 'kind: assembly\nfeatures: []', name: 'My Assembly' })),
      list: vi.fn(async () => []),
      save: h.save,
      thumbnailUrl: () => null,
    },
    cloudDocuments: null,
  },
}))

vi.mock('@/components/Viewport/AssemblyViewport', () => ({
  default: forwardRef(() => <div data-testid="assembly-viewport" />),
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

import AssemblyEditor from '@/pages/AssemblyEditor'
import { ToastProvider } from '@/contexts/ToastContext'

const tick = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

// jsdom has no unload prompt of its own; a guarded exit shows up as the
// beforeunload event being cancelled.
function unloadBlocked(): boolean {
  const e = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(e)
  return e.defaultPrevented
}

async function renderLoaded() {
  const result = render(<ToastProvider><AssemblyEditor uuid="asm-1" /></ToastProvider>)
  await tick()
  await tick()
  return result
}

describe('AssemblyEditor unsaved-changes prompting', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.solveAssemblyViaWorker.mockResolvedValue({ payload: { transforms: {}, bodies: {}, mateResults: {} } })
    h.save.mockResolvedValue(undefined)
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useUnsavedChangesStore.getState().setDirty(false)
    useUnsavedChangesStore.getState().dismissConfirm()
  })

  it('loads clean and does not block a browser exit', async () => {
    await renderLoaded()
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    expect(unloadBlocked()).toBe(false)
  })

  it('marks the document dirty on an assembly edit', async () => {
    await renderLoaded()
    fireEvent.click(screen.getByLabelText('Insert Fixed mate'))
    await tick()
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })

  it('blocks a browser exit once an edit is pending', async () => {
    await renderLoaded()
    fireEvent.click(screen.getByLabelText('Insert Fixed mate'))
    await tick()
    expect(unloadBlocked()).toBe(true)
  })

  // The header links are the in-app way out of the editor. A pending edit must
  // raise the shared confirm dialog there instead of silently navigating.
  it('prompts on in-app navigation while dirty', async () => {
    await renderLoaded()
    fireEvent.click(screen.getByLabelText('Insert Fixed mate'))
    await tick()
    act(() => { fireEvent.click(screen.getByTitle('Documents')) })
    expect(screen.getByText('Unsaved Changes')).toBeTruthy()
    expect(useUnsavedChangesStore.getState().pendingCallback).not.toBeNull()
  })

  it('does not prompt on in-app navigation while clean', async () => {
    await renderLoaded()
    act(() => { fireEvent.click(screen.getByTitle('Documents')) })
    expect(screen.queryByText('Unsaved Changes')).toBeNull()
  })

  it('saving clears the pending-changes flag', async () => {
    await renderLoaded()
    fireEvent.click(screen.getByLabelText('Insert Fixed mate'))
    await tick()
    fireEvent.click(screen.getByLabelText('Save'))
    await tick()
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  it('clears the flag on unmount so it cannot leak onto another page', async () => {
    const { unmount } = await renderLoaded()
    fireEvent.click(screen.getByLabelText('Insert Fixed mate'))
    await tick()
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
    act(() => { unmount() })
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
    expect(unloadBlocked()).toBe(false)
  })
})
