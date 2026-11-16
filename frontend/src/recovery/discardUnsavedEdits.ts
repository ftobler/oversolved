// The one place an explicit Discard becomes durable: it clears the two stores
// that would otherwise re-offer the very edits the user just threw away (the
// recovery journal and the workspace working copy), and it cancels the editor's
// pending autosave so a debounced flush cannot rewrite the journal row after
// the clear. UI-free so it can be driven from a test with doubles.
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { getWorkspaceStore } from '@/workspace/store'
import { idbRecoveryJournal, type RecoveryJournalStore } from '@/recovery/journal'
import type { AutosaveHandle } from '@/recovery/autosave'

export interface DiscardUnsavedEditsOptions {
  workspace?: string | null
  docId?: string | null
  autosave?: AutosaveHandle | null
  handle?: AutosaveHandle | null
  autosaveHandle?: AutosaveHandle | null
  store?: RecoveryJournalStore
  journal?: RecoveryJournalStore
  journalStore?: RecoveryJournalStore
  recoveryJournalStore?: RecoveryJournalStore
  workspaceStore?: {
    open(workspace: string): Promise<{ ahead: boolean }>
    discard(workspace: string): Promise<void>
  }
}

export async function discardUnsavedEdits(
  optionsOrWorkspace?: DiscardUnsavedEditsOptions | string | null,
  docId?: string | null,
  autosave?: AutosaveHandle | null,
): Promise<void> {
  const options: DiscardUnsavedEditsOptions =
    typeof optionsOrWorkspace === 'string' ||
    optionsOrWorkspace === null ||
    optionsOrWorkspace === undefined
      ? { workspace: optionsOrWorkspace, docId: docId ?? null, autosave: autosave ?? null }
      : optionsOrWorkspace

  const workspace = options.workspace ?? null
  const resolvedDocId = options.docId ?? null
  const resolvedAutosave =
    options.autosave ?? options.handle ?? options.autosaveHandle ?? null
  const journalStore =
    options.store ??
    options.journal ??
    options.journalStore ??
    options.recoveryJournalStore ??
    idbRecoveryJournal
  const workspaceStore = options.workspaceStore ?? getWorkspaceStore()

  // 1. Let any in-flight journal write settle, then stop the editor from
  //    scheduling another one. Flushing first (rather than only cancelling the
  //    timer) closes the window where a write already started lands after the
  //    clear below.
  if (resolvedAutosave) {
    await resolvedAutosave.flush()
    resolvedAutosave.dispose()
  }

  // 2. Drop the shadow copy for a document editor. Assembly documents carry no
  //    journal (docId is null) and only do the workspace step.
  if (resolvedDocId) {
    await journalStore.clear(resolvedDocId)
  }

  // 3. Reset the working copy when it is ahead of its checkpoint, exactly what
  //    the U7 dialog's "Discard edits" does. Untouched when it is not ahead.
  if (workspace) {
    let opened: { ahead: boolean } | null = null
    try {
      opened = await workspaceStore.open(workspace)
    } catch {
      opened = null
    }
    if (opened?.ahead) {
      await workspaceStore.discard(workspace)
    }
  }

  // 4. The edits are gone; clear the dirty flag so the header stops warning.
  useUnsavedChangesStore.getState().setDirty(false)
}
