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
//
// Every generation carries the seed of the id source it minted under. The seed
// is drawn from crypto when the generation opens (so sessions differ) or is
// derived from the starting document for a drive operation (so a repeat agrees
// and a chained call does not); the source is installed over the yamlMutations
// default before the first handler runs, so handler-internal mints (add_rect,
// add_ngon, constraint ids) become a function of the seed and the source
// position. The repro carries the seed and each entry its start position, and
// replay installs and seeks, so a recorded generation reproduces
// byte-identically.

import type { PartDoc } from '@/types/cad'
import type { SessionJournalChange, SessionJournalSink } from '@/session/DocSession'
import { setIdSource } from '@/utils/yamlMutations'
import { docHashOf } from './docHash'
import { driveSeedFor, cryptoGenerationSeed, seededIdSource, type SeededIdSource } from './seededIds'

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
  // The generation id source's position when this apply started. Replay seeks
  // to it before applying, so handler-minted ids resume where the recording
  // left off even when the UI minted ids between applies.
  mintIndex: number
  // True when a solve was pending as this apply landed (the live doc was still
  // authored). Replay settles each step, so it may diverge at this entry; the
  // repro names such entries in `warnings`. Absent on a settled entry.
  unsettled?: true
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
  // The generation's id-source seed; replay installs it before applying.
  seed: number
  // One line per unsettled entry, naming its index and label/mutation type, so
  // a reader knows replay is not guaranteed before running it.
  warnings: string[]
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

// The human name of an entry: its label, or the mutation type when the entry
// carries none.
function entryName(entry: JournalEntry): string {
  if (entry.label) return entry.label
  const first = Array.isArray(entry.payload) ? entry.payload[0] : entry.payload
  return first?.type ?? 'unknown mutation'
}

export class CommandJournal {
  private readonly capacity: number
  private readonly clock: () => number
  private readonly seedSource: () => number
  private ring: JournalEntry[] = []
  private baselineDoc: unknown | null = null
  private currentDocId: string | null = null
  // The generation the ring belongs to. Null until the first generation opens.
  private generationSeed: number | null = null
  private generationSource: SeededIdSource | null = null
  // A full ring restarts with the incoming apply; its source is installed
  // before the handlers run (onBeforeApply) but the ring only drops when the
  // apply actually records, so a no-op never destroys the held suffix.
  private preparedSource: SeededIdSource | null = null
  // The source position captured before the handlers ran, consumed by the
  // matching recordApplied.
  private pendingMintIndex: number | null = null

  constructor(
    capacity: number = JOURNAL_CAPACITY,
    clock: () => number = Date.now,
    seedSource: () => number = cryptoGenerationSeed,
  ) {
    this.capacity = Math.max(1, capacity)
    this.clock = clock
    this.seedSource = seedSource
  }

  docId(): string | null {
    return this.currentDocId
  }

  /** Start a fresh generation for a document (load/switch): drop the ring and
   *  install a new id source under a new seed. The baseline is captured lazily
   *  from the next recorded change's before-doc, so no write can slip between
   *  the reset and the first entry. */
  reset(docId: string | null = null): void {
    this.ring = []
    this.baselineDoc = null
    this.currentDocId = docId
    this.openGeneration(this.seedSource())
  }

  /** Called synchronously before a mutation set runs. Opens a generation when
   *  none is live (or a full ring is about to restart) so the seed's source is
   *  installed before any handler mints, and notes the source position the
   *  entry will start from. */
  onBeforeApply(docId: string | null): void {
    if (docId !== this.currentDocId) {
      this.reset(docId)
      this.pendingMintIndex = this.generationSource?.index() ?? 0
      return
    }
    let source = this.generationSource ?? this.openGeneration(this.seedSource())
    if (this.ring.length >= this.capacity) {
      this.preparedSource = seededIdSource(this.seedSource())
      setIdSource(this.preparedSource)
      source = this.preparedSource
    }
    this.pendingMintIndex = source.index()
  }

