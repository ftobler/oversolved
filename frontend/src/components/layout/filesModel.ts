import type { EntryMeta } from '@/workspace/types'
import { invertReferences, orphanFileIds } from './workspaceTreeModel'

// The pure half of U3. The where-used inversion is shared with the tree (C5
// replaces that body once), and the rest is display precedence: the kind label
// and the size a file row reads itself by. The origin lookup that used to sit
// here went with R5: the view indexes the provenance once into a map rather
// than scanning the list again for every row.
export { invertReferences, orphanFileIds }

// The C1 file classification wins over the wire mime, so a STEP reads as 'step'
// rather than 'application/step'; a file with neither falls back to 'file'.
export function fileKindOf(entry: EntryMeta): string {
  return entry.fileKind ?? entry.mime ?? 'file'
}

export function fileSizeOf(entry: EntryMeta): number {
  return entry.size ?? 0
}

export function referrersOf(inverse: Map<string, string[]>, entryId: string): string[] {
  return inverse.get(entryId) ?? []
}
