import type { EntryMeta, ProvenanceRecord } from '@/workspace/types'
import { invertReferences, orphanFileIds } from './workspaceTreeModel'

// The pure half of U3. The where-used inversion is shared with the tree (C5
// replaces that body once), and the rest is display precedence: a kind label
// and the origin lookup from the manifest's provenance records.
export { invertReferences, orphanFileIds }

// The C1 file classification wins over the wire mime, so a STEP reads as 'step'
// rather than 'application/step'; a file with neither falls back to 'file'.
export function fileKindOf(entry: EntryMeta): string {
  return entry.fileKind ?? entry.mime ?? 'file'
}

export function fileSizeOf(entry: EntryMeta): number {
  return entry.size ?? 0
}

// The provenance record a local entry was imported as. The manifest carries it
// already; C6 fills rev, hash and status into the same record.
export function originFor(provenance: ProvenanceRecord[], entryId: string): ProvenanceRecord | undefined {
  return provenance.find(record => record.entry === entryId)
}

export function referrersOf(inverse: Map<string, string[]>, entryId: string): string[] {
  return inverse.get(entryId) ?? []
}
