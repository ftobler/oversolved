// The autosave: the editor's shadow copy of unsaved edits, flushed to the
// recovery journal debounced after every committed session change. It reads the
// DocSession directly (the live doc, the dirty decision, the event stream), so
// it works headless and a render can never feed it stale state; the session's
// replayable mutation tail is borrowed from the command journal rather than
// recorded a second time.
//
// A flush is fallible by doctrine: the write can reject on quota or a closed
// database, and when it does the error surfaces in the store below while the
// in-memory doc stays exactly where it is. The next debounce retries, so a
// transient rejection heals itself.
//
// The module-level registry is what the crash paths hold: the error boundary
// and the global handlers ask it to flush and to snapshot the live editor when
// a component tree is already coming down.
import { create } from 'zustand'
import type { PartDoc } from '@/types/cad'
import { docHashOf } from '@/drive/docHash'
import { snapshotJson, type ReproPayload } from '@/drive/journal'
import { errorMessage } from '@/utils/core/errorMessage'
import {
  idbRecoveryJournal,
  type RecoveryJournalRecord,
  type RecoveryJournalStore,
} from '@/recovery/journal'

export const RECOVERY_DEBOUNCE_MS = 2000

// The session surface the autosave reads. Structural, so the real DocSession
// satisfies it and the suites can drive a hand-built double.
export interface AutosaveSession {
  getDoc(): PartDoc | null
  isDirty(): boolean
  subscribe(listener: (event: unknown) => void): () => void
}

export type AutosaveStatus = 'idle' | 'saved' | 'error'

export interface AutosaveState {
  status: AutosaveStatus
  error: string | null
  lastSavedAt: number | null
}

// The UI-facing autosave state. A failed write is a banner, not a lost doc, so
// this store is deliberately small: status, the reason, and when it last
// landed.
export const useAutosaveStore = create<AutosaveState>(() => ({
  status: 'idle',
  error: null,
  lastSavedAt: null,
}))

export interface EditorSnapshot {
  docId: string | null
  workspace: string | null
  docName: string
  doc: PartDoc | null
  repro: ReproPayload | null
}

export interface AutosaveHandle {
  // Capture the session's state now and write the record, cancelling the
  // pending debounce.
  flush(): Promise<void>
  // The synchronous facts the crash paths and the document download read.
  snapshot(): EditorSnapshot
  dispose(): void
}

export interface AutosaveOptions {
  session: AutosaveSession
  docId: string | null
  workspace: string | null
  getRepro: () => ReproPayload | null
  getName?: () => string
  store?: RecoveryJournalStore
  debounceMs?: number
  now?: () => number
}

// The live editor's handle, registered by the page that mounted it. One app
// route shows one editor, so one slot is the whole registry.
let currentEditor: AutosaveHandle | null = null

export function registerRecoveryEditor(handle: AutosaveHandle | null): void {
  currentEditor = handle
}

/**
 * Flush the live editor's shadow copy from wherever a crash lands. The read
 * goes through the registered session, never a React snapshot, so a tree that
 * just threw cannot feed the journal a stale document.
 */
export function flushRecoveryEditor(): void {
  void currentEditor?.flush()
}

/** The live editor's facts, or null when no editor is mounted. */
export function recoveryEditorSnapshot(): EditorSnapshot | null {
  return currentEditor?.snapshot() ?? null
}

// Test seam: drop the registry so one suite's editor cannot leak into another.
export function resetRecoveryEditor(): void {
  currentEditor = null
}

export function attachAutosave(options: AutosaveOptions): AutosaveHandle {
  const { session, docId, workspace, getRepro } = options
  const store = options.store ?? idbRecoveryJournal
  const debounceMs = options.debounceMs ?? RECOVERY_DEBOUNCE_MS
  const now = options.now ?? Date.now
  const getName = options.getName ?? ((): string => '')

  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const cancelTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const captureRecord = (): RecoveryJournalRecord | null => {
    const doc = session.getDoc()
    if (!docId || !doc) return null
    return {
      docId,
      workspace,
      updatedAt: now(),
      docHash: docHashOf(doc),
      // Detached copies: the write is async, and the live doc reference stays
      // the session's to replace, never the record's to mutate.
      doc: snapshotJson(doc),
      repro: snapshotJson(getRepro()),
    }
  }

  const fail = (e: unknown): void => {
    useAutosaveStore.setState({
      status: 'error',
      error: errorMessage(e, 'Could not write the recovery journal'),
    })
  }

  const flush = async (): Promise<void> => {
    cancelTimer()
    if (disposed) return
    const record = captureRecord()
    if (!record) return
    if (!session.isDirty()) {
      // The doc is back at its stored content (an undo chain rewound it), so
      // the shadow copy is not ahead any more: drop it rather than leave a
      // false "unsaved changes" offer for the next open.
      try {
        await store.clear(record.docId)
        useAutosaveStore.setState({ status: 'idle', error: null })
      } catch (e) {
        fail(e)
      }
      return
    }
    try {
      await store.write(record)
      useAutosaveStore.setState({ status: 'saved', error: null, lastSavedAt: record.updatedAt })
    } catch (e) {
      // Report only: the in-memory doc is untouched and the next debounce
      // retries, so a transient rejection loses nothing.
      fail(e)
    }
  }

  const schedule = (): void => {
    if (disposed) return
    cancelTimer()
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, debounceMs)
  }

  useAutosaveStore.setState({ status: 'idle', error: null, lastSavedAt: null })
  const unsubscribe = session.subscribe(schedule)

  return {
    flush,
    snapshot: () => ({
      docId,
      workspace,
      docName: getName(),
      doc: session.getDoc(),
      repro: getRepro(),
    }),
    dispose: () => {
      disposed = true
      cancelTimer()
      unsubscribe()
    },
  }
}
