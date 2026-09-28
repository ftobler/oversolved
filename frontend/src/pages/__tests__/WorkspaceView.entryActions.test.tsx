import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import type { EntryMeta, WorkspaceEntry } from '@/workspace/types'
import type { WorkspaceSession } from '@/workspace/session'

// The header's explicit add buttons and the per-row Export action. The store is
// mocked; the worker is the only export seam mocked, so the shared part-export
// helper runs for real between the row and the kernel.
const storeMock = vi.hoisted(() => ({
  list: vi.fn(),
  addEntry: vi.fn(async (_w: string, _e: WorkspaceEntry) => 'new-id'),
  renameEntry: vi.fn(async () => {}),
  cloneEntry: vi.fn(async () => 'clone-id'),
  removeEntry: vi.fn(async () => {}),
  readEntry: vi.fn(),
}))
vi.mock('@/workspace/store', () => ({ getWorkspaceStore: () => storeMock }))

vi.mock('@/stores/previewStore', () => ({ usePreview: () => undefined }))

const exportViaWorker = vi.hoisted(() => vi.fn())
vi.mock('@/kernel/worker/solverClient', () => ({ exportViaWorker: (...args: unknown[]) => exportViaWorker(...args) }))

const downloads = vi.hoisted(() => ({ calls: [] as { blob: Blob; filename: string }[] }))
vi.mock('@/utils/core/downloadBlob', () => ({
  downloadBlob: (blob: Blob, filename: string) => { downloads.calls.push({ blob, filename }) },
}))

import WorkspaceView from '@/pages/WorkspaceView'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { clearWorkerFileIds } from '@/kernel/worker/workerFiles'

const SUMMARY = {
  workspace: 'ws', name: 'test', entryCount: 3, size: 2048, rev: 1,
  createdAt: 0, updatedAt: 0, coverEntry: 'p1',
}

function meta(id: string, name: string, extra: Partial<EntryMeta>): EntryMeta {
  return { id, path: `documents/${name}.yaml`, kind: 'document', name, rev: 1, updatedAt: 0, ...extra }
}

const entries: EntryMeta[] = [
  meta('p1', 'Bracket', { docKind: 'part' }),
  meta('a1', 'Gearbox', { docKind: 'assembly' }),
  meta('f1', 'shaft.step', { kind: 'file', fileKind: 'step', mime: 'application/step', size: 3 }),
]

// Deliberately not what a serializer would write (odd spacing, a comment): the
// source download must be the stored text byte for byte, not a re-emit.
const PART_TEXT = 'kind: part\nfeatures:\n  - id: Origin\n    kind: origin\n  - id: imp1\n    kind: import_step\n    file_id: f1   # the shaft\n'
const ASSEMBLY_TEXT = 'kind: assembly\nfeatures: []  # empty\n'
const SHAFT = new Uint8Array([1, 2, 3])

const stored: Record<string, WorkspaceEntry> = {
  p1: { id: 'p1', kind: 'document', name: 'Bracket', docKind: 'part', text: PART_TEXT },
  a1: { id: 'a1', kind: 'document', name: 'Gearbox', docKind: 'assembly', text: ASSEMBLY_TEXT },
  f1: { id: 'f1', kind: 'file', name: 'shaft.step', mime: 'application/step', bytes: SHAFT },
}

function installSession() {
  const session = {
    workspace: 'ws',
    listEntries: vi.fn(async () => entries),
    savedRevs: vi.fn(async () => new Map<string, number>(entries.map(e => [e.id, e.rev ?? 0]))),
    readEntry: vi.fn(async (id: string) => stored[id]),
    writeEntry: vi.fn(),
    originOf: vi.fn(async () => undefined),
    provenance: vi.fn(async () => []),
    resolveFile: vi.fn(async (id: string) => stored[id]?.bytes),
    referencesOf: vi.fn(async () => []),
    referenceEdges: vi.fn(async () => ({})),
  }
  useWorkspaceSessionStore.setState({ session: session as unknown as WorkspaceSession })
  return session
}