  /** Record one durable apply. `change.beforeDoc` and `change.afterDoc` are the
   *  docs as they stood around the apply; they are hashed here, synchronously,
   *  and the before-doc is cloned only when this entry starts a generation. */
  recordApplied(change: SessionJournalChange): void {
    if (change.docId !== this.currentDocId) this.reset(change.docId)
    const generation = this.generationSource ?? this.openGeneration(this.seedSource())
    const beforeHash = docHashOf(change.beforeDoc)
    const afterHash = docHashOf(change.afterDoc)
    const mintIndex = this.pendingMintIndex ?? generation.index()
    this.pendingMintIndex = null
    if (beforeHash === afterHash) return
    if (this.ring.length >= this.capacity) {
      // The ring is full: drop the whole generation rather than the oldest
      // entry alone, because a suffix without its baseline cannot be replayed.
      this.ring = []
      this.baselineDoc = null
      if (this.preparedSource) {
        this.generationSource = this.preparedSource
        this.generationSeed = this.preparedSource.seed
        this.preparedSource = null
      } else {
        // Only a direct recordApplied (no onBeforeApply) lands here; the
        // handlers already ran, so a fresh seed cannot cover their mints.
        this.openGeneration(this.seedSource())
      }
    }
    if (this.ring.length === 0) this.baselineDoc = snapshotJson(change.beforeDoc)
    this.ring.push(snapshotJson({
      kind: change.kind,
      payload: change.payload,
      ...(change.label ? { label: change.label } : {}),
      docHashBefore: beforeHash,
      docHashAfter: afterHash,
      mintIndex,
      ...(change.unsettled && { unsettled: true as const }),
      at: this.clock(),
    }))
  }

  entries(): JournalEntry[] {
    return snapshotJson(this.ring)
  }

  size(): number {
    return this.ring.length
  }

  /** Drop the held suffix and open a fresh generation. Called on a rewind
   *  (undo/redo, a cancelled transaction), whose mutations cannot replay. */
  clear(): void {
    this.ring = []
    this.baselineDoc = null
    this.openGeneration(this.seedSource())
  }

  // The replayable payload, or null while the journal holds nothing.
  repro(): ReproPayload | null {
    if (this.ring.length === 0 || this.baselineDoc === null || this.generationSeed === null) return null
    return {
      kind: 'oversolved-repro',
      version: 1,
      docHash: docHashOf(this.baselineDoc),
      doc: snapshotJson(this.baselineDoc),
      seed: this.generationSeed,
      warnings: this.warnings(),
      journal: this.entries(),
    }
  }

  // The unsettled entries, named for the repro reader. A settled recording (the
  // CLI, any script run, any edit that waited for its solve) yields none.
  private warnings(): string[] {
    return this.ring.flatMap((entry, index) => entry.unsettled
      ? [`entry ${index} (${entryName(entry)}): applied while a solve was pending; replay settles each step and diverges at the first unsettled boundary`]
      : [])
  }

  private openGeneration(seed: number): SeededIdSource {
    const source = seededIdSource(seed)
    this.generationSeed = seed
    this.generationSource = source
    setIdSource(source)
    this.preparedSource = null
    this.pendingMintIndex = null
    return source
  }
}

/** The DocSession-facing adapter: a sink that records into `journal` and
 *  restarts its generation on a rewind. */
export function journalSink(journal: CommandJournal): SessionJournalSink {
  return {
    onBeforeApply: docId => journal.onBeforeApply(docId),
    onDocChange: change => journal.recordApplied(change),
    onDocReset: () => journal.clear(),
  }
}

/** The drive journal for one operation (the CLI run, one MCP `run` call): the
 *  generation seed is derived from the starting document's hash, so a repeat of
 *  the same document and script mints the same ids and builds byte-identical
 *  documents, while a call chained onto the previous reply starts from a
 *  different document and draws a different sequence. The seed still travels in
 *  the repro, so replay installs the same one. */
export function createDriveJournal(doc: PartDoc): CommandJournal {
  const seed = driveSeedFor(docHashOf(doc))
  return new CommandJournal(JOURNAL_CAPACITY, Date.now, () => seed)
}

let journal: CommandJournal | null = null

/** The module-level journal the part editor records into in every build (the
 *  recovery autosave borrows its repro tail), so merely importing this module
 *  stays cheap: the ring is constructed lazily on the first getter call. */
export function getCommandJournal(): CommandJournal {
  if (!journal) journal = new CommandJournal()
  return journal
}

/** Test seam: drop the module journal so the next getter makes a fresh one. */
export function resetCommandJournal(): void {
  journal = null
}
