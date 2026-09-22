import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { EntryMeta, WorkspaceEntry } from '@/workspace/types'
import type { WorkspaceSession } from '@/workspace/session'

// R5, the files half: everything FilesPanel owned is asserted here on the row
// or the identity card that inherited it.

const storeMock = vi.hoisted(() => ({
  list: vi.fn(async () => [{
    workspace: 'ws', name: 'test', entryCount: 3, size: 2048, rev: 1,
    createdAt: 0, updatedAt: 0, coverEntry: 'p1',
  }]),
  addEntry: vi.fn(async (_w: string, _e: WorkspaceEntry) => 'new-id'),
  renameEntry: vi.fn(async () => {}),
  cloneEntry: vi.fn(async () => 'clone-id'),
  removeEntry: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
  duplicate: vi.fn(async () => ({ workspace: 'ws2' })),
  trash: vi.fn(async () => {}),
  export: vi.fn(async () => []),
}))
vi.mock('@/workspace/store', () => ({ getWorkspaceStore: () => storeMock }))

vi.mock('@/stores/previewStore', () => ({ usePreview: () => undefined }))

const workerMock = vi.hoisted(() => ({ dropWorkerFileId: vi.fn() }))
vi.mock('@/kernel/worker/workerFiles', async importOriginal => ({
  ...(await importOriginal<typeof import('@/kernel/worker/workerFiles')>()),
  dropWorkerFileId: workerMock.dropWorkerFileId,
}))

import WorkspaceView from '@/pages/WorkspaceView'
import { EntryReferencedError } from '@/workspace/errors'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'

function meta(id: string, name: string, extra: Partial<EntryMeta>): EntryMeta {
  return { id, path: `documents/${name}.yaml`, kind: 'document', name, rev: 1, updatedAt: 0, ...extra }
}

const entries: EntryMeta[] = [
  meta('p1', 'Bracket', { docKind: 'part' }),
  meta('a1', 'Gearbox', { docKind: 'assembly' }),
  meta('f1', 'shaft.step', { kind: 'file', fileKind: 'step', size: 1024 }),
]

function installSession(all: EntryMeta[] = entries, edges: Record<string, string[]> = {}) {
  const session = {
    workspace: 'ws',
    listEntries: vi.fn(async () => all),
    savedRevs: vi.fn(async () => new Map<string, number>(all.map(e => [e.id, e.rev ?? 0]))),
    readEntry: vi.fn(async (id: string): Promise<WorkspaceEntry> => (
      { id, kind: 'file', name: 'shaft.step', bytes: new Uint8Array([1]) }
    )),
    writeEntry: vi.fn(async (_entry: WorkspaceEntry) => {}),
    originOf: vi.fn(async () => undefined),
    provenance: vi.fn(async () => []),
    resolveFile: vi.fn(),
    referencesOf: vi.fn(async () => []),
    referenceEdges: vi.fn(async () => edges),
  }
  useWorkspaceSessionStore.setState({ session: session as unknown as WorkspaceSession })
  return session
}

