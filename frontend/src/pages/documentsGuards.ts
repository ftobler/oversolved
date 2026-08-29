import type { DocSummary } from '@/stores/documentStore'

// PS-L3: the cloud duplicate endpoint is owner-gated, so the button must not be
// offered on a cloud tile the server will reject. Local documents are device-owned,
// so duplication is always available there.
export function canDuplicateDocument(doc: DocSummary, onCloud: boolean): boolean {
  return !onCloud || !!doc.is_owner
}
