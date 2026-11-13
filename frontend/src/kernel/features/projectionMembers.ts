// Derived membership of a face projection. A face pick is one live constraint;
// its boundary edges become member entities on every solve, never document rows.
// The only stored facts are which construction UUIDs the user removed and the id
// each live member was handed, so a solve can keep an id stable without minting
// one (the journal's mint index never sees a member).
//
// The id is a function of the constraint id and the edge's construction UUID
// token, the identity a rebuild recomputes (see knowledge base
// "Construction-name hand-off"). It is stable across solves unless two tokens
// collide in the first eight hex characters: then the deterministic lengthening
// moves one id, and the last-resort fallback re-spaces the whole map by sorted
// position for a duplicated token. Geometry hashes were rejected as identity: a
// moved face would rename every member.

import { parseQuery } from '@/utils/query'
import { isFaceRestriction } from '@/kernel/faceTypes'

/** Hex characters of the construction UUID a member id starts with. */
export const MEMBER_ID_HEX = 8

/** One boundary edge of a face, resolved from the body's mesh or B-rep. */
export interface FaceBoundaryEdge {
  // The construction token without its leading `@` (`u|<uuid>`), the map key.
  token: string
  // The edge's ancestry query, lowered exactly like a single-edge projection.
  query: string
  // The edge's curve kind at this solve.
  kind: string
}

/** A face's boundary edges and the edges the face meets twice (seams). A seam
 *  is kernel bookkeeping, not authored geometry, so it never becomes a member. */
export interface FaceBoundary {
  edges: readonly FaceBoundaryEdge[]
  seams?: readonly string[]
}

/** The stored half of a face projection the reconcile reads. */
export interface FaceProjectionConstraintLike {
  id: string
  members?: Record<string, string>
  excluded?: readonly string[]
}

/** What one solve derived for a face projection. `members` is the next stored
 *  map (orphans included, excluded tokens gone), `added`/`orphans` are the
 *  tokens whose state changed, and `changed` says whether `members` differs from
 *  the stored map. `resolved` is false on a face miss, where the map is pinned. */
export interface FaceProjectionReconcile {
  resolved: boolean
  members: Record<string, string>
  added: readonly string[]
  orphans: readonly string[]
  kept: readonly string[]
  changed: boolean
}

/** The edge token a query names, without the wire `@`, or null when the query
 *  carries no construction UUID (an old body, or a non-ancestry source). */
export function edgeUuidToken(query: string): string | null {
  try {
    const parsed = parseQuery(query)
    if (parsed.kind !== 'ancestry') return null
    const token = parsed.ancestorIds.find((id) => id.startsWith('@u|'))
    return token === undefined ? null : token.slice(1)
  } catch {
    return null
  }
}

/** True when `source` names a face (any surface kind); a face projection has no
 *  target and derives its members instead of holding one entity. */
export function isFaceProjectionSource(source: string): boolean {
  try {
    const parsed = parseQuery(source)
    return parsed.kind === 'ancestry' && isFaceRestriction(parsed.typeRestriction)
  } catch {
    return false
  }
}

/** The deterministic constraint id of a face projection: the face's own UUID,
 *  so an add never depends on a mint and a re-add of the same face is a
 *  duplicate. Null when the source carries no UUID. */
export function faceProjectionConstraintId(source: string): string | null {
  const token = edgeUuidToken(source)
  if (token === null) return null
  return `proj_${tokenHex(token).slice(0, MEMBER_ID_HEX)}`
}

/** The hex (or, for a token with no hex characters, the alphanumeric) body of a
 *  construction token, used only to spell an id. */
function tokenHex(token: string): string {
  const body = token.startsWith('u|') ? token.slice(2) : token.replace(/^@u\|/, '')
  const hex = body.toLowerCase().replace(/[^0-9a-f]/g, '')
  if (hex.length > 0) return hex
  return body.toLowerCase().replace(/[^0-9a-z]/g, '')
}

function sortedUnique(tokens: Iterable<string>): string[] {
  return [...new Set(tokens)].sort()
}

