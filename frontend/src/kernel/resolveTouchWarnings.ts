// Post-solve cleanup of the "the new solid also touches <ids>; add a boolean
// union to fuse it" warning. That warning describes bodies that were still
// separate when the additive feature ran; a later union can fuse them into one
// live body, after which the warning names a problem that no longer exists. The
// drive's problem list and every assembly summary built from the part would
// keep reporting it forever.
//
// The pass runs on the final solve, so it sees the whole stack. It walks the
// per-feature checkpoints to learn which live body each consumed body became
// part of, then resolves every touched name against the feature's own receiving
// body. A touched body that now belongs to the receiving body drops out; if none
// remain the warning moves to `resolved_warning` (runtime only, never a problem);
// otherwise the text is rewritten to name only the bodies still apart.

import type { Body } from './types3d'

type ResultRow = {
  [key: string]: unknown
  status?: unknown
}

/** The builder's per-feature result dict, read here only as untyped rows. */
type ResultRows = {
  [id: string]: unknown
}

/** The touch warning's fixed markers. It is emitted last and carries its own
 *  `; `, so the list of warnings cannot be split on that separator; locate the
 *  one warning by its shape instead. */
const MARKER = ': the new solid also touches '
const TAIL = '; add a boolean union to fuse it'

// A consumed body that no later live body absorbed (deleted or cut away). A
// split keeps the parent's id, so it never lands here.
const GONE = '\u0000gone'

interface CheckpointView {
  result: ResultRow
  body_store_snapshot: Record<string, Body>
}

/** The body a feature row says it built or changed, when it says so. */
function receivingBodyId(row: ResultRow | undefined): string | null {
  if (row === undefined) return null
  if (typeof row.body_id === 'string' && row.body_id !== '') return row.body_id
  const ids = row.body_ids
  if (Array.isArray(ids) && typeof ids[0] === 'string' && ids[0] !== '') return ids[0]
  return null
}

function asRow(value: unknown): ResultRow | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as ResultRow : undefined
}

interface TouchSegment {
  // Offset of the warning's own text within `solver_warning`, past any `; `.
  start: number
  end: number
  // The emitter's prefix, the feature kind ("extrude").
  head: string
  // The comma-joined body ids the warning names.
  names: string
}

/** The touch warning inside `warning` as absolute offsets, or null. */
function findTouch(warning: string): TouchSegment | null {
  const at = warning.lastIndexOf(MARKER)
  if (at < 0) return null
  const tailAt = warning.indexOf(TAIL, at)
  if (tailAt < 0) return null
  const separator = warning.lastIndexOf('; ', at)
  const start = separator < 0 ? 0 : separator + 2
  return { start, end: tailAt + TAIL.length, head: warning.slice(start, at), names: warning.slice(at + MARKER.length, tailAt) }
}

/**
 * A resolver from any body id to the live body it ended up in (or GONE).
 *
 * A body disappeared from the store between one checkpoint and the next, so the
 * feature that owned that boundary consumed it. Only a `union`/`add` that
 * produced ONE solid took it INTO the receiving body; any other operation (a
 * cut's tool, a delete) removed it without fusing it, and a warning that still
 * named it describes a body that is simply no longer separate. A union that
 * split into siblings is left unmapped on purpose: its material is still a
 * separate body, so the warning must stay. Following the chain at resolve time
 * covers a body consumed more than once.
 */
function mergeLineage(
  featureOrder: readonly string[],
  checkpoints: Record<string, CheckpointView>,
  result: ResultRows,
): (id: string) => string {
  const merged = new Map<string, string>()
  let live = new Set<string>()
  for (const fid of featureOrder) {
    const checkpoint = checkpoints[fid]
    if (checkpoint === undefined) continue
    const next = new Set(Object.keys(checkpoint.body_store_snapshot ?? {}))
    const row = asRow(result[fid])
    const survivor = receivingBodyId(row)
    const operation = typeof row?.operation === 'string' ? row.operation : ''
    const fusion = operation === 'union' || operation === 'add'
    // A union that left a multi-solid compound splits into siblings instead of
    // fusing; its consumed material is still a separate body, so resolving it
    // away would silence a real problem. Only a single-survivor result proves a
    // real fusion.
    const produced = Array.isArray(row?.body_ids) ? row.body_ids : []
    const fusedIntoOne = fusion && produced.length <= 1
    for (const id of live) {
      if (next.has(id)) continue
      if (fusion) {
        if (fusedIntoOne && survivor !== null) merged.set(id, survivor)
      } else {
        merged.set(id, GONE)
      }
    }
    live = next
  }
  return (id: string): string => {
    let current = id
    const seen = new Set<string>()
    while (merged.has(current) && !seen.has(current)) {
      seen.add(current)
      current = merged.get(current) as string
    }
    return current
  }
}

/**
 * Resolve every touch warning in `result` against the final body store. Mutates
 * `result` only, never a checkpoint's cached row, and only when a warning
 * actually resolves: a feature whose warning is still valid is left untouched,
 * so the common case pays nothing.
 */
export function resolveTouchWarnings(
  featureOrder: readonly string[],
  checkpoints: Record<string, CheckpointView>,
  result: ResultRows,
): void {
  // Checkpoints are keyed by feature id, so a duplicated id (an imported or
  // hand-edited document) would make the lineage read the wrong boundary.
  // Refuse to resolve rather than risk dropping a real problem.
  if (new Set(featureOrder).size !== featureOrder.length) return
  const resolve = mergeLineage(featureOrder, checkpoints, result)
  for (const fid of featureOrder) {
    const row = asRow(result[fid])
    const warning = row?.solver_warning
    if (row === undefined || typeof warning !== 'string' || warning === '') continue
    const receiving = receivingBodyId(row)
    if (receiving === null) continue
    const segment = findTouch(warning)
    if (segment === null) continue
    const named = segment.names.split(',').map((name) => name.trim()).filter((name) => name !== '')
    const target = resolve(receiving)
    // A removed receiving body makes the warning moot: the new solid it named is
    // gone, so nothing is left to fuse.
    const kept = target === GONE
      ? []
      : [...new Set(named.map(resolve))].filter((id) => id !== GONE && id !== target)
    if (kept.length === named.length && kept.every((id, i) => id === named[i])) continue
    const original = warning.slice(segment.start, segment.end)
    const next: ResultRow = { ...row }
    if (kept.length === 0) {
      const remaining = warning.slice(0, segment.start) + warning.slice(segment.end)
      const cleaned = remaining.replace(/^;\s*/, '').replace(/;\s*$/, '').replace(/;\s*;\s*/g, '; ')
      if (cleaned === '') delete next.solver_warning
      else next.solver_warning = cleaned
      const prior = typeof row.resolved_warning === 'string' && row.resolved_warning !== ''
        ? `${row.resolved_warning}; `
        : ''
      next.resolved_warning = `${prior}${original}`
    } else {
      const rewritten = `${segment.head}: the new solid also touches ${kept.join(', ')}; add a boolean union to fuse it`
      next.solver_warning = warning.slice(0, segment.start) + rewritten + warning.slice(segment.end)
    }
    result[fid] = next
  }
}
