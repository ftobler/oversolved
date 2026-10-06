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
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { getFileRegistry } from '@/stores/fileRegistry'
import { resetFakeIndexedDb } from '@/stores/documentStore/__tests__/fakeIndexedDb'
import { resetDbConnection } from '@/stores/documentStore/idb'
import { tick, renderEditor, installSessionFromList } from './AssemblyEditor.harness'

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
    h.list = [{ uuid: 'part-1', name: 'Bracket', kind: 'part', meta: { rev: 1 } }]
    h.solveAssemblyViaWorker.mockResolvedValue({
      payload: { transforms: { hA: SOLVED_TRANSFORM }, bodies: SOLVED_BODIES },
    })
    h.exportAssemblyViaWorker.mockResolvedValue(new Uint8Array([1, 2, 3]))
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.getState().setActiveMateField(null)
    useAssemblyStore.getState().selectMate(null)
    installSessionFromList(h)
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

  it('STEP: resolves an import reference into the files side channel', async () => {
    resetFakeIndexedDb()
    resetDbConnection()
    const entry = await getFileRegistry().create({
      name: 'p.step', kind: 'step', mime: 'application/step', bytes: new Uint8Array([4, 5, 6]),
    })
    // The workspace session is authoritative once the file is adopted; its
    // resolver answers like the real session-first fallback would.
    const session = useWorkspaceSessionStore.getState().session
    vi.mocked(session!.resolveFile).mockResolvedValue(new Uint8Array([4, 5, 6]))
    h.partContent = `features:\n  - id: ex1\n    kind: extrude\n  - id: imp1\n    kind: import_step\n    file_id: ${entry.id}\n`
    await openExportDialog()
    download()
    await waitFor(() => expect(h.exportAssemblyViaWorker).toHaveBeenCalledTimes(1))
    expect(session!.resolveFile).toHaveBeenCalledWith(entry.id)
    const call = h.exportAssemblyViaWorker.mock.calls[0] as [unknown, unknown, Record<string, Uint8Array>]
    expect(Array.from(call[2][entry.id])).toEqual([4, 5, 6])
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
      payload: { transforms: { hA: SOLVED_TRANSFORM }, bodies: {} },
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