/** Stable member ids for `tokens`: `<cid>.<first 8 hex>`, lengthened by four
 *  hex characters at a time until every id in this constraint is unique. The
 *  group is extended together, so the result never depends on input order. */
export function deriveMemberIds(constraintId: string, tokens: Iterable<string>): Record<string, string> {
  const sorted = sortedUnique(tokens)
  const hex = new Map(sorted.map((token) => [token, tokenHex(token)]))
  const widths = new Map(sorted.map((token) => [token, MEMBER_ID_HEX]))
  for (let guard = 0; guard <= 16; guard++) {
    const ids = new Map<string, string>()
    for (const token of sorted) {
      ids.set(token, `${constraintId}.${hex.get(token)!.slice(0, widths.get(token)!)}`)
    }
    const groups = new Map<string, string[]>()
    for (const token of sorted) {
      const id = ids.get(token)!
      const group = groups.get(id)
      if (group === undefined) groups.set(id, [token])
      else group.push(token)
    }
    const collisions = [...groups.values()].filter((group) => group.length > 1)
    if (collisions.length === 0) {
      return Object.fromEntries(sorted.map((token) => [token, ids.get(token)!]))
    }
    // A token already past its own length cannot be lengthened by slicing; the
    // fallback below is the last resort for a duplicated (broken) construction
    // token, and stays deterministic because the token list is sorted.
    for (const group of collisions) {
      for (const token of group) widths.set(token, widths.get(token)! + 4)
    }
    if (sorted.every((token) => widths.get(token)! > hex.get(token)!.length + 16)) break
  }
  return Object.fromEntries(sorted.map((token, index) => [
    token,
    `${constraintId}.${hex.get(token)}.${index}`,
  ]))
}

function sameMembers(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) => b[key] === a[key])
}

/**
 * Reconcile a face projection against the face's current boundary. The rules,
 * in order:
 *
 * 1. A face that did not resolve (null boundary) edits nothing and pins the
 *    stored map; the members come back on their own when it resolves again.
 * 2. A kept edge keeps the id the map already holds whenever the whole map's
 *    derivation still spells it that way (a collision with a new or orphaned
 *    token is the one case the deterministic lengthening moves it), and the
 *    whole result keeps the stored object when nothing changed, so the
 *    write-back installs nothing.
 * 3. A new edge gets its derived id; the derived ids never consume a mint.
 * 4. A member whose edge left the face is kept in the map (orphan) so a restored
 *    edge gets its old id back; it is reported and yields no geometry this solve.
 * 5. Everything is ordered by construction token, never by walk order, so the
 *    map and the ids are the same on every solve and every replay.
 */
export function reconcileFaceProjection(
  constraint: FaceProjectionConstraintLike,
  boundary: FaceBoundary | null,
): FaceProjectionReconcile {
  const stored = constraint.members ?? {}
  if (boundary === null) {
    return { resolved: false, members: stored, added: [], orphans: [], kept: [], changed: false }
  }
  const excluded = new Set(constraint.excluded ?? [])
  const seams = new Set(boundary.seams ?? [])
  const live = new Map<string, FaceBoundaryEdge>()
  for (const edge of boundary.edges) {
    if (edge.token === '' || excluded.has(edge.token) || seams.has(edge.query)) continue
    if (!live.has(edge.token)) live.set(edge.token, edge)
  }
  const liveTokens = sortedUnique(live.keys())
  const orphans = sortedUnique(
    Object.keys(stored).filter((token) => !live.has(token) && !excluded.has(token)),
  )
  // Derive over the WHOLE map, orphans included. The derived form is what the
  // loader validates, and deriving only the live set could hand a new edge an id
  // an orphan already holds. On a genuine 8-hex collision between the two, the
  // deterministic lengthening moves one of them; that is the one case an id is
  // allowed to change, and it happens the same way on every solve and replay.
  const mapTokens = sortedUnique([...liveTokens, ...orphans])
  const derived = deriveMemberIds(constraint.id, mapTokens)
  const members: Record<string, string> = {}
  for (const token of mapTokens) members[token] = derived[token]
  const added = liveTokens.filter((token) => stored[token] === undefined)
  // A token is "kept" only when its stored id is still the derived one; a
  // collision that lengthened it is a change, not a keep.
  const kept = liveTokens.filter((token) => stored[token] === members[token])
  if (sameMembers(stored, members)) {
    return { resolved: true, members: stored, added, orphans, kept, changed: false }
  }
  return { resolved: true, members, added, orphans, kept, changed: true }
}

