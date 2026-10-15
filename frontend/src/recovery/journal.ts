// The recovery journal: the autosave's shadow copy of a document's unsaved
// edits, one row per document uuid in its own IndexedDB store. It is written
// debounced after each committed mutation and cleared by an explicit save, and
// the open path compares it against the stored document to offer a restore.
//
// It sits beside the workspace rather than in it so a journal write can never
// touch the working copy: the worst a lost or rejected journal write costs is
// the debounce window, while the working copy is the store the save path owns.
//
// The record carries the session's replayable mutation tail (`repro`) at flush
// time alongside the live snapshot. The snapshot is what a restore hands back;
// the tail is what a crash report borrows so its repro replays, and the tail
// never spans documents because the command journal restarts per docId.
import type { PartDoc } from '@/types/cad'
import { docHashOf } from '@/drive/docHash'
import type { ReproPayload } from '@/drive/journal'
import {
  STORE_RECOVERY_JOURNAL,
  idbDeleteFrom,
  idbGetFrom,
  idbPutTo,
} from '@/stores/documentStore/idb'

export interface RecoveryJournalRecord {
  docId: string
  // The workspace the document was open in, for the crash report and a future
  // cleanup by workspace. Never used to address storage.
  workspace: string | null
  updatedAt: number
  // docHashOf(doc), so the open path can tell an ahead journal from a stale
  // one without trusting timestamps across clock changes.
  docHash: string
  doc: PartDoc
  repro: ReproPayload | null
}

// The storage face of the journal, injectable so the autosave can be driven
// against a failing writer (quota, a closed database) in a test.
export interface RecoveryJournalStore {
  read(docId: string): Promise<RecoveryJournalRecord | undefined>
  write(record: RecoveryJournalRecord): Promise<void>
  clear(docId: string): Promise<void>
}

// A platform with no IndexedDB at all (a bare test environment) has nowhere to
// journal: the calls read as no-ops rather than reject, so the save path does
// not log a bogus failure for a document layer that already cannot work there.
const hasIndexedDb = (): boolean => typeof indexedDB !== 'undefined'

export const idbRecoveryJournal: RecoveryJournalStore = {
  read: docId => hasIndexedDb()
    ? idbGetFrom<RecoveryJournalRecord>(STORE_RECOVERY_JOURNAL, docId)
    : Promise.resolve(undefined),
  write: record => hasIndexedDb()
    ? idbPutTo(STORE_RECOVERY_JOURNAL, record)
    : Promise.resolve(),
  clear: docId => hasIndexedDb()
    ? idbDeleteFrom(STORE_RECOVERY_JOURNAL, docId)
    : Promise.resolve(),
}

export function readRecoveryJournal(docId: string): Promise<RecoveryJournalRecord | undefined> {
  return idbRecoveryJournal.read(docId)
}

// Clear the shadow copy after an explicit save stored the same content. A clear
// that fails is not fatal: the open path also compares hashes, so a surviving
// record that matches the stored bytes is never offered as unsaved edits.
export async function clearRecoveryJournal(docId: string): Promise<void> {
  await idbRecoveryJournal.clear(docId)
}

/**
 * Whether the record holds content the stored document does not. The hash
 * comparison is the authoritative check rather than `updatedAt`: the journal is
 * cleared on save best-effort, and a clear that failed must not make an
 * already-stored document offer "unsaved changes" at the next open.
 */
export function recoveryAhead(storedDoc: PartDoc | null, record: RecoveryJournalRecord): boolean {
  return storedDoc !== null && docHashOf(storedDoc) !== record.docHash
}
