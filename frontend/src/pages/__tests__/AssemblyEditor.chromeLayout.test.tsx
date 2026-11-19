// The assembly editor's chrome after the measurement readout moved out of the
// bottom-right HUD: the view options button and the cube keep that column, and
// the readout gets its own bottom-left slot, the same layout as the part
// editor's (Part.chromeLayout.test.tsx).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { forwardRef, useImperativeHandle, type ReactNode } from 'react'
import { screen, waitFor } from '@testing-library/react'
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
  useParams: () => ({ workspaceId: 'ws', entryId: 'test-uuid' }),
  useNavigate: () => vi.fn(),
  useHref: (to: string) => to,
  Link: ({ to, children, ...props }: { to: string; children?: ReactNode }) =>
    <a href={to} {...props}>{children}</a>,
}))

// The viewport needs WebGL. Its mock renders the two slots the real one does,
// so this suite can assert what the page handed into each one.
vi.mock('@/components/Viewport/AssemblyViewport', () => ({
  default: forwardRef((props: { readout?: ReactNode; viewOptions?: ReactNode }, ref) => {
    useImperativeHandle(ref, () => ({ captureScreenshotForSaving: vi.fn(async () => null) }))
    return (
      <div data-testid="assembly-viewport">
        <div data-testid="viewport-hud">{props.viewOptions}</div>
        <div data-testid="viewport-readout">{props.readout}</div>
      </div>
    )
  }),
}))
vi.mock('@/components/layout/AssemblyMeasurementDisplay', () => ({
  default: () => <div data-testid="assembly-measurement-readout" />,
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

describe('Assembly editor chrome', () => {
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
  }

  it('puts the measurement readout in its own bottom-left slot, not the HUD', async () => {
    await renderLoaded()
    const readout = screen.getByTestId('assembly-measurement-readout')
    expect(screen.getByTestId('viewport-readout').contains(readout)).toBe(true)
    expect(screen.getByTestId('viewport-hud').contains(readout)).toBe(false)
  })

  it('hands the view options button to the HUD column on the right', async () => {
    await renderLoaded()
    expect(screen.getByTestId('viewport-hud').querySelector('button[aria-label="View options"]')).not.toBeNull()
  })
})
