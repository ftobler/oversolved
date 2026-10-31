// The open-time restore offer: read the recovery journal for the document
// about to open and decide whether it holds edits the stored bytes do not. The
// editor is held back while the user answers, so the accepted snapshot can be
// handed to the loader (recovery/restore.ts) before it reads anything.
import { docLoadErrorMessage, loadPartDoc, loadPartDocText } from '@/persistence/docSchema'
import { recordCrashReport } from '@/recovery/crashReports'
import {
  readRecoveryJournal,
  recoveryAhead,
  type RecoveryJournalRecord,
} from '@/recovery/journal'
import { docHashOf } from '@/drive/docHash'
import { getPreviewStore } from '@/stores/previewStore'

export interface RecoveryOffer {
  record: RecoveryJournalRecord
  // The last rendered thumbnail for the entry, when one exists. Cosmetic: a
  // journal from a document that never solved offers without one.
  thumbnail: string | null
}

/**
 * The offer for one document, or null when the journal holds nothing ahead of
 * the stored text. A read failure returns null rather than throwing: the offer
 * is an opportunity to save work, never a gate that can block opening a
 * document, and an unreadable journal is exactly the state its hash re-check
 * would call "not ahead".
 */
export async function findRecoveryOffer(
  workspace: string,
  docId: string,
  storedText: string,
): Promise<RecoveryOffer | null> {
  let record: RecoveryJournalRecord | undefined
  try {
    record = await readRecoveryJournal(docId)
  } catch {
    // The documented contract, made real: a journal that cannot be read is
    // exactly the state the hash re-check below would call "not ahead".
    return null
  }
  if (!record) return null
  // The stored text crosses the same loader the open uses, so the comparison
  // runs against the document the editor would actually seat; text the loader
  // refuses is declined like unparseable text, never thrown.
  const stored = loadPartDocText(storedText, { name: docId })
  if (!stored.ok) return null
  if (!recoveryAhead(stored.doc, record)) return null
  // The snapshot is journal bytes from whatever build wrote them, so it crosses
  // the loader too: an old one is migrated, a refused one is declined and
  // logged. What the offer hands on is the loader's output, never the raw row.
  const snapshot = loadPartDoc(structuredClone(record.doc), { name: docId })
  if (!snapshot.ok) {
    void recordCrashReport({
      source: 'error',
      message: `recovery snapshot refused: ${docLoadErrorMessage(snapshot.error)}`,
      snapshot: null,
    })
    return null
  }
  record = { ...record, doc: snapshot.doc, docHash: docHashOf(snapshot.doc) }
  let thumbnail: string | null = null
  try {
    thumbnail = (await getPreviewStore().get(workspace, docId)) ?? null
  } catch {
    // The thumbnail is decoration; a preview-store failure must not cost the
    // user their restore offer.
  }
  return { record, thumbnail }
}
