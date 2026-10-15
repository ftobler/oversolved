// The open-time journal offer at the page seam: a journal record ahead of the
// stored document holds the editor back and asks; Restore parks the snapshot
// for the loader without writing anything; Discard deletes the record. The
// store load is mocked, so the parsed stored text is what the offer is judged
// against, exactly as the real page judges it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { resetWorkspaceIdb } from '@/workspace/__tests__/idbHarness'
import { IdbWorkspaceStore } from '@/workspace/store'
import { useRecoveryStore } from '@/stores/recoveryStore'
import { parse as parseYaml } from 'yaml'
import { idbRecoveryJournal, readRecoveryJournal } from '@/recovery/journal'
import { takeRecoveryRestore } from '@/recovery/restore'
import { docHashOf } from '@/drive/docHash'
import type { PartDoc } from '@/types/cad'

vi.mock('@/pages/AssemblyEditor', () => ({
  default: function AssemblyEditorMock() {
    return <div>ASSEMBLY EDITOR</div>
  },
}))
vi.mock('@/pages/Part', () => ({
  default: function PartMock() {
    return <div>PART EDITOR</div>
  },
}))

const load = vi.fn()
vi.mock('@/adapters/backend', () => ({
  backendBundle: {
    get documents() { return { load } },
  },
}))

import WorkspacePage from '@/pages/WorkspacePage'

const storedText = 'version: 1\nkind: part\nfeatures:\n  - id: sk1\n    kind: sketch\n    label: stored\n'
// The docs are built from the parsed stored text, so the "matches" case hashes
// identical to what the offer check parses, not merely similar.
const storedDoc = (): PartDoc => parseYaml(storedText) as PartDoc
const editedDoc = (): PartDoc => {
  const doc = storedDoc()
  doc.features![0].label = 'edited'
  return doc
}

async function parkJournal(workspace: string, doc: PartDoc): Promise<void> {
  await idbRecoveryJournal.write({
    docId: workspace,
    workspace,
    updatedAt: Date.now(),
    docHash: docHashOf(doc),
    doc,
    repro: null,
  })
}

beforeEach(() => {
  resetWorkspaceIdb()
  act(() => { useRecoveryStore.getState().reset() })
  load.mockReset()
  load.mockImplementation(async () => ({ content: storedText, name: 'Doc', kind: 'document', docKind: 'part' }))
})

afterEach(() => {
  act(() => { useRecoveryStore.getState().reset() })
})

function wrap(workspace: string) {
  return render(
    <MemoryRouter initialEntries={[`/workspaces/${workspace}/entries/${workspace}`]}>
      <Routes>
        <Route path="/workspaces/:workspaceId/entries/:entryId" element={<WorkspacePage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('WorkspacePage journal restore offer', () => {
  it('asks before mounting the editor when the journal is ahead of the stored document', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Doc', { docKind: 'part' })
    await parkJournal(workspace, editedDoc())

    wrap(workspace)

    await waitFor(() => expect(screen.getByText('Restore unsaved changes?')).toBeInTheDocument())
    expect(screen.queryByText('PART EDITOR')).not.toBeInTheDocument()
    expect(screen.getByText(/kept by the recovery journal/)).toBeInTheDocument()
  })

  it('does not ask when the journal matches the stored document', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Doc', { docKind: 'part' })
    await parkJournal(workspace, storedDoc())

    wrap(workspace)

    await waitFor(() => expect(screen.getByText('PART EDITOR')).toBeInTheDocument())
    expect(screen.queryByText('Restore unsaved changes?')).not.toBeInTheDocument()
  })

  it('parks the snapshot for the loader on Restore and writes nothing', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Doc', { docKind: 'part' })
    await parkJournal(workspace, editedDoc())
    wrap(workspace)
    await waitFor(() => expect(screen.getByText('Restore unsaved changes?')).toBeInTheDocument())

    await act(async () => { fireEvent.click(screen.getByText('Restore changes')) })

    await waitFor(() => expect(screen.getByText('PART EDITOR')).toBeInTheDocument())
    // The real editor consumes this in its load seam; the mocked one leaves it
    // parked, which is exactly what proves it was handed over.
    expect(takeRecoveryRestore(workspace)?.features?.[0].label).toBe('edited')
    // Restore is in memory: the record survives until a save or the next flush.
    expect(await readRecoveryJournal(workspace)).toBeDefined()
  })

  it('clears the journal on Discard and mounts the editor', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Doc', { docKind: 'part' })
    await parkJournal(workspace, editedDoc())
    wrap(workspace)
    await waitFor(() => expect(screen.getByText('Restore unsaved changes?')).toBeInTheDocument())

    await act(async () => { fireEvent.click(screen.getByText('Discard changes')) })

    await waitFor(() => expect(screen.getByText('PART EDITOR')).toBeInTheDocument())
    expect(await readRecoveryJournal(workspace)).toBeUndefined()
  })
})