function EntrySentinel() {
  const { entryId } = useParams<{ entryId: string }>()
  return <div>EDITOR {entryId}</div>
}

function renderView() {
  return render(
    <MemoryRouter initialEntries={['/workspaces/ws']}>
      <Routes>
        <Route path="/workspaces/:workspaceId" element={<WorkspaceView />} />
        <Route path="/workspaces/:workspaceId/entries/:entryId" element={<EntrySentinel />} />
      </Routes>
    </MemoryRouter>,
  )
}

const dialog = () => document.querySelector('.dialog-component') as HTMLElement

// jsdom's Blob has no .text() or .arrayBuffer(), so go through FileReader.
function readBlob(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(blob)
  })
}

beforeEach(() => {
  useWorkspaceSessionStore.setState({ session: null })
  useUnsavedChangesStore.getState().setDirty(false)
  useUnsavedChangesStore.getState().dismissConfirm()
  downloads.calls = []
  Object.values(storeMock).forEach(fn => fn.mockClear())
  storeMock.list.mockResolvedValue([SUMMARY])
  exportViaWorker.mockReset()
  clearWorkerFileIds()
})

describe('WorkspaceView add buttons', () => {
  it('offers New part, New assembly and Upload, and no kind dropdown', async () => {
    installSession()
    renderView()
    await screen.findByText('Bracket')

    expect(screen.getByLabelText('New part')).toBeTruthy()
    expect(screen.getByLabelText('New assembly')).toBeTruthy()
    expect(screen.getByLabelText('Upload file')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('New part'))
    expect(screen.queryByLabelText('Entry kind')).toBeNull()
  })

  it('New assembly adds an assembly under the typed name and opens it', async () => {
    installSession()
    renderView()
    await screen.findByText('Bracket')

    fireEvent.click(screen.getByLabelText('New assembly'))
    expect(within(dialog()).getByText('New Assembly')).toBeTruthy()
    fireEvent.change(within(dialog()).getByPlaceholderText('Assembly name'), { target: { value: 'Drive' } })
    fireEvent.click(within(dialog()).getByText('Add'))

    await waitFor(() => expect(storeMock.addEntry).toHaveBeenCalledTimes(1))
    const [, entry] = storeMock.addEntry.mock.calls[0]
    expect(entry).toMatchObject({ kind: 'document', name: 'Drive', docKind: 'assembly' })
    await screen.findByText(new RegExp(`^EDITOR ${entry.id}$`))
  })

  it('New part adds a part', async () => {
    installSession()
    renderView()
    await screen.findByText('Bracket')

    fireEvent.click(screen.getByLabelText('New part'))
    expect(within(dialog()).getByText('New Part')).toBeTruthy()
    fireEvent.change(within(dialog()).getByPlaceholderText('Part name'), { target: { value: 'Plate' } })
    fireEvent.click(within(dialog()).getByText('Add'))

    await waitFor(() => expect(storeMock.addEntry).toHaveBeenCalledTimes(1))
    expect(storeMock.addEntry.mock.calls[0][1]).toMatchObject({ name: 'Plate', docKind: 'part' })
  })

  it('the kind follows the button even after the other one was opened first', async () => {
    installSession()
    renderView()
    await screen.findByText('Bracket')

    fireEvent.click(screen.getByLabelText('New assembly'))
    fireEvent.click(within(dialog()).getByText('Cancel'))
    fireEvent.click(screen.getByLabelText('New part'))
    fireEvent.change(within(dialog()).getByPlaceholderText('Part name'), { target: { value: 'Plate' } })
    fireEvent.click(within(dialog()).getByText('Add'))

    await waitFor(() => expect(storeMock.addEntry).toHaveBeenCalledTimes(1))
    expect(storeMock.addEntry.mock.calls[0][1]).toMatchObject({ docKind: 'part' })
  })
})

