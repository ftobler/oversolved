// Moving a document to another workspace, decided without touching storage.
// References are uuid to uuid and live inside one workspace, so a move has to
// take along everything the entry needs (an assembly's parts, every STEP file
// they import) and must never strand an entry that needs it. The plan answers
// both from the two workspaces' rows and the source's edge map; the store then
// performs it in one transaction.
import type { EntryKind, ReferenceEdges } from './types'

export interface MoveGraphEntry {
  id: string
  name: string
  kind: EntryKind
  // The payload hash: a target file with the same id AND the same bytes is the
  // same file (an earlier move copied it), so it is reused instead of refused.
  contentHash?: string
}

export interface MoveSourceGraph {
  entries: readonly MoveGraphEntry[]  // every row, trashed ones included
  trash: readonly string[]
  references: ReferenceEdges
  // The edges at the last save, which a Discard would bring back.
  savedReferences?: ReferenceEdges
}

export interface MoveTargetGraph {
  name: string
  entries: readonly MoveGraphEntry[]  // every row, trashed ones included
  trash: readonly string[]
}

export interface EntryMovePlan {
  ok: true
  entry: string
  // Rows that leave the source: the entry first, then the rest by name.
  move: string[]
  // Rows the target receives under the same id while the source keeps its own,
  // because a source entry outside the move still uses them.
  copy: string[]
  // The file ids among move and copy, so the report can tell bytes from documents.
  files: string[]
  // Files the target already holds byte-identically: not written again.
  present: string[]
  // copy id -> the names of the source entries outside the move that use it.
  sharedWith: Record<string, string[]>
}

export interface EntryMoveRefusal {
  ok: false
  refused: string
}

export type EntryMovePlanResult = EntryMovePlan | EntryMoveRefusal

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

// The closure is the entry plus everything it references, transitively, so a
// nested assembly brings its own parts and files. Trashed and missing targets
// are left out: the source could not resolve them either, and a move must not
// resurrect a trashed row as a live one in the target.
export function planEntryMove(source: MoveSourceGraph, entry: string, target: MoveTargetGraph): EntryMovePlanResult {
  const byId = new Map(source.entries.map(row => [row.id, row]))
  const trashed = new Set(source.trash)
  const isLive = (id: string): boolean => byId.has(id) && !trashed.has(id)
  const nameOf = (id: string): string => byId.get(id)?.name ?? id

  const root = byId.get(entry)
  if (root === undefined || trashed.has(entry)) {
    return { ok: false, refused: 'That entry is no longer in this workspace.' }
  }
  if (root.kind === 'file') {
    return { ok: false, refused: `${root.name} is a file; files move with the documents that use them.` }
  }

  // Live referrers refuse the root, like the delete guard: a referrer in the
  // trash keeps its edge, but it is not live, so it cannot hold the move back.
  const referrers = new Map<string, string[]>()
  // Every source entry that could still need a member, which decides move
  // versus copy: a trashed one (restore would find the member gone, and a move,
  // unlike a delete, leaves no trash copy to restore with it) and one that used
  // it at the last save (Discard would bring that edge back).
  const holders = new Map<string, Set<string>>()
  const note = (map: Map<string, string[]> | null, from: string, to: string): void => {
    if (to === from) return
    if (map) {
      const list = map.get(to)
      if (list) list.push(from)
      else map.set(to, [from])
    }
    const set = holders.get(to)
    if (set) set.add(from)
    else holders.set(to, new Set([from]))
  }
  for (const [from, targets] of Object.entries(source.references)) {
    if (!byId.has(from)) continue
    for (const to of targets) note(isLive(from) ? referrers : null, from, to)
  }
  for (const [from, targets] of Object.entries(source.savedReferences ?? {})) {
    if (!byId.has(from)) continue
    for (const to of targets) note(null, from, to)
  }
  const byName = (a: string, b: string): number => nameOf(a).localeCompare(nameOf(b)) || (a < b ? -1 : a > b ? 1 : 0)

  const users = (referrers.get(entry) ?? []).slice().sort(byName).map(nameOf)
  if (users.length > 0) {
    const list = joinNames(users)
    const instead = users.length === 1 ? `move ${list} instead` : 'move one of those instead'
    return {
      ok: false,
      refused: `${root.name} is used by ${list}; ${instead}, or remove it from ${users.length === 1 ? list : 'them'} first.`,
    }
  }

  const closure = new Set<string>([entry])
  const queue = [entry]
  while (queue.length > 0) {
    const from = queue.shift() as string
    for (const to of source.references[from] ?? []) {
      if (closure.has(to) || !isLive(to)) continue
      closure.add(to)
      queue.push(to)
    }
  }

  // A member another source entry still uses has to stay; it travels as a copy.
  // Demoting one can strand its own children (it now uses them from outside the
  // move), so this runs to a fixpoint.
  const moved = new Set(closure)
  let changed = true
  while (changed) {
    changed = false
    for (const id of [...moved]) {
      if (id === entry) continue
      if ([...(holders.get(id) ?? [])].some(from => !moved.has(from))) {
        moved.delete(id)
        changed = true
      }
    }
  }

  const targetById = new Map(target.entries.map(row => [row.id, row]))
  const targetTrash = new Set(target.trash)
  const present: string[] = []
  for (const id of [...closure].sort(byName)) {
    const existing = targetById.get(id)
    if (existing === undefined) continue
    const mine = byId.get(id) as MoveGraphEntry
    const sameFile = mine.kind === 'file' && existing.kind === 'file' && !targetTrash.has(id) &&
      mine.contentHash !== undefined && mine.contentHash === existing.contentHash
    if (sameFile) {
      present.push(id)
      continue
    }
    // The same id is the same entry's earlier copy, possibly renamed since, so
    // the refusal names both when they differ. Replacing it is a later option.
    const where = targetTrash.has(id) ? ' in its trash' : ''
    const held = existing.name === mine.name ? mine.name : `${existing.name} (an earlier copy of ${mine.name})`
    return { ok: false, refused: `${target.name} already has ${held}${where}; delete it there first.` }
  }

  const rest = (ids: Iterable<string>): string[] => [...ids].filter(id => id !== entry).sort(byName)
  const move = [entry, ...rest(moved)]
  const copy = rest([...closure].filter(id => !moved.has(id)))
  const sharedWith: Record<string, string[]> = {}
  for (const id of copy) {
    sharedWith[id] = [...(holders.get(id) ?? [])].filter(from => !moved.has(from)).sort(byName)
      .map(from => (isLive(from) ? nameOf(from) : `${nameOf(from)} (in the trash)`))
  }
  const files = [...move, ...copy].filter(id => byId.get(id)?.kind === 'file')
  return { ok: true, entry, move, copy, files, present, sharedWith }
}