function renderView() {
  return render(
    <MemoryRouter initialEntries={['/workspaces/ws']}>
      <Routes>
        <Route path="/workspaces/:workspaceId" element={<WorkspaceView />} />
        <Route path="/workspaces/:workspaceId/entries/:entryId" element={<div>EDITOR</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

// jsdom's File carries no arrayBuffer in this environment, so the picked file
// is the smallest thing the handler actually reads.
function pickedFile(bytes: number[]): File {
  return {
    name: 'new.step',
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  } as unknown as File
}

beforeEach(() => {
  useWorkspaceSessionStore.setState({ session: null })
  useUnsavedChangesStore.getState().setDirty(false)
  useUnsavedChangesStore.getState().dismissConfirm()
  Object.values(storeMock).forEach(fn => fn.mockClear())
  workerMock.dropWorkerFileId.mockClear()
  storeMock.list.mockResolvedValue([{
    workspace: 'ws', name: 'test', entryCount: 3, size: 2048, rev: 1,
    createdAt: 0, updatedAt: 0, coverEntry: 'p1',
  }])
})

describe('WorkspaceView files', () => {
  // J8: the file's data and its verb live on the one row it already has.
  it('replaces a file entry\'s bytes from its own row', async () => {
    const session = installSession()
    renderView()
    await screen.findByText('shaft.step')

    const input = screen.getByLabelText('Replace shaft.step')
    fireEvent.change(input, { target: { files: [pickedFile([7, 8, 9])] } })

    await waitFor(() => expect(session.writeEntry).toHaveBeenCalled())
    const written = session.writeEntry.mock.calls[0][0]
    // The entry keeps its id, which is what every reference to it keeps
    // pointing at: that is the whole reason replace is a verb of its own.
    expect(written.id).toBe('f1')
    expect([...(written.bytes ?? [])]).toEqual([7, 8, 9])
    // The live worker still holds the old payload under that id.
    expect(workerMock.dropWorkerFileId).toHaveBeenCalledWith('f1')
  })

  // The panel's input was `display: none`, which is out of the tab order, and
  // its label was not focusable: the gesture was mouse-only.
  it('keeps the replace input focusable and named', async () => {
    installSession()
    renderView()
    await screen.findByText('shaft.step')

    const input = screen.getByLabelText('Replace shaft.step') as HTMLInputElement
    expect(input.type).toBe('file')
    expect(input.disabled).toBe(false)
    expect(input.hidden).toBe(false)
    input.focus()
    expect(document.activeElement).toBe(input)
  })

  // jsdom applies no stylesheet, so the assertions above stay green even if the
  // rule goes back to `display: none` and puts the control out of reach again.
  // The sheet itself is what has to be asserted.
  it('clips the replace input in the sheet rather than hiding it', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/pages/WorkspaceView.css'), 'utf8')
    const rule = css.split('.workspace-entry-replace-input')[1]?.split('}')[0] ?? ''
    expect(rule).toContain('position: absolute')
    expect(rule).not.toContain('display: none')
    expect(rule).not.toContain('visibility: hidden')
  })

  // A disabled input leaves the tab order, which would drop a keyboard user's
  // focus mid-gesture, so the in-flight guard is the handler, not the control.
  it('ignores a second pick while a replace is in flight', async () => {
    const session = installSession()
    let settle: () => void = () => {}
    session.writeEntry.mockReturnValueOnce(new Promise<void>(resolve => { settle = resolve }))
    renderView()
    await screen.findByText('shaft.step')

    const input = screen.getByLabelText('Replace shaft.step') as HTMLInputElement
    fireEvent.change(input, { target: { files: [pickedFile([1])] } })
    await waitFor(() => expect(input.getAttribute('aria-disabled')).toBe('true'))
    expect(input.disabled).toBe(false)

    fireEvent.change(input, { target: { files: [pickedFile([2])] } })
    expect(session.writeEntry).toHaveBeenCalledTimes(1)

    settle()
    await waitFor(() => expect(input.getAttribute('aria-disabled')).toBe('false'))
  })

  it('offers no replace control on a document row', async () => {
    installSession()
    renderView()
    await screen.findByText('Bracket')
    expect(screen.queryByLabelText('Replace Bracket')).toBeNull()
  })

  it('reports a failed replace in the banner instead of swallowing it', async () => {
    const session = installSession()
    session.writeEntry.mockRejectedValueOnce(new Error('quota exceeded'))
    renderView()
    await screen.findByText('shaft.step')

    fireEvent.change(screen.getByLabelText('Replace shaft.step'), { target: { files: [pickedFile([1])] } })
    await screen.findByText(/quota exceeded/)
  })

  it('prunes the unreferenced files from the identity card', async () => {
    installSession()
    renderView()
    await screen.findByText('shaft.step')

    fireEvent.click(await screen.findByLabelText('Prune orphans'))
    await screen.findByText('Prune Orphans')
    // The dialog names what is about to move, with its size.
    expect(screen.getByText(/shaft\.step \(1\.0 KB\)/)).toBeTruthy()

    fireEvent.click(screen.getByText('Prune'))
    await waitFor(() => expect(storeMock.removeEntry).toHaveBeenCalledWith('ws', 'f1'))
  })

  it('offers no prune while every file is referenced', async () => {
    installSession(entries, { p1: ['f1'] })
    renderView()
    await screen.findByText('shaft.step')
    // The row still says who holds it; there is just nothing to sweep.
    await screen.findByText(/used by Bracket/)
    expect(screen.queryByLabelText('Prune orphans')).toBeNull()
  })

  // Before the scan resolves, every file has zero KNOWN referrers, so offering
  // the sweep then would offer to delete files that are in use.
  it('withholds the prune control until the reference scan resolves', async () => {
    const session = installSession()
    session.referenceEdges.mockReturnValue(new Promise(() => {}))
    renderView()
    await screen.findByText('shaft.step')
    expect(screen.queryByLabelText('Prune orphans')).toBeNull()
  })

  // A non-reference failure must surface in the dialog that owns the verb
  // rather than be swallowed or leave the sweep half-finished and silent.
  it('reports a generic prune failure inside the dialog', async () => {
    installSession()
    storeMock.removeEntry.mockRejectedValueOnce(new Error('disk gone'))
    renderView()
    await screen.findByText('shaft.step')

    fireEvent.click(await screen.findByLabelText('Prune orphans'))
    fireEvent.click(screen.getByText('Prune'))

    await screen.findByText('disk gone')
    expect(screen.getByText('Prune Orphans')).toBeTruthy()
  })

  it('names the referrer when the store refuses a prune', async () => {
    installSession()
    storeMock.removeEntry.mockRejectedValueOnce(
      new EntryReferencedError('f1', [{ id: 'p1', name: 'Bracket' }]),
    )
    const { container } = renderView()
    await screen.findByText('shaft.step')

    fireEvent.click(await screen.findByLabelText('Prune orphans'))
    fireEvent.click(screen.getByText('Prune'))

    await screen.findByText('Cannot Prune')
    const named = [...container.querySelectorAll('.where-used-name')].map(el => el.textContent)
    expect(named).toEqual(['Bracket'])
  })
})
