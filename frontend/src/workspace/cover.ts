import type { WorkspaceEntryMetaRecord } from './idbCarrier'

// Which entry's preview stands for the workspace on the library tile and the
// identity card. The user can store a choice (the meta row's `cover`, carried in
// the manifest); without one the answer is automatic, so a workspace still has a
// cover before anyone picks one.
//
// `live` is the workspace's not-trashed rows: the resolver never reads the trash
// itself, which is what makes a trashed choice fall away automatically.
export interface CoverChoice {
  cover?: string
}

// The automatic preference, most wanted first. An assembly is the thing a
// workspace usually is, a part is the thing inside it, and anything else is a
// last resort.
const COVER_RANK: Readonly<Record<string, number>> = { assembly: 0, part: 1 }
const OTHER_DOCUMENT_RANK = 2

function rankOf(record: WorkspaceEntryMetaRecord): number {
  return COVER_RANK[record.docKind ?? ''] ?? OTHER_DOCUMENT_RANK
}

export function resolveCoverEntry(choice: CoverChoice, live: WorkspaceEntryMetaRecord[]): string | undefined {
  if (choice.cover !== undefined) {
    const chosen = live.find(record => record.id === choice.cover)
    // A file has no preview (A9 keying is by document), so an explicit file id
    // is not a cover even if something wrote one.
    if (chosen !== undefined && chosen.kind === 'document') return chosen.id
  }
  let best: WorkspaceEntryMetaRecord | undefined
  for (const record of live) {
    if (record.kind !== 'document') continue
    if (best === undefined || preferred(record, best)) best = record
  }
  return best?.id
}

function preferred(candidate: WorkspaceEntryMetaRecord, current: WorkspaceEntryMetaRecord): boolean {
  const rank = rankOf(candidate)
  const currentRank = rankOf(current)
  if (rank !== currentRank) return rank < currentRank
  if (candidate.updatedAt !== current.updatedAt) return candidate.updatedAt > current.updatedAt
  // Two rows edited in the same millisecond must not make the answer depend on
  // the order IndexedDB read them in, so the lowest id wins: the same document
  // the old first-document rule picked.
  return candidate.id < current.id
}
