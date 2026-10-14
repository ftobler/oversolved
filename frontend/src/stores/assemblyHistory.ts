import { History, type HistoryEntry } from '@/session/History'
import { MAX_UNDO_DEPTH } from '@/config/undoConfig'
import type { AssemblyDoc } from '@/types/cad'
import type { AssemblyUndoLabel } from '@/utils/core/assemblyUndoLabels'

// The assembly editor's ONE undo/redo History. Module-level on purpose: the page
// can remount while a drag's pointer-up commit is still in flight (the store's
// endPartManipulation runs after the gesture's async solve), and that commit has
// to land in the same history the drag's pre-doc entry lives in. Component
// state would be torn down with the mount; only module or page-session lifetime
// survives it.
//
// `assemblyStore.undoStack`/`redoStack` are the read mirror the toolbar and the
// tree tooltips subscribe to. `publish` below is their only production writer,
// and every History mutation entry point republishes, so the mirror cannot
// drift from the engine.

type MirrorWriter = (undo: HistoryEntry<AssemblyDoc>[], redo: HistoryEntry<AssemblyDoc>[]) => void

let writeMirror: MirrorWriter | null = null

// Injected by assemblyStore right after its create(): a store import here would
// close a module cycle (assemblyStore already needs this module's singleton).
export function setAssemblyHistoryMirror(writer: MirrorWriter | null): void {
  writeMirror = writer
}

// A History subclass rather than free wrapper functions: every mutation entry
// point must republish the mirror, and an override cannot be forgotten at a
// call site the way a sibling publish call could.
class MirroredAssemblyHistory extends History<AssemblyDoc> {
  constructor() {
    // structuredClone matches the engine's old snapshot discipline: AssemblyDoc
    // holds no shared import payloads (the part doc's are why cloneDocForUndo
    // exists), so a full clone is the correct independent snapshot for both
    // pushed docs and the departing-doc counterparts History builds at move.
    super({ cloneDoc: structuredClone, cap: MAX_UNDO_DEPTH })
  }

  override push(label: AssemblyUndoLabel, doc: AssemblyDoc): void {
    super.push(label, doc)
    publish()
  }

  override pushSnapshot(label: AssemblyUndoLabel, doc: AssemblyDoc): void {
    super.pushSnapshot(label, doc)
    publish()
  }

  override undo(current: AssemblyDoc): HistoryEntry<AssemblyDoc> | null {
    const entry = super.undo(current)
    if (entry) publish()
    return entry
  }

  override redo(current: AssemblyDoc): HistoryEntry<AssemblyDoc> | null {
    const entry = super.redo(current)
    if (entry) publish()
    return entry
  }

  override clear(): void {
    super.clear()
    publish()
  }
}

export const assemblyHistory = new MirroredAssemblyHistory()

function publish(): void {
  // Copies of the lists, not the internal arrays: the mirror is for reading, and
  // History stays their only owner. The entry objects are shared snapshots that
  // nothing mutates.
  writeMirror?.([...assemblyHistory.undoEntries()], [...assemblyHistory.redoEntries()])
}
