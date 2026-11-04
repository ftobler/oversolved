// The non-YAML half of the export dialog: cancellation, the worker failure
// paths, the STL format branch, and the body-targeted export. The YAML source
// path has its own suite; these pin the behaviours a body export or a missing
// solid depends on.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRef } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import JSZip from 'jszip'

const downloadBlob = vi.fn()
const exportViaWorker = vi.fn()
vi.mock('@/utils/core/downloadBlob', () => ({ downloadBlob: (...args: unknown[]) => downloadBlob(...args) }))
vi.mock('@/kernel/worker/solverClient', () => ({ exportViaWorker: (...args: unknown[]) => exportViaWorker(...args) }))

import PartExportImport from '@/pages/PartExportImport'
import type { PartExportImportHandle } from '@/pages/PartExportImport'
import { usePartEditorStore, DEFAULT_PART_EDITOR_DATA } from '@/stores/partEditorStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { useEditorState } from '@/hooks/useEditorState'
import { ToastProvider } from '@/contexts/ToastContext'
import type { BodyResult, LengthUnit, PartDoc } from '@/types/cad'

const DOC: PartDoc = {
  features: [
    { id: 'Origin', kind: 'origin' },
    { id: 'extrude1', kind: 'extrude', extrude: { sketch: 'S1', distance: 10 } },
  ],
}

const TWO_BODIES: Record<string, BodyResult> = {
  body_a: { id: 'body_a', created_by: 'extrude1', modified_by: [] },
  body_b: { id: 'body_b', created_by: 'extrude2', modified_by: [] },
}

function renderDialog(onSetLengthUnit: (unit: LengthUnit) => void = vi.fn()) {
  const ref = createRef<PartExportImportHandle>()
  render(
    <ToastProvider>
      <PartExportImport ref={ref} uuid="u1" onSetLengthUnit={onSetLengthUnit} />
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
    useSketchEditorStore.getState().clearNormalSelection()
    useEditorState.setState({ editingFeatureId: null })
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
    // `normal` is the dialog default and reproduces the old export mesh.
    expect(exportViaWorker.mock.calls[0][1]).toMatchObject({ format: 'stl', tessellation: 'normal' })
  })

  // The preset is typed UI state that must survive every hop to the kernel; a
  // non-default pick is the case a default-only assertion would miss.
  it('carries a non-default tessellation preset from the dialog to the worker', async () => {
    exportViaWorker.mockResolvedValue(new Uint8Array([1]))
    const ref = renderDialog()
    act(() => ref.current!.openExport(null, 'bracket'))

    fireEvent.click(screen.getByLabelText('STL'))
    fireEvent.click(screen.getByLabelText('Coarse'))
    await clickDownload()

    expect(exportViaWorker.mock.calls[0][1]).toMatchObject({ format: 'stl', tessellation: 'coarse' })
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

  it('exports All Parts through the whole-document path, not the displayed solve ids', async () => {
    usePartEditorStore.setState({
      ...DEFAULT_PART_EDITOR_DATA,
      doc: DOC,
      bodies: TWO_BODIES,
      partLabels: { body_a: 'Bracket', body_b: 'Plate' },
    })
    exportViaWorker.mockResolvedValue(new Uint8Array([1]))
    const ref = renderDialog()
    act(() => ref.current!.openExport(null, 'bracket'))

    await clickDownload()

    expect(exportViaWorker.mock.calls[0][1]).toMatchObject({ bodyId: null })
    expect(exportViaWorker.mock.calls[0][1]).not.toHaveProperty('bodyIds')
  })

  it('exports All Parts through the whole-document path even when one body is known', async () => {
    usePartEditorStore.setState({
      ...DEFAULT_PART_EDITOR_DATA,
      doc: DOC,
      bodies: { body_a: TWO_BODIES.body_a },
      partLabels: { body_a: 'Bracket' },
    })
    exportViaWorker.mockResolvedValue(new Uint8Array([1]))
    const ref = renderDialog()
    act(() => ref.current!.openExport(null, 'bracket'))

    await clickDownload()

    expect(exportViaWorker.mock.calls[0][1]).toMatchObject({ bodyId: null })
    expect(exportViaWorker.mock.calls[0][1]).not.toHaveProperty('bodyIds')
  })

  it('exports the bodies selected in the document as one compound file', async () => {
    usePartEditorStore.setState({
      ...DEFAULT_PART_EDITOR_DATA,
      doc: DOC,
      bodies: TWO_BODIES,
      partLabels: { body_a: 'Bracket', body_b: 'Plate' },
    })
    useSketchEditorStore.getState().setNormalSelection(new Set(['@body_a', '@body_b']))
    exportViaWorker.mockResolvedValue(new Uint8Array([1]))
    const ref = renderDialog()
    act(() => ref.current!.openExport(null, 'bracket'))

    fireEvent.click(screen.getByLabelText('Selected Parts'))
    await clickDownload()

    expect(exportViaWorker).toHaveBeenCalledTimes(1)
    expect(exportViaWorker.mock.calls[0][1]).toMatchObject({
      format: 'step', bodyId: null, bodyIds: ['body_a', 'body_b'],
    })
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1))
    expect((downloadBlob.mock.calls[0][1] as string).endsWith('.step')).toBe(true)
  })

  it('zips one entry per selected body and downloads one archive', async () => {
    usePartEditorStore.setState({
      ...DEFAULT_PART_EDITOR_DATA,
      doc: DOC,
      bodies: TWO_BODIES,
      partLabels: { body_a: 'Bracket', body_b: 'Plate' },
    })
    useSketchEditorStore.getState().setNormalSelection(new Set(['@body_a', '@body_b']))
    exportViaWorker.mockResolvedValue(new Uint8Array([1]))
    const ref = renderDialog()
    act(() => ref.current!.openExport(null, 'bracket'))

    fireEvent.click(screen.getByLabelText('Selected Parts'))
    fireEvent.click(screen.getByLabelText('ZIP archive'))
    await clickDownload()

    expect(exportViaWorker).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1))
    const [blob, filename] = downloadBlob.mock.calls[0] as [Blob, string]
    expect(filename).toBe('bracket.zip')
    expect(blob.type).toBe('application/zip')
    const zip = await JSZip.loadAsync(blob)
    expect(Object.keys(zip.files).sort()).toEqual(['Bracket.step', 'Plate.step'])
  })

  it('zips a single selected body as a one-entry archive', async () => {
    usePartEditorStore.setState({
      ...DEFAULT_PART_EDITOR_DATA,
      doc: DOC,
      bodies: TWO_BODIES,
      partLabels: { body_a: 'Bracket', body_b: 'Plate' },
    })
    useSketchEditorStore.getState().setNormalSelection(new Set(['@body_a']))
    exportViaWorker.mockResolvedValue(new Uint8Array([1]))
    const ref = renderDialog()
    act(() => ref.current!.openExport(null, 'bracket'))

    fireEvent.click(screen.getByLabelText('Selected Parts'))
    fireEvent.click(screen.getByLabelText('ZIP archive'))
    await clickDownload()

    expect(exportViaWorker).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1))
    const zip = await JSZip.loadAsync(downloadBlob.mock.calls[0][0] as Blob)
    expect(Object.keys(zip.files)).toEqual(['Bracket.step'])
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