// Whether two plans carry the same rows the same way.
export function sameMovePlan(a: EntryMovePlan, b: EntryMovePlan): boolean {
  const same = (x: readonly string[], y: readonly string[]) => x.length === y.length && x.every((id, i) => id === y[i])
  return a.entry === b.entry && same(a.move, b.move) && same(a.copy, b.copy) && same(a.present, b.present)
}

export interface EntryMoveReportRow {
  id: string
  name: string
  kind: EntryKind
}

// What a finished move did, for the notice it leaves.
export interface EntryMoveReport {
  target: string  // the target workspace's name
  moved: EntryMoveReportRow[]  // the entry first
  copied: EntryMoveReportRow[]
}

// The notice a finished move leaves: documents by name, files by count, since
// the STEP files are part of the documents that import them.
export function entryMoveReportText(report: EntryMoveReport): string {
  const docs = (rows: EntryMoveReportRow[]) => rows.filter(row => row.kind === 'document').map(row => row.name)
  const [entry, ...withDocs] = docs(report.moved)
  const copied = docs(report.copied)
  const files = [...report.moved, ...report.copied].filter(row => row.kind === 'file').length
  const parts = [`Moved ${entry ?? 'the entry'}${withDocs.length > 0 ? ` with ${joinNames(withDocs)}` : ''} to ${report.target}.`]
  if (copied.length > 0) {
    const one = copied.length === 1
    parts.push(`${joinNames(copied)} ${one ? 'is' : 'are'} still used here, so ${one ? 'it was' : 'they were'} copied.`)
  }
  if (files > 0) parts.push(`${files} ${files === 1 ? 'file' : 'files'} went along.`)
  return parts.join(' ')
}

// The confirm step's sentence, or null when the entry travels alone (its own
// STEP files go with it silently: they are part of the document, not a choice).
export function describeEntryMove(plan: EntryMovePlan, nameOf: (id: string) => string): string | null {
  const fileIds = new Set(plan.files)
  const extra = [...plan.move.slice(1), ...plan.copy].filter(id => !fileIds.has(id))
  if (extra.length === 0) return null
  const copied = plan.copy.filter(id => !fileIds.has(id))
  const notes = copied.map(id => `${nameOf(id)} is also used by ${joinNames(plan.sharedWith[id] ?? [])} and is copied`)
  const tail = notes.length > 0 ? ` (${notes.join('; ')})` : ''
  return `Move ${nameOf(plan.entry)} with ${joinNames(extra.map(nameOf))}${tail}.`
}