describe('WorkspaceView entry export', () => {
  it('downloads a file entry straight away under its name and mime', async () => {
    installSession()
    renderView()
    await screen.findByText('Bracket')

    fireEvent.click(screen.getByLabelText('Export shaft.step'))

    await waitFor(() => expect(downloads.calls).toHaveLength(1))
    expect(screen.queryByText('Export Model')).toBeNull()
    const [{ blob, filename }] = downloads.calls
    expect(filename).toBe('shaft.step')
    expect(blob.type).toBe('application/step')
    expect(Array.from(await readBlob(blob))).toEqual([1, 2, 3])
  })

  it('downloads a part source byte for byte from the dialog', async () => {
    installSession()
    renderView()
    await screen.findByText('Bracket')

    fireEvent.click(screen.getByLabelText('Export Bracket'))
    fireEvent.click(within(dialog()).getByLabelText('YAML'))
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: 'Download' })) })

    await waitFor(() => expect(downloads.calls).toHaveLength(1))
    expect(exportViaWorker).not.toHaveBeenCalled()
    const [{ blob, filename }] = downloads.calls
    expect(filename).toBe('Bracket.yaml')
    expect(new TextDecoder().decode(await readBlob(blob))).toBe(PART_TEXT)
    expect(screen.queryByText('Export Model')).toBeNull()
  })

  it('exports a part as STEP through the worker with the parsed spec and its files', async () => {
    exportViaWorker.mockResolvedValue(new Uint8Array([9, 9]))
    installSession()
    renderView()
    await screen.findByText('Bracket')

    fireEvent.click(screen.getByLabelText('Export Bracket'))
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: 'Download' })) })

    await waitFor(() => expect(downloads.calls).toHaveLength(1))
    const [spec, options, files] = exportViaWorker.mock.calls[0] as [Record<string, unknown>, unknown, Record<string, Uint8Array>]
    expect(spec).toMatchObject({ id: 'p1', kind: 'part' })
    expect((spec.features as { id: string }[]).map(f => f.id)).toEqual(['imp1'])  // builtins stripped
    expect(options).toMatchObject({ format: 'step', bodyId: null })
    expect(Array.from(files.f1)).toEqual([1, 2, 3])
    expect(downloads.calls[0].filename).toBe('Bracket.step')
    expect(downloads.calls[0].blob.type).toBe('application/step')
  })

  it('reports a part with no solid geometry in the banner', async () => {
    exportViaWorker.mockResolvedValue(null)
    installSession()
    renderView()
    await screen.findByText('Bracket')

    fireEvent.click(screen.getByLabelText('Export Bracket'))
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: 'Download' })) })

    await screen.findByText(/no solid geometry to export/)
    expect(downloads.calls).toHaveLength(0)
  })

  it('offers an assembly its source only, and downloads it as stored', async () => {
    installSession()
    renderView()
    await screen.findByText('Bracket')

    fireEvent.click(screen.getByLabelText('Export Gearbox'))
    expect(within(dialog()).queryByLabelText('STEP')).toBeNull()
    expect(within(dialog()).queryByLabelText('STL')).toBeNull()
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: 'Download' })) })

    await waitFor(() => expect(downloads.calls).toHaveLength(1))
    expect(downloads.calls[0].filename).toBe('Gearbox.yaml')
    expect(new TextDecoder().decode(await readBlob(downloads.calls[0].blob))).toBe(ASSEMBLY_TEXT)
  })

  it('refuses a second file export while the first is in flight', async () => {
    const session = installSession()
    let release!: () => void
    session.readEntry.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(stored.f1) }))
    renderView()
    await screen.findByText('Bracket')

    const button = screen.getByLabelText('Export shaft.step') as HTMLButtonElement
    fireEvent.click(button)
    await waitFor(() => expect(button.disabled).toBe(true))
    fireEvent.click(button)
    await act(async () => { release() })

    await waitFor(() => expect(downloads.calls).toHaveLength(1))
    expect(session.readEntry).toHaveBeenCalledTimes(1)
  })
})