// The export dialog's length-unit pick is a document write, so it must land
// with the bytes and only with them: a cancel or a failed export leaves the
// stored numbers meaning what they meant before.
describe('PartExportImport length unit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    usePartEditorStore.setState({ ...DEFAULT_PART_EDITOR_DATA, doc: DOC })
    useSketchEditorStore.getState().clearNormalSelection()
    useEditorState.setState({ editingFeatureId: null })
  })

  it('exports in the picked unit and records it after the download', async () => {
    exportViaWorker.mockResolvedValue(new Uint8Array([1]))
    const onSetLengthUnit = vi.fn()
    const ref = renderDialog(onSetLengthUnit)
    act(() => ref.current!.openExport(null, 'bracket'))

    fireEvent.click(screen.getByLabelText('in'))
    expect(onSetLengthUnit).not.toHaveBeenCalled()

    await clickDownload()

    expect(exportViaWorker.mock.calls[0][0]).toMatchObject({ length_unit: 'inch' })
    expect(onSetLengthUnit).toHaveBeenCalledWith('inch')
    expect(await screen.findByText('Document unit set to inches')).toBeInTheDocument()
  })

  it('records nothing when the pick already matches the document unit', async () => {
    exportViaWorker.mockResolvedValue(new Uint8Array([1]))
    const onSetLengthUnit = vi.fn()
    const ref = renderDialog(onSetLengthUnit)
    act(() => ref.current!.openExport(null, 'bracket'))

    await clickDownload()

    expect(onSetLengthUnit).not.toHaveBeenCalled()
    expect(screen.queryByText(/Document unit set/)).toBeNull()
  })

  it('leaves the document unit alone when the export is cancelled', () => {
    const onSetLengthUnit = vi.fn()
    const ref = renderDialog(onSetLengthUnit)
    act(() => ref.current!.openExport(null, 'bracket'))

    fireEvent.click(screen.getByLabelText('in'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onSetLengthUnit).not.toHaveBeenCalled()
  })

  it('does not reinterpret the document when the export fails', async () => {
    exportViaWorker.mockRejectedValue(new Error('kernel boom'))
    const onSetLengthUnit = vi.fn()
    const ref = renderDialog(onSetLengthUnit)
    act(() => ref.current!.openExport(null, 'bracket'))

    fireEvent.click(screen.getByLabelText('in'))
    await clickDownload()

    expect(await screen.findByText(/Export error: kernel boom/)).toBeInTheDocument()
    expect(onSetLengthUnit).not.toHaveBeenCalled()
  })

  // Switching to YAML after picking inch drops the unit from the request, so
  // the document is not reinterpreted by a file that carries it as saved.
  it('does not apply a pick left over from the STEP tab to a YAML export', async () => {
    const onSetLengthUnit = vi.fn()
    const ref = renderDialog(onSetLengthUnit)
    act(() => ref.current!.openExport(null, 'bracket'))

    fireEvent.click(screen.getByLabelText('in'))
    fireEvent.click(screen.getByLabelText('YAML'))
    await clickDownload()

    expect(onSetLengthUnit).not.toHaveBeenCalled()
  })

  it('records the unit once when the export bundles several parts as a zip', async () => {
    usePartEditorStore.setState({
      ...DEFAULT_PART_EDITOR_DATA,
      doc: DOC,
      bodies: TWO_BODIES,
      partLabels: { body_a: 'Bracket', body_b: 'Plate' },
    })
    useSketchEditorStore.getState().setNormalSelection(new Set(['@body_a', '@body_b']))
    exportViaWorker.mockResolvedValue(new Uint8Array([1]))
    const onSetLengthUnit = vi.fn()
    const ref = renderDialog(onSetLengthUnit)
    act(() => ref.current!.openExport(null, 'bracket'))

    fireEvent.click(screen.getByLabelText('Selected Parts'))
    fireEvent.click(screen.getByLabelText('ZIP archive'))
    fireEvent.click(screen.getByLabelText('in'))
    await clickDownload()

    await waitFor(() => expect(onSetLengthUnit).toHaveBeenCalledTimes(1))
    expect(onSetLengthUnit).toHaveBeenCalledWith('inch')
  })

  it('refuses to open the export dialog while a feature edit is in progress', async () => {
    useEditorState.setState({ editingFeatureId: 'extrude1' })
    const ref = renderDialog()
    act(() => ref.current!.openExport('body_a', 'Body'))

    expect(screen.queryByText('Export Model')).toBeNull()
    expect(await screen.findByText('Finish the edit to export')).toBeInTheDocument()
  })

  it('does not overwrite a unit change made while the export ran', async () => {
    let release!: (bytes: Uint8Array) => void
    exportViaWorker.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const onSetLengthUnit = vi.fn()
    const ref = renderDialog(onSetLengthUnit)
    act(() => ref.current!.openExport(null, 'bracket'))

    fireEvent.click(screen.getByLabelText('in'))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Download' })) })

    // The download is still in flight; an undo (or a document swap) moves the
    // live unit to inch before the bytes land.
    await act(async () => {
      usePartEditorStore.setState({ ...DEFAULT_PART_EDITOR_DATA, doc: { ...DOC, length_unit: 'inch' } })
    })
    await act(async () => {
      release(new Uint8Array([1]))
      await Promise.resolve()
    })

    expect(onSetLengthUnit).not.toHaveBeenCalled()
    expect(await screen.findByText(/Document unit unchanged/)).toBeInTheDocument()
  })

  it('writes millimetres as the absent field for an inch document', async () => {
    usePartEditorStore.setState({
      ...DEFAULT_PART_EDITOR_DATA,
      doc: { ...DOC, length_unit: 'inch' },
    })
    exportViaWorker.mockResolvedValue(new Uint8Array([1]))
    const onSetLengthUnit = vi.fn()
    const ref = renderDialog(onSetLengthUnit)
    act(() => ref.current!.openExport(null, 'bracket'))

    fireEvent.click(screen.getByLabelText('mm'))
    await clickDownload()

    expect(exportViaWorker.mock.calls[0][0]).not.toHaveProperty('length_unit')
    expect(onSetLengthUnit).toHaveBeenCalledWith('mm')
  })
})
