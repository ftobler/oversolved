// The open-time restore offer: read the recovery journal for the document
// about to open and decide whether it holds edits the stored bytes do not. The
// editor is held back while the user answers, so the accepted snapshot can be
// handed to the loader (recovery/restore.ts) before it reads anything.
import { parse as parseYaml } from 'yaml'
import type { PartDoc } from '@/types/cad'
import {
  readRecoveryJournal,
  recoveryAhead,
  type RecoveryJournalRecord,
} from '@/recovery/journal'
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
  const record = await readRecoveryJournal(docId)
  if (!record) return null
  let stored: PartDoc | null = null
  try {
    stored = (parseYaml(storedText) ?? {}) as PartDoc
  } catch {
    return null
  }
  if (!recoveryAhead(stored, record)) return null
  let thumbnail: string | null = null
  try {
    thumbnail = (await getPreviewStore().get(workspace, docId)) ?? null
  } catch {
    // The thumbnail is decoration; a preview-store failure must not cost the
    // user their restore offer.
  }
  return { record, thumbnail }
}
