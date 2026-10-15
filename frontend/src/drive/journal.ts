// The mutation journal: a ring of doc-changing mutation applies recorded at the
// session seam, plus the baseline document the ring's first entry started from.
// Recovery (stores/recoveryStore.ts) owns the crash-at-restart prompt over the
// workspace rev pair; this journal owns mutation-level reproduction, so the two
// never share state: recovery asks "adopt or discard the working copy", the
// journal answers "here is the exact mutation sequence that produced this
// document".
//
// Recording at the session seam rather than at the command registry is what
// makes drawing and gestures visible (they dispatch mutations without a
// command) while the solver write-back stays out (it never goes through the
// session). The sink hashes the docs synchronously inside the apply, before
// any solve can write back, and replay hashes the same way, so both compare
// the authored state, never the baked one.
//
// A doc change no mutation can replay (undo/redo, a cancelled transaction)
// restarts the journal from the doc the user is left with, so what remains is
// always a contiguous, replayable suffix with a matching baseline; a repro is
// never a torn history that replay cannot verify. A document switch restarts
// it too: an entry names its docId and a mismatching record resets the ring, so
// a journal can never span two documents.

import type { SessionJournalChange, SessionJournalSink } from '@/session/DocSession'
import { docHashOf } from './docHash'

export const JOURNAL_CAPACITY = 500

export interface JournalEntry {
  kind: 'mutation' | 'batch'
  // The mutation, or the mutation group, with every id it embedded. A batch is
  // replayed through the session's group funnel so it applies in one clone.
  payload: SessionJournalChange['payload']
  // Human label (the first mutation's description); for the repro reader.
  label?: string
  docHashBefore: string
  docHashAfter: string
  // Epoch milliseconds; recorded for the repro reader, never for replay.
  at: number
}

/** The JSON payload a repro download (or the CLI) writes: baseline + journal. */
export interface ReproPayload {
  kind: 'oversolved-repro'
  version: 1
  // The hash of `doc`, so a reader can check the baseline before replaying.
  docHash: string
  doc: unknown
  journal: JournalEntry[]
}

/** A detached JSON-shaped copy; falls back through JSON when structuredClone
 *  refuses a value (a repro read back from disk is plain JSON either way). */
export function snapshotJson<T>(value: T): T {
  try {
    return structuredClone(value)
  } catch {
    try {
      return JSON.parse(JSON.stringify(value)) as T
    } catch {
      return value
    }
  }
}

export class CommandJournal {
  private readonly capacity: number
  private readonly clock: () => number
  private ring: JournalEntry[] = []
  private baselineDoc: unknown | null = null
  private currentDocId: string | null = null

  constructor(capacity: number = JOURNAL_CAPACITY, clock: () => number = Date.now) {
    this.capacity = Math.max(1, capacity)
    this.clock = clock
  }

  docId(): string | null {
    return this.currentDocId
  }

  /** Start a fresh generation for a document (load/switch). The baseline is
   *  captured lazily from the next recorded change's before-doc, so no write
   *  can slip between the reset and the first entry. */
  reset(docId: string | null = null): void {
    this.ring = []
    this.baselineDoc = null
    this.currentDocId = docId
  }

  /** Record one durable apply. `change.beforeDoc` and `change.afterDoc` are the
   *  docs as they stood around the apply; they are hashed here, synchronously,
   *  and the before-doc is cloned only when this entry starts a generation. */
  recordApplied(change: SessionJournalChange): void {
    if (change.docId !== this.currentDocId) this.reset(change.docId)
    const beforeHash = docHashOf(change.beforeDoc)
    const afterHash = docHashOf(change.afterDoc)
    if (beforeHash === afterHash) return
    if (this.ring.length >= this.capacity) {
      // The ring is full: drop the whole generation rather than the oldest
      // entry alone, because a suffix without its baseline cannot be replayed.
      this.ring = []
      this.baselineDoc = snapshotJson(change.beforeDoc)
    } else if (this.ring.length === 0) {
      this.baselineDoc = snapshotJson(change.beforeDoc)
    }
    this.ring.push(snapshotJson({
      kind: change.kind,
      payload: change.payload,
      ...(change.label ? { label: change.label } : {}),
      docHashBefore: beforeHash,
      docHashAfter: afterHash,
      at: this.clock(),
    }))
  }

  entries(): JournalEntry[] {
    return snapshotJson(this.ring)
  }

  size(): number {
    return this.ring.length
  }

  clear(): void {
    this.ring = []
    this.baselineDoc = null
  }

  // The replayable payload, or null while the journal holds nothing.
  repro(): ReproPayload | null {
    if (this.ring.length === 0 || this.baselineDoc === null) return null
    return {
      kind: 'oversolved-repro',
      version: 1,
      docHash: docHashOf(this.baselineDoc),
      doc: snapshotJson(this.baselineDoc),
      journal: this.entries(),
    }
  }
}

/** The DocSession-facing adapter: a sink that records into `journal` and
 *  restarts its generation on a rewind. */
export function journalSink(journal: CommandJournal): SessionJournalSink {
  return {
    onDocChange: change => journal.recordApplied(change),
    onDocReset: () => journal.clear(),
  }
}

let journal: CommandJournal | null = null

/** The module-level journal the part editor records into. Lazy so merely
 *  importing this module (a gated reference the production build folds away)
 *  never constructs the ring. */
export function getCommandJournal(): CommandJournal {
  if (!journal) journal = new CommandJournal()
  return journal
}

/** Test seam: drop the module journal so the next getter makes a fresh one. */
export function resetCommandJournal(): void {
  journal = null
}
