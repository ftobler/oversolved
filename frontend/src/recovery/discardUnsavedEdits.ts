// The one place an explicit Discard becomes durable: it clears the two stores
// that would otherwise re-offer the very edits the user just threw away (the
// recovery journal and the workspace working copy), and it cancels the editor's
// pending autosave so a debounced flush cannot rewrite the journal row after
// the clear. UI-free so it can be driven from a test with doubles.
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'

import { idbRecoveryJournal, type RecoveryJournalStore } from '@/recovery/journal'
import type { AutosaveHandle } from '@/recovery/autosave'

export interface DiscardUnsavedEditsOptions {
  workspace?: string | null
  docId?: string | null
  autosave?: AutosaveHandle | null
  store?: RecoveryJournalStore
}

export async function discardUnsavedEdits(
  options: DiscardUnsavedEditsOptions,
): Promise<void> {
  const resolvedDocId = options.docId ?? null
  const resolvedAutosave = options.autosave ?? null
  const journalStore = options.store ?? idbRecoveryJournal

  // 1. Let any in-flight journal write settle, cancelling the pending debounce
  //    so it cannot rewrite the row after the clear below.
  if (resolvedAutosave) {
    await resolvedAutosave.flush()
  }

  // 2. Drop the shadow copy for a document editor. Assembly documents carry no
  //    journal (docId is null). The editor's autosave is disposed only after
  //    this succeeds, so a failed clear leaves recovery running.
  if (resolvedDocId) {
    await journalStore.clear(resolvedDocId)
  }

  // 3. The working copy is workspace-wide; clearing it from an in-workspace
  //    navigation would wipe edits that the navigation never left behind, so
  //    the header's Discard only clears the open document's journal. The
  //    workspace-level U7 dialog remains the path that resets the working copy.

  if (resolvedAutosave) {
    resolvedAutosave.dispose()
  }

  useUnsavedChangesStore.getState().setDirty(false)
}
