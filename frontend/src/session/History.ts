import { pushCapped, moveTop } from '@/utils/core/undoStack'

// One entry of the undo/redo history: the label the UI shows, the doc snapshot
// undo or redo restores, and an optional caller payload (the DocSession stores
// the mutation behind the label so the toolbar can render it). A label rather
// than a Mutation alone, so a caller can store a collapsed aggregate ("edit f1")
// exactly like a single dispatch.
export interface HistoryEntry<Doc, Meta = unknown> {
  label: string
  doc: Doc
  meta?: Meta
}

export interface HistoryOptions<Doc> {
  // Entry snapshots and the departing-doc counterparts both go through this, so
  // the freeze's clone semantics live in one place and part and assembly can
  // differ until one-history lands.
  cloneDoc: (doc: Doc) => Doc
  cap: number
}

// The pure undo/redo machine, built on utils/core/undoStack. It owns the two
// stacks and the one pre-session snapshot slot, never the live document:
// callers pass the departing doc into undo/redo exactly as the hook engine did,
// and receive the entry whose doc is now the live one.
export class History<Doc, Meta = unknown> {
  private undoStack: HistoryEntry<Doc, Meta>[] = []
  private redoStack: HistoryEntry<Doc, Meta>[] = []
  private snapshot: { undo: HistoryEntry<Doc, Meta>[]; redo: HistoryEntry<Doc, Meta>[] } | null = null
  private readonly cloneDoc: (doc: Doc) => Doc
  private readonly cap: number

  constructor(options: HistoryOptions<Doc>) {
    this.cloneDoc = options.cloneDoc
    this.cap = options.cap
  }

  undoLabels(): string[] {
    return this.undoStack.map(entry => entry.label)
  }

  redoLabels(): string[] {
    return this.redoStack.map(entry => entry.label)
  }

  undoLength(): number {
    return this.undoStack.length
  }

  redoLength(): number {
    return this.redoStack.length
  }

  // Read-only views for a caller that mirrors the stacks (the toolbar). Do not
  // mutate the returned arrays; the history is their only owner.
  undoEntries(): readonly HistoryEntry<Doc, Meta>[] {
    return this.undoStack
  }

  redoEntries(): readonly HistoryEntry<Doc, Meta>[] {
    return this.redoStack
  }

  push(label: string, doc: Doc, meta?: Meta): void {
    this.pushEntry({ label, doc: this.cloneDoc(doc), meta })
  }

  // For callers that already hold an independent snapshot (a preview or session
  // baseline): cloning it again would only copy a throwaway. The caller
  // guarantees it will not be mutated afterwards; a live doc still belongs to push.
  pushSnapshot(label: string, doc: Doc, meta?: Meta): void {
    this.pushEntry({ label, doc, meta })
  }

  undo(current: Doc): HistoryEntry<Doc, Meta> | null {
    return this.move('undo', current)
  }

  redo(current: Doc): HistoryEntry<Doc, Meta> | null {
    return this.move('redo', current)
  }

  saveSnapshot(): void {
    this.snapshot = { undo: [...this.undoStack], redo: [...this.redoStack] }
  }

  // PAIRING CONTRACT: the caller must have rewound the live doc to the snapshot
  // BEFORE calling, because the stacks only describe that doc again once the
  // live doc IS it. This restores the stacks and nothing else.
  restoreSnapshot(): boolean {
    if (!this.snapshot) return false
    this.undoStack = this.snapshot.undo
    this.redoStack = this.snapshot.redo
    this.snapshot = null
    return true
  }

  clearSnapshot(): void {
    this.snapshot = null
  }

  clear(): void {
    this.undoStack = []
    this.redoStack = []
    this.snapshot = null
  }

  private pushEntry(entry: HistoryEntry<Doc, Meta>): void {
    this.undoStack = pushCapped(this.undoStack, entry, this.cap)
    // A fresh edit invalidates any redo branch.
    this.redoStack = []
  }

  private move(direction: 'undo' | 'redo', current: Doc): HistoryEntry<Doc, Meta> | null {
    const from = direction === 'undo' ? this.undoStack : this.redoStack
    const to = direction === 'undo' ? this.redoStack : this.undoStack
    if (from.length === 0) return null
    const entry = from[from.length - 1]
    // The counterpart carries the entry's label and meta plus a clone of the doc
    // being left behind, so the same step round-trips in both directions.
    const move = moveTop(from, to, top => ({ label: top.label, doc: this.cloneDoc(current), meta: top.meta }))
    if (!move) return null
    if (direction === 'undo') {
      this.undoStack = move.from
      this.redoStack = move.to
    } else {
      this.redoStack = move.from
      this.undoStack = move.to
    }
    // A move invalidates the pre-session restore point: the stacks it parked no
    // longer describe the live doc.
    this.snapshot = null
    return entry
  }
}
