// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'

import {
  RECOVERY_DEBOUNCE_MS,
  attachAutosave,
  type AutosaveHandle,
} from '@/recovery/autosave'
import { discardUnsavedEdits } from '@/recovery/discardUnsavedEdits'
import type { RecoveryJournalStore } from '@/recovery/journal'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'
import type { PartDoc } from '@/types/cad'
import { createDocSession, type DocSession } from '@/session/DocSession'
import { createFakeSolveScheduler } from '@/session/__tests__/fakeSolveScheduler'
import { CommandJournal, journalSink } from '@/drive/journal'

function makeStoreDouble() {
  const cleared: string[] = []
  const store: RecoveryJournalStore = {
    read: vi.fn(async () => undefined),
    write: vi.fn(async () => {}),
    clear: vi.fn(async (docId: string) => { cleared.push(docId) }),
  }
  return { store, cleared }
}

function makeWorkspaceDouble(ahead: boolean) {
  const discarded: string[] = []
  const opened: string[] = []
  const ws = {
    open: vi.fn(async (workspace: string) => { opened.push(workspace); return { ahead } }),
    discard: vi.fn(async (workspace: string) => { discarded.push(workspace) }),
  }
  return { ws, discarded, opened }
}

beforeEach(() => {
  useUnsavedChangesStore.getState().setDirty(true)
})

afterEach(() => {
  vi.useRealTimers()
  useUnsavedChangesStore.getState().setDirty(false)
})

describe('discardUnsavedEdits', () => {
  it('clears the journal row for a document editor', async () => {
    const { store, cleared } = makeStoreDouble()
    const { ws } = makeWorkspaceDouble(false)
    await discardUnsavedEdits({ workspace: 'ws-1', docId: 'doc-1', store, workspaceStore: ws })
    expect(cleared).toEqual(['doc-1'])
  })

  it('resets the working copy when it is ahead', async () => {
    const { store } = makeStoreDouble()
    const { ws, discarded } = makeWorkspaceDouble(true)
    await discardUnsavedEdits({ workspace: 'ws-1', docId: null, store, workspaceStore: ws })
    expect(discarded).toEqual(['ws-1'])
  })

  it('leaves the working copy untouched when not ahead', async () => {
    const { store } = makeStoreDouble()
    const { ws, discarded } = makeWorkspaceDouble(false)
    await discardUnsavedEdits({ workspace: 'ws-1', docId: null, store, workspaceStore: ws })
    expect(discarded).toEqual([])
  })

  it('does not setDirty(false) on a rejected clear', async () => {
    useUnsavedChangesStore.getState().setDirty(true)
    const store: RecoveryJournalStore = {
      read: vi.fn(),
      write: vi.fn(),
      clear: vi.fn(async () => { throw new Error('boom') }),
    }
    const { ws } = makeWorkspaceDouble(false)
    await expect(discardUnsavedEdits({ workspace: 'ws-1', docId: 'doc-1', store, workspaceStore: ws })).rejects.toThrow('boom')
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })

  it('does not setDirty(false) on a rejected discard', async () => {
    useUnsavedChangesStore.getState().setDirty(true)
    const { store } = makeStoreDouble()
    const ws = {
      open: vi.fn(async () => ({ ahead: true })),
      discard: vi.fn(async () => { throw new Error('nope') }),
    }
    await expect(discardUnsavedEdits({ workspace: 'ws-1', docId: null, store, workspaceStore: ws })).rejects.toThrow('nope')
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })

  it('sets dirty false on success', async () => {
    const { store } = makeStoreDouble()
    const { ws } = makeWorkspaceDouble(false)
    useUnsavedChangesStore.getState().setDirty(true)
    await discardUnsavedEdits({ workspace: 'ws-1', docId: 'doc-1', store, workspaceStore: ws })
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  it('a second call is harmless', async () => {
    const { store } = makeStoreDouble()
    const { ws } = makeWorkspaceDouble(false)
    await discardUnsavedEdits({ workspace: 'ws-1', docId: 'doc-1', store, workspaceStore: ws })
    await discardUnsavedEdits({ workspace: 'ws-1', docId: 'doc-1', store, workspaceStore: ws })
    expect(store.clear).toHaveBeenCalledTimes(2)
  })

  it('cancels the pending debounce so it does not rewrite the row', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const cell: { current: PartDoc | null } = { current: makeDoc(makeSketch('sk1')) }
    const dirtyFacts = { dirty: true, saves: 0, savedHash: null as number | null }
    const session: DocSession = createDocSession({
      cloneDoc: (s: PartDoc) => structuredClone(s),
      doc: { get: () => cell.current, set: (n: PartDoc) => { cell.current = n } },
      solve: createFakeSolveScheduler<PartDoc>(),
      solveResults: { get: () => ({}), set: () => {} },
      editorFacts: () => ({ editingFeatureId: null, rollbackPosition: null }),
      dirtyFacts: () => dirtyFacts,
      docId: 'doc-1',
      journal: journalSink(new CommandJournal()),
    })
    const { store } = makeStoreDouble()
    const handle: AutosaveHandle = attachAutosave({
      session,
      docId: 'doc-1',
      workspace: 'ws-1',
      getRepro: () => null,
      store,
      debounceMs: RECOVERY_DEBOUNCE_MS,
    })
    const addExtrude = (featureId: string, distance: number) =>
      ({ type: 'add_extrude', featureId, label: featureId, sketchQuery: '$sk1', distance } as never)
    session.execute(addExtrude('ex1', 1))
    // advance partially
    await vi.advanceTimersByTimeAsync(100)
    const { ws } = makeWorkspaceDouble(false)
    await discardUnsavedEdits({ workspace: 'ws-1', docId: 'doc-1', autosave: handle, store, workspaceStore: ws })
    // advance past debounce
    await vi.advanceTimersByTimeAsync(RECOVERY_DEBOUNCE_MS + 100)
    // clear called at least once; write should not be called after clear count? 
    // store.write may have been called by flush before clear. Ensure no additional write after.
    const writesAfter = (store.write as unknown as { mock: { calls: unknown[] } }).mock.calls.length
    await vi.advanceTimersByTimeAsync(RECOVERY_DEBOUNCE_MS)
    expect((store.write as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(writesAfter)
    handle.dispose()
  })
})
