// The command journal: a ring of doc-changing commands recorded at the
// registry execution seam, plus the baseline document the ring's first command
// started from. Recovery (stores/recoveryStore.ts) owns the crash-at-restart
// prompt over the workspace rev pair; this journal owns command-level
// reproduction, so the two never share state: recovery asks "adopt or discard
// the working copy", the journal answers "here is the exact command sequence
// that produced this document".
//
// Only commands whose execution changed the document hash are recorded, so a
// solver write-back (not a command), a selection change or a UI-only command
// leaves no entry. When the ring fills, it restarts as a new generation with
// the incoming command as its first entry, so what remains is always a
// contiguous, replayable suffix with a matching baseline; a repro is never a
// torn history that replay cannot verify.

import { docHashOf } from './docHash'

export const JOURNAL_CAPACITY = 500

export interface JournalEntry {
  commandId: string
  // The raw params the command was called with; null for no-params commands.
  params: unknown
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
  private ring: JournalEntry[] = []
  private baselineDoc: unknown | null = null

  constructor(capacity: number = JOURNAL_CAPACITY) {
    this.capacity = Math.max(1, capacity)
  }

  /**
   * Record one command. `beforeDoc` is the document as it stood before the
   * command ran; it is captured (and cloned) only when this entry starts a
   * generation, so a steady-state record costs one clone per command, not one
   * per entry.
   */
  record(entry: JournalEntry, beforeDoc?: unknown): void {
    if (this.ring.length >= this.capacity) {
      // The ring is full: drop the whole generation rather than the oldest
      // entry alone, because a suffix without its baseline cannot be replayed.
      this.ring = []
      this.baselineDoc = beforeDoc === undefined ? null : snapshotJson(beforeDoc)
    } else if (this.ring.length === 0) {
      this.baselineDoc = beforeDoc === undefined ? null : snapshotJson(beforeDoc)
    }
    this.ring.push(snapshotJson(entry))
  }

  entries(): JournalEntry[] {
    return snapshotJson(this.ring)
  }

  size(): number {
    return this.ring.length
  }

  // Whether the next record starts a generation and needs a before-doc.
  needsBaseline(): boolean {
    return this.ring.length === 0 || this.ring.length >= this.capacity
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

let journal = new CommandJournal()

/** The module-level journal the part editor records into. */
export function getCommandJournal(): CommandJournal {
  return journal
}

/** Test seam: replace the module journal with a fresh one. */
export function resetCommandJournal(): void {
  journal = new CommandJournal()
}
