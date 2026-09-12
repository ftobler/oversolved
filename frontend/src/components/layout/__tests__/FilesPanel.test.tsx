import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import type { EntryMeta, ProvenanceRecord, WorkspaceEntry } from '@/workspace/types'
import type { WorkspaceSession } from '@/workspace/session'

const storeMock = vi.hoisted(() => ({
  removeEntry: vi.fn(async (_workspace: string, _entry: string) => {}),
}))
vi.mock('@/workspace/store', () => ({ getWorkspaceStore: () => storeMock }))

import { FilesPanel } from '@/components/layout/FilesPanel'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { formatBytes } from '@/utils/formatBytes'
import { markFilesSent, fileIdsMissingFromWorker, clearWorkerFileIds } from '@/kernel/worker/workerFiles'

const entries: EntryMeta[] = [
  { id: 'd1', path: 'documents/Bracket.yaml', kind: 'document', name: 'Bracket', docKind: 'part', rev: 1 },
  { id: 'f1', path: 'files/shaft.step', kind: 'file', name: 'shaft.step', fileKind: 'step', mime: 'application/step', size: 2048, rev: 1 },
  { id: 'f2', path: 'files/old.step', kind: 'file', name: 'old.step', fileKind: 'step', mime: 'application/step', size: 4096, rev: 1 },
]

const provenance: ProvenanceRecord[] = [{ entry: 'f1', origin: 'file:shaft.step', rev: 1 }]

interface SessionOptions {
  listed?: EntryMeta[]
  referenceEdges?: () => Promise<Record<string, string[]>>
}

function installSession(options: SessionOptions = {}) {
  useWorkspaceSessionStore.setState({
    session: {
      workspace: 'ws',
      open: vi.fn(),
      listEntries: vi.fn(async () => options.listed ?? entries),
      savedRevs: vi.fn(async () => new Map<string, number>()),
      readEntry: vi.fn(),
      writeEntry: vi.fn(),
      originOf: vi.fn(async (entry: string) => provenance.find(record => record.entry === entry)),
      resolveFile: vi.fn(),
      referencesOf: vi.fn(),
      referenceEdges: vi.fn(options.referenceEdges ?? (async () => ({ d1: ['f1'] }))),
    } as unknown as WorkspaceSession,
  })
}

beforeEach(() => {
  useWorkspaceSessionStore.setState({ session: null })
  storeMock.removeEntry.mockClear()
  clearWorkerFileIds()
  installSession()
})

describe('FilesPanel', () => {
  it('reports each file name, kind and size', async () => {
    render(<FilesPanel />)
    expect(await screen.findByText('shaft.step')).toBeInTheDocument()
    expect(screen.getByText('old.step')).toBeInTheDocument()
    expect(screen.getAllByText('step')).toHaveLength(2)
    expect(screen.getByText(formatBytes(2048))).toBeInTheDocument()
  })

  it('lists the entry that references a file', async () => {
    render(<FilesPanel />)
    await screen.findByText('shaft.step')
    expect(await screen.findByText('Bracket')).toBeInTheDocument()
  })

  it('labels an orphan with its size', async () => {
    render(<FilesPanel />)
    await screen.findByText('old.step')
    expect(await screen.findByText(`orphan, ${formatBytes(4096)}`)).toBeInTheDocument()
  })

  it('renders the recorded origin and a neutral "No origin" when absent', async () => {
    render(<FilesPanel />)
    await screen.findByText('shaft.step')
    expect(await screen.findByText('file:shaft.step')).toBeInTheDocument()
    expect(screen.getByText('No origin')).toBeInTheDocument()
  })

  it('withholds the orphan verdict and prune control until the reference scan resolves', async () => {
    let releaseScan!: () => void
    const scanDone = new Promise<void>(resolve => { releaseScan = resolve })
    const referenceEdges = vi.fn(async () => {
      await scanDone
      return { d1: ['f1'] }
    })
    // Only the referenced file is listed, so any orphan verdict is wrong.
    installSession({ listed: entries.filter(entry => entry.id !== 'f2'), referenceEdges })

    render(<FilesPanel />)
    // The list has resolved and the referenced file is on screen, but its edges
    // are still being read: it must not look like an orphan or be prunable.
    await screen.findByText('shaft.step')
    expect(screen.queryByText(/^orphan/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Prune orphans')).not.toBeInTheDocument()

    releaseScan()
    // Once scanned, the file is known to have a referrer, so it stays unprunable.
    expect(await screen.findByText('Bracket')).toBeInTheDocument()
    await waitFor(() => expect(referenceEdges).toHaveBeenCalled())
    expect(screen.queryByText(/^orphan/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Prune orphans')).not.toBeInTheDocument()
    expect(storeMock.removeEntry).not.toHaveBeenCalled()
  })

  it('writes replaced bytes to the workspace and drops the worker byte cache id', async () => {
    const session = useWorkspaceSessionStore.getState().session!
    session.readEntry = vi.fn(async (): Promise<WorkspaceEntry> => ({
      id: 'f1', kind: 'file', name: 'shaft.step', mime: 'application/step', fileKind: 'step', bytes: new Uint8Array([1]),
    }))
    const writeEntry = vi.fn(async (_entry: WorkspaceEntry) => {})
    session.writeEntry = writeEntry
    // The solver worker already holds the old payload for this id.
    markFilesSent({ f1: new Uint8Array([1]) })
    expect(fileIdsMissingFromWorker(['f1'])).toEqual([])

    const { container } = render(<FilesPanel />)
    await screen.findByText('shaft.step')
    const input = container.querySelector('.file-replace-input') as HTMLInputElement
    fireEvent.change(input, {
      target: { files: [{ name: 'shaft.step', arrayBuffer: async () => new Uint8Array([9, 9, 9]).buffer }] },
    })

    await waitFor(() => expect(writeEntry).toHaveBeenCalledTimes(1))
    const written = writeEntry.mock.calls[0][0]
    expect(Array.from(written.bytes ?? [])).toEqual([9, 9, 9])
    // The next solve must re-read the fresh bytes instead of trusting the
    // worker's cached copy.
    expect(fileIdsMissingFromWorker(['f1'])).toEqual(['f1'])
  })
})