/** One derived member as the solve and the freeze payload describe it: the id,
 *  the kind the current source projects as, and the 2D params. None of it is a
 *  document row; a freeze mutation records the bytes to materialize. */
export interface ProjectionMemberEntity {
  id: string
  kind: string
  params: number[]
}

/** What one solve derived for one face projection. `members` is the map the
 *  write-back installs, `entities` are the members that resolved this solve, and
 *  `orphans` names the tokens whose edge left the face. */
export interface ProjectionMemberReport {
  members: Record<string, string>
  entities: ProjectionMemberEntity[]
  orphans: string[]
}

/** The one sentence both delete paths show when a face projection has no rows
 *  to freeze. Neutral on purpose: the projection may be unresolved, a member
 *  may have failed to project, or it may have been added since the last solve. */
export const PROJECTION_NOT_FROZEN_TITLE = 'Projection not frozen'

export function projectionNotFrozenMessage(constraintIds: readonly string[]): string {
  const named = constraintIds.join(', ')
  const plural = constraintIds.length === 1 ? 'projection' : 'projections'
  return `${plural} ${named} ${constraintIds.length === 1 ? 'has' : 'have'} no solved member rows to freeze; `
    + 'removed without materializing geometry'
}

/** The targeted face projections a delete will freeze nothing for: each has
 *  live (non-excluded, non-orphan) members but no resolved entity rows. Used by
 *  the editor to warn on a mixed selection and by the drive to note a delete
 *  that discards an unresolved wire. */
export function projectionsFreezingNothing(
  featureId: string | null,
  documents: {
    constraints?: ReadonlyArray<{
      id: string
      kind: string
      target?: unknown
      members?: Record<string, string>
      excluded?: readonly string[]
    }>
  } | null | undefined,
  targets: readonly string[],
  reports: Readonly<Record<string, { entities: readonly ProjectionMemberEntity[]; orphans?: readonly string[] }>>
    | null | undefined,
): string[] {
  if (featureId === null || documents === null || documents === undefined) return []
  const empty: string[] = []
  for (const target of targets) {
    if (!target.startsWith('constraint:')) continue
    const [kind, sketchId, constraintId] = target.split(':')
    if (kind !== 'constraint' || sketchId !== featureId || constraintId === undefined) continue
    const constraint = documents.constraints?.find(candidate => candidate.id === constraintId)
    if (constraint?.kind !== 'projection' || constraint.target !== undefined) continue
    const report = reports?.[constraintId]
    const excluded = new Set(constraint.excluded ?? [])
    const orphans = new Set(report?.orphans ?? [])
    const live = Object.keys(constraint.members ?? {})
      .filter(token => !excluded.has(token) && !orphans.has(token))
    if (live.length === 0) continue  // intentionally empty, not a failed freeze
    const frozen = new Set((report?.entities ?? []).map(entity => entity.id))
    const hasFrozenRow = Object.entries(constraint.members ?? {})
      .some(([token, id]) => live.includes(token) && frozen.has(id))
    if (!hasFrozenRow && !empty.includes(constraintId)) empty.push(constraintId)
  }
  return empty
}

/** The member rows a delete of a face projection should freeze, read from the
 *  last solve's report: only ids the targeted constraint still owns and that are
 *  not excluded. Undefined when the selection holds no face projection with a
 *  report, which keeps an ordinary delete free of the field (and its journal
 *  bytes). */
