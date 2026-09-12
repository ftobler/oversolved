import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRef } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { parse as parseYaml } from 'yaml'

const downloadBlob = vi.fn()
const exportViaWorker = vi.fn()
vi.mock('@/utils/core/downloadBlob', () => ({ downloadBlob: (...args: unknown[]) => downloadBlob(...args) }))
vi.mock('@/kernel/worker/solverClient', () => ({ exportViaWorker: (...args: unknown[]) => exportViaWorker(...args) }))

import PartExportImport from '@/pages/PartExportImport'
import type { PartExportImportHandle } from '@/pages/PartExportImport'
import { usePartEditorStore, DEFAULT_PART_EDITOR_DATA } from '@/stores/partEditorStore'
import { ToastProvider } from '@/contexts/ToastContext'
import { getFileRegistry } from '@/stores/fileRegistry'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { resetFakeIndexedDb } from '@/stores/documentStore/__tests__/fakeIndexedDb'
import { resetDbConnection } from '@/stores/documentStore/idb'
import type { PartDoc } from '@/types/cad'
import type { WorkspaceSession } from '@/workspace/session'

const DOC: PartDoc = {
  features: [
    { id: 'Origin', kind: 'origin' },
    { id: 'extrude1', kind: 'extrude', extrude: { sketch: 'S1', distance: 10 } },
  ],
}

// jsdom's Blob has no .text(), so go through FileReader.
function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

function openExportDialog() {
  const ref = createRef<PartExportImportHandle>()
  render(
    <ToastProvider>
      <PartExportImport ref={ref} uuid="u1" />
    </ToastProvider>
  )
  act(() => ref.current!.openExport(null, 'bracket'))
  return ref
}

describe('PartExportImport YAML export', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    usePartEditorStore.setState({ ...DEFAULT_PART_EDITOR_DATA, doc: DOC })
  })

  it('downloads the document source and never wakes the kernel', async () => {
    openExportDialog()

    fireEvent.click(screen.getByLabelText('YAML'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    })

    expect(exportViaWorker).not.toHaveBeenCalled()
    expect(downloadBlob).toHaveBeenCalledTimes(1)
    const [blob, filename] = downloadBlob.mock.calls[0] as [Blob, string]
    // Only the extension is asserted: the base name is seeded once at mount, so
    // it does not yet track the document name. That is a separate open bug.
    expect(filename.endsWith('.yaml')).toBe(true)
    expect(blob.type).toBe('application/yaml')
    // Round-trips: the exported file must parse back into the same document,
    // builtins included, so it can be re-imported as-is.
    expect(parseYaml(await readBlobText(blob))).toEqual(DOC)
  })

  it('closes the dialog after the download', async () => {
    openExportDialog()

    fireEvent.click(screen.getByLabelText('YAML'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    })

    expect(screen.queryByText('Export Model')).toBeNull()
  })

  it('still routes STEP through the kernel', async () => {
    exportViaWorker.mockResolvedValue(new Uint8Array([1, 2, 3]))
    openExportDialog()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    })

    expect(exportViaWorker).toHaveBeenCalledTimes(1)
    expect((downloadBlob.mock.calls[0][1] as string).endsWith('.step')).toBe(true)
  })

  it('resolves an import reference into the files side channel for STEP export', async () => {
    resetFakeIndexedDb()
    resetDbConnection()
    const entry = await getFileRegistry().create({
      name: 'a.step', kind: 'step', mime: 'application/step', bytes: new Uint8Array([7, 8]),
    })
    usePartEditorStore.setState({
      ...DEFAULT_PART_EDITOR_DATA,
      doc: { features: [...(DOC.features ?? []), { id: 'imp1', kind: 'import_step', file_id: entry.id }] },
    })
    exportViaWorker.mockResolvedValue(new Uint8Array([9]))
    openExportDialog()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    })

    const call = exportViaWorker.mock.calls[0] as [unknown, unknown, Record<string, Uint8Array>]
    expect(Array.from(call[2][entry.id])).toEqual([7, 8])
  })

  it('resolves an import reference through the open workspace session for STEP export', async () => {
    resetFakeIndexedDb()
    resetDbConnection()
    const entry = await getFileRegistry().create({
      name: 'a.step', kind: 'step', mime: 'application/step', bytes: new Uint8Array([7, 8]),
    })
    // The workspace entry is authoritative: the session resolver stands in for a
    // STEP adopted from a folder/zip/.oversolved that the flat registry lacks.
    const resolveFile = vi.fn(async () => new Uint8Array([9, 9]))
    useWorkspaceSessionStore.setState({ session: { workspace: 'ws', resolveFile } as unknown as WorkspaceSession })
    try {
      usePartEditorStore.setState({
        ...DEFAULT_PART_EDITOR_DATA,
        doc: { features: [...(DOC.features ?? []), { id: 'imp1', kind: 'import_step', file_id: entry.id }] },
      })
      exportViaWorker.mockResolvedValue(new Uint8Array([9]))
      openExportDialog()

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Download' }))
      })

      expect(resolveFile).toHaveBeenCalledWith(entry.id)
      const call = exportViaWorker.mock.calls[0] as [unknown, unknown, Record<string, Uint8Array>]
      expect(Array.from(call[2][entry.id])).toEqual([9, 9])
    } finally {
      useWorkspaceSessionStore.setState({ session: null })
    }
  })
})
