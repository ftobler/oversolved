import type { EntryMeta } from '@/workspace/types'

// The pure half of U2: grouping, open marking, reference inversion and the
// per-entry dirty derivation. No React and no carrier, so it unit-tests without
// a viewport, which is the project's stated frontend goal.
export interface GroupedEntries {
  parts: EntryMeta[]
  assemblies: EntryMeta[]
  otherDocs: EntryMeta[]
  files: EntryMeta[]
}

// Documents group by their open docKind, files by being files. An unknown
// docKind (a drawing, I6/I9) lands in otherDocs and is still listed rather than
// dropped: refusing to interpret is not permission to hide.
export function groupEntries(entries: EntryMeta[]): GroupedEntries {
  const grouped: GroupedEntries = { parts: [], assemblies: [], otherDocs: [], files: [] }
  for (const entry of entries) {
    if (entry.kind === 'file') {
      grouped.files.push(entry)
    } else if (entry.docKind === 'part') {
      grouped.parts.push(entry)
    } else if (entry.docKind === 'assembly') {
      grouped.assemblies.push(entry)
    } else {
      grouped.otherDocs.push(entry)
    }
  }
  return grouped
}

export function isOpenEntry(entry: EntryMeta, openId: string | undefined): boolean {
  return openId !== undefined && entry.id === openId
}

// Target id -> the ids that reference it. C4 inverts the outgoing edges itself;
// C5 replaces this body with its incoming index and the call site does not move.
export function invertReferences(edges: Record<string, string[]>): Map<string, string[]> {
  const inverse = new Map<string, string[]>()
  for (const [from, targets] of Object.entries(edges)) {
    for (const to of targets) {
      const sources = inverse.get(to)
      if (sources) sources.push(from)
      else inverse.set(to, [from])
    }
  }
  return inverse
}

// A file with no incoming edge. An entry is a source of an edge when its
// reference list is non-empty, which is the same signal where-used reads.
export function orphanFileIds(files: EntryMeta[], inverse: Map<string, string[]>): string[] {
  return files.filter(file => (inverse.get(file.id) ?? []).length === 0).map(file => file.id)
}

// Per-entry dirty (R3): an entry is ahead of its checkpoint when its working rev
// differs from the saved rev, or when it has no checkpoint row yet. The
// checkpoint is a pure read, so no new persistence is needed. Limitation: a rev
// compares revisions, not content, so a later write that returns the content to
// its checkpointed state still reads as changed. The dot is therefore honestly
// "changed since last save", never a claim that the content differs.
export function dirtyEntryIds(entries: EntryMeta[], savedRevs: Map<string, number>): Set<string> {
  const dirty = new Set<string>()
  for (const entry of entries) {
    if (savedRevs.get(entry.id) !== entry.rev) dirty.add(entry.id)
  }
  return dirty
}