export function freezeRowsForDelete(
  featureId: string | null,
  documents: {
    constraints?: ReadonlyArray<{ id: string; kind: string; target?: unknown; members?: Record<string, string>; excluded?: readonly string[] }>
  } | null | undefined,
  targets: readonly string[],
  reports: Readonly<Record<string, { entities: readonly ProjectionMemberEntity[] }>> | null | undefined,
): ProjectionMemberEntity[] | undefined {
  if (featureId === null || documents === null || documents === undefined) return undefined
  const rows: ProjectionMemberEntity[] = []
  for (const target of targets) {
    if (!target.startsWith('constraint:')) continue
    const [kind, sketchId, constraintId] = target.split(':')
    if (kind !== 'constraint' || sketchId !== featureId || constraintId === undefined) continue
    const constraint = documents.constraints?.find(candidate => candidate.id === constraintId)
    if (constraint?.kind !== 'projection' || constraint.target !== undefined || constraint.members === undefined) continue
    const live = new Set(Object.values(constraint.members))
    const excluded = new Set(constraint.excluded ?? [])
    for (const row of reports?.[constraintId]?.entities ?? []) {
      if (!live.has(row.id)) continue
      const token = Object.keys(constraint.members).find(key => constraint.members?.[key] === row.id)
      if (token !== undefined && excluded.has(token)) continue
      if (!rows.some(candidate => candidate.id === row.id)) rows.push(row)
    }
  }
  return rows.length > 0 ? rows : undefined
}

/** A boundary read from the viewport's face-edge resolver: the seam set is
 *  applied by the caller when the mesh carries it. Edges without a construction
 *  UUID are skipped because they cannot carry a stable member id. */
export function boundaryFromFaceEdges(
  edges: readonly { source: string; kind: string }[] | null,
): FaceBoundary | null {
  if (edges === null) return null
  return {
    edges: edges.flatMap((edge) => {
      const token = edgeUuidToken(edge.source)
      return token === null ? [] : [{ token, query: edge.source, kind: edge.kind }]
    }),
  }
}

/** The body-result fields a headless boundary lookup reads. Structural, so the
 *  drive can pass its last solved bodies without the kernel importing the
 *  document types. */
export interface FaceBoundaryBodyLike {
  mesh?: {
    face_queries?: string[]
    // The canonical face UUIDs; the solve-time lookup falls back to these when
    // a stored query drifted, and the headless lookup must agree.
    face_uuids?: (string | null)[]
    face_edge_queries?: string[][]
    face_seam_queries?: string[][]
  }
  edges?: ReadonlyArray<{ kind?: string }>
  edge_queries?: readonly string[]
}

/**
 * Build a boundary lookup from the last solved body results (the headless drive
 * path). A face's mesh lists its boundary edges and the seam edges it meets
 * twice, exactly what the UI registry reads; the edge kinds come from the
 * parallel edge arrays.
 */
export function faceBoundaryFromBodies(
  getBodies: () => Record<string, FaceBoundaryBodyLike> | null | undefined,
): (source: string) => FaceBoundary | null {
  return (source) => {
    for (const body of Object.values(getBodies() ?? {})) {
      const mesh = body.mesh
      let faceIndex = mesh?.face_queries?.indexOf(source) ?? -1
      if (faceIndex < 0) {
        // A stored query can drift while the face's construction UUID still
        // names it; the solve-time lookup already falls back to `face_uuids`,
        // so the drive must not refuse what the UI resolves.
        const token = edgeUuidToken(source)
        const uuid = token === null ? null : token.slice(2)
        faceIndex = uuid === null ? -1 : mesh?.face_uuids?.indexOf(uuid) ?? -1
      }
      if (faceIndex < 0) continue
      const queries = mesh?.face_edge_queries?.[faceIndex]
      if (queries === undefined || queries.length === 0) return null
      const seams = mesh?.face_seam_queries?.[faceIndex] ?? []
      const kindByQuery = new Map<string, string>()
      ;(body.edge_queries ?? []).forEach((query, index) => {
        const kind = body.edges?.[index]?.kind
        if (query !== '' && kind !== undefined) kindByQuery.set(query, kind)
      })
      return {
        seams,
        edges: queries.flatMap((query) => {
          const token = edgeUuidToken(query)
          return token === null ? [] : [{ token, query, kind: kindByQuery.get(query) ?? 'line' }]
        }),
      }
    }
    return null
  }
}
