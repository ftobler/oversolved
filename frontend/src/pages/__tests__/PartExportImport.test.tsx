// The non-YAML half of the export dialog: cancellation, the worker failure
// paths, the STL format branch, and the body-targeted export. The YAML source
// path has its own suite; these pin the behaviours a body export or a missing
// solid depends on.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRef } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'

const downloadBlob = vi.fn()
const exportViaWorker = vi.fn()
vi.mock('@/utils/core/downloadBlob', () => ({ downloadBlob: (...args: unknown[]) => downloadBlob(...args) }))
vi.mock('@/kernel/worker/solverClient', () => ({ exportViaWorker: (...args: unknown[]) => exportViaWorker(...args) }))

import PartExportImport from '@/pages/PartExportImport'
import type { PartExportImportHandle } from '@/pages/PartExportImport'
import { usePartEditorStore, DEFAULT_PART_EDITOR_DATA } from '@/stores/partEditorStore'
import { ToastProvider } from '@/contexts/ToastContext'
import type { PartDoc } from '@/types/cad'

const DOC: PartDoc = {
  features: [
    { id: 'Origin', kind: 'origin' },
    { id: 'extrude1', kind: 'extrude', extrude: { sketch: 'S1', distance: 10 } },
  ],
}

function renderDialog() {
  const ref = createRef<PartExportImportHandle>()
  render(
    <ToastProvider>
      <PartExportImport ref={ref} uuid="u1" />
    </ToastProvider>
  )
  return ref
}

async function clickDownload() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
  })
}

describe('PartExportImport worker export', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    usePartEditorStore.setState({ ...DEFAULT_PART_EDITOR_DATA, doc: DOC })
  })

  it('cancelling closes the dialog without asking the kernel for bytes', () => {
    const ref = renderDialog()
    act(() => ref.current!.openExport(null, 'bracket'))

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByText('Export Model')).toBeNull()
    expect(exportViaWorker).not.toHaveBeenCalled()
    expect(downloadBlob).not.toHaveBeenCalled()
  })

  // A null result means the doc held nothing the kernel could serialize. The
  // user has to be told, and the dialog must not stay open over a finished run.
  it('reports no solid geometry when the worker yields no bytes', async () => {
    exportViaWorker.mockResolvedValue(null)
    const ref = renderDialog()
    act(() => ref.current!.openExport(null, 'bracket'))

    await clickDownload()

    expect(await screen.findByText(/no solid geometry/)).toBeInTheDocument()
    expect(downloadBlob).not.toHaveBeenCalled()
    expect(screen.queryByText('Export Model')).toBeNull()
  })

  // The worker rejects on a kernel failure and the dialog would otherwise sit
  // busy forever; the message has to reach the toast.
  it('reports the failure when the worker rejects', async () => {
    exportViaWorker.mockRejectedValue(new Error('kernel boom'))
    const ref = renderDialog()
    act(() => ref.current!.openExport(null, 'bracket'))

    await clickDownload()

    expect(await screen.findByText(/Export error: kernel boom/)).toBeInTheDocument()
    expect(screen.queryByText('Export Model')).toBeNull()
  })

  it('downloads STL with the mesh mime type and the chosen tessellation', async () => {
    exportViaWorker.mockResolvedValue(new Uint8Array([1, 2, 3]))
    const ref = renderDialog()
    act(() => ref.current!.openExport(null, 'bracket'))

    fireEvent.click(screen.getByLabelText('STL'))
    await clickDownload()

    const [blob, filename] = downloadBlob.mock.calls[0] as [Blob, string]
    expect(blob.type).toBe('model/stl')
    expect(filename.endsWith('.stl')).toBe(true)
    // The slider default is what the worker is handed for STL; STEP always
    // passes 0 because it carries no tessellation.
    expect(exportViaWorker.mock.calls[0][1]).toMatchObject({ format: 'stl', tessellation: 0.5 })
  })

  // A body entry point names the body to serialize; dropping it would silently
  // export the whole part instead of the one the user right-clicked.
  it('forwards the body opened via openExport to the worker', async () => {
    exportViaWorker.mockResolvedValue(new Uint8Array([1]))
    const ref = renderDialog()
    act(() => ref.current!.openExport('body-1', 'Body One'))

    await clickDownload()

    expect(exportViaWorker.mock.calls[0][1]).toMatchObject({ bodyId: 'body-1' })
  })

  it('does nothing when no document is loaded', async () => {
    usePartEditorStore.setState({ ...DEFAULT_PART_EDITOR_DATA, doc: null })
    const ref = renderDialog()
    act(() => ref.current!.openExport(null, 'bracket'))

    await clickDownload()

    expect(exportViaWorker).not.toHaveBeenCalled()
    expect(downloadBlob).not.toHaveBeenCalled()
  })

  it('falls back to the default export name when openExport names none', async () => {
    exportViaWorker.mockResolvedValue(new Uint8Array([1]))
    const ref = renderDialog()
    act(() => ref.current!.openExport(null))

    await clickDownload()

    expect((downloadBlob.mock.calls[0][1] as string).startsWith('export.')).toBe(true)
  })

  // Serialising the document can fail on a value the YAML writer cannot walk
  // (a getter that throws). The download must not happen and the failure must
  // be reported rather than swallowed by the native click handler.
  it('reports a YAML serialisation failure instead of downloading nothing', async () => {
    const broken = { features: DOC.features } as PartDoc
    Object.defineProperty(broken, 'boom', { enumerable: true, get() { throw new Error('bad doc') } })
    usePartEditorStore.setState({ ...DEFAULT_PART_EDITOR_DATA, doc: broken })
    const ref = renderDialog()
    act(() => ref.current!.openExport(null, 'bracket'))

    fireEvent.click(screen.getByLabelText('YAML'))
    await clickDownload()

    expect(await screen.findByText(/Export error: bad doc/)).toBeInTheDocument()
    expect(downloadBlob).not.toHaveBeenCalled()
  })
})
