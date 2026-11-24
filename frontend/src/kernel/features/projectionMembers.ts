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
import { entityPointKeys, getDefaultParams, ENTITY_BY_KIND } from '@/registry'
import type { PartDoc } from '@/types/cad'
import { entityDisplayName, entityKindPhrase, featureDisplayName, sketchDisplayName } from '@/utils/core/displayNames'

/** Hex characters of the construction UUID a member id starts with. */
export const MEMBER_ID_HEX = 8

/** End handles a fit spline entity stores: 0, 2 or 4 scalars (one x/y pair
 *  each). `lowerSketch` derives the same count from the entity's `handles`. */
export function fitHandleCount(handles: unknown): number {
  return (handles === 'start' || handles === 'both' ? 1 : 0)
    + (handles === 'end' || handles === 'both' ? 1 : 0)
}

/** The block a projection of `kind` displays when it has no position: the
 *  registry default, extended with zero end handles for a handled fit spline so
 *  the block matches the layout `lowerSketch` builds from `handles`. */
export function defaultProjectionBlock(kind: string, handles?: unknown): number[] {
  const defaults = [...getDefaultParams(kind)]
  for (let i = 2 * fitHandleCount(handles); i > 0; i--) defaults.push(0)
  return defaults
}

/**
 * True when a stored `initial` block is exactly the kind's default block. The
 * projection fallback used to bake that block for a source that never resolved,
 * so a document written by the old fallback looks like it has a position -- the
 * reported bug is an all-zero spline at the sketch origin. No genuine projection
 * produces the block: the defaults are a zero-length line/circle/arc/spline, or
 * a two-point fit spline, which a resolved source would have to collapse onto
 * itself to match.
 */
export function isDefaultProjectionBlock(params: unknown, kind: string, handles?: unknown): boolean {
  if (!Array.isArray(params)) return false
  const defaults = defaultProjectionBlock(kind, handles)
  if (!defaults.length || params.length !== defaults.length) return false
  return params.every((v, i) => v === defaults[i])
}

/**
 * True when a stored `initial` block is a position in the declared kind's own
 * layout. A projection keeps its last position only on this answer.
 *
 * The block can belong to another kind: a projection declared `line` that
 * resolved to a `point` (an end-on source) caches 2 params, one declared
 * `spline` that resolved to `fit_spline` caches 2N. Padding or truncating that
 * block to the declared kind's arity invents geometry at the stale position,
 * which the "keep the last position" rule then makes permanent.
 *
 * A `fit_spline` block is its own layout, so the test is its handle slots plus
 * at least two fit points, both even. That still cannot tell a four-point fit
 * block (8 scalars) from a cubic spline of the same length; a row still
 * declared `spline` is read as the cubic it claims. This app does not write
 * that disagreement: the write-back adopts the resolved kind in the same pass
 * that installs the block. It can only come from a pre-adoption or hand-edited
 * document, which carries no provenance to decide it.
 */
export function isProjectionPosition(stored: unknown, kind: string, handles?: unknown): boolean {
  if (!Array.isArray(stored) || isDefaultProjectionBlock(stored, kind, handles)) return false
  const def = ENTITY_BY_KIND.get(kind)
  if (def === undefined) return false
  if (def.variableParams) {
    const fitParams = stored.length - 2 * fitHandleCount(handles)
    return fitParams >= def.paramCount && fitParams % 2 === 0
  }
  return stored.length === def.paramCount
}

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

/** The five causes an authored sketch projection can name at its own boundary.
 *  `unpositioned` is the sixth: the named entity exists but the document holds
 *  no position for it yet, which is what a stored never-resolved projection
 *  looks like. */
export type ProjectionSourceProblemKind =
  | 'self reference'
  | 'unknown sketch'
  | 'unknown entity'
  | 'forward reference'
  | 'cycle'
  | 'unpositioned'

export interface ProjectionSourceProblem {
  // The short cause the solve warning substitutes for its generic tail.
  kind: ProjectionSourceProblemKind
  // The one-sentence refusal the applier throws.
  message: string
}

/** The parts of `@<sketchId>/<entityId>[/vertex]` a sketch projection names. */
export interface ProjectionSketchSource {
  sketchId: string
  entityId: string
  vertexKey?: string
}

/** Parse a whole-entity or vertex sketch source; null for a body query, a
 *  builtin ref, a local `$` ref or an unrecognizable spelling. */
export function parseProjectionSketchSource(source: string): ProjectionSketchSource | null {
  if (!source.startsWith('@') || source.startsWith('@builtin_')) return null
  const [sketchId, entityId, vertexKey] = source.slice(1).split('/')
  if (!sketchId || !entityId) return null
  return { sketchId, entityId, ...(vertexKey ? { vertexKey } : {}) }
}

/** `$<entity>` names an entity of the target sketch itself. */
function localProjectionSource(source: string): string | null {
  return source.startsWith('$') && source.length > 1 ? source.slice(1) : null
}

function chainLabel(ids: readonly string[], sketch: { entities?: unknown } | undefined): string {
  return ids.map(id => entityDisplayName(sketch, id) ?? 'the picked entity').join(' -> ')
}

/** The projection rows of a sketch, as a target -> source map for a `$` chain. */
function localProjectionChains(feature: unknown): Map<string, string> {
  const chains = new Map<string, string>()
  const constraints = typeof feature === 'object' && feature !== null
    ? (feature as { constraints?: unknown }).constraints
    : undefined
  const rows = Array.isArray(constraints) ? constraints : []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const c = row as { kind?: unknown; target?: unknown; source?: unknown }
    if (c.kind !== 'projection' || typeof c.target !== 'string' || !c.target.startsWith('$')) continue
    if (typeof c.source !== 'string') continue
    chains.set(c.target.slice(1), c.source)
  }
  return chains
}

/**
 * Why a sketch projection source can never resolve, or null when it is a
 * plausible source. Pure over the document: the loader and the solve reuse it
 * to name the cause of a stored dangling row, and the applier refuses a new row
 * with the same sentence.
 *
 * `targetId` names the entity the projection will hold, when the caller knows
 * it (the applier's authored id, or the solve's target). Without it a `$`
 * self-reference cannot be told from any other chain, and the fresh mint is
 * never an existing chain member anyway.
 */
export function classifyProjectionSource(
  doc: PartDoc,
  featureId: string,
  source: string,
  targetId?: string,
): ProjectionSourceProblem | null {
  if (!source || source.startsWith('?')) return null
  if (source === '@builtin_origin') return null
  if (isFaceProjectionSource(source)) return null
  const features = doc.features ?? []
  const target = features.find(feature => feature.id === featureId)
  if (target === undefined || target.kind !== 'sketch') return null
  const targetName = featureDisplayName(target, features)
  const targetEntity = (id: string) => entityDisplayName(target, id) ?? 'the picked entity'

  const local = localProjectionSource(source)
  if (local !== null) {
    const entities = target.entities ?? []
    const targetEid = targetId ?? null
    if (targetEid !== null && local === targetEid) {
      return {
        kind: 'self reference',
        message: 'a projection cannot source itself',
      }
    }
    // The chain the new row would close: `$` sources are copied verbatim, so a
    // walk from the named entity that reaches the target makes both rows cyclic.
    const chains = localProjectionChains(target)
    const visited: string[] = []
    let current = local
    while (true) {
      if (targetEid !== null && current === targetEid) {
        return {
          kind: 'cycle',
          message: `cycle: ${targetEntity(local)} follows ${chainLabel(visited, target)} back to ${targetEntity(targetEid)}`,
        }
      }
      if (visited.includes(current)) {
        return {
          kind: 'cycle',
          message: `cycle: ${targetEntity(local)} follows ${chainLabel(visited, target)} back to ${targetEntity(current)}`,
        }
      }
      visited.push(current)
      const next = chains.get(current)
      if (next === undefined || !next.startsWith('$') || next.length < 2) break
      current = next.slice(1)
    }
    if (!entities.some(entity => entity.id === local)) {
      return {
        kind: 'unknown entity',
        message: `the picked source names no entity in ${targetName}`,
      }
    }
    if (target.initial?.[local] === undefined) {
      return {
        kind: 'unpositioned',
        message: `${targetEntity(local)} in ${targetName} has no position yet; `
          + 'solve that sketch before projecting it',
      }
    }
    return null
  }

  const parsed = parseProjectionSketchSource(source)
  if (parsed === null) return null
  const { sketchId, entityId } = parsed
  if (sketchId === featureId) {
    return {
      kind: 'self reference',
      message: 'a sketch cannot project its own entity; draw it, or project the part edge it came from',
    }
  }
  const sourceFeature = features.find(feature => feature.id === sketchId)
  if (sourceFeature === undefined) {
    return {
      kind: 'unknown sketch',
      message: 'the picked source names no sketch in this document',
    }
  }
  const sourceName = sketchDisplayName(sketchId, features)
  if (sourceFeature.kind !== 'sketch') {
    return {
      kind: 'unknown sketch',
      message: `the picked source names ${sourceName}, which is not a sketch`,
    }
  }
  const sourceAt = features.findIndex(feature => feature.id === sketchId)
  const targetAt = features.findIndex(feature => feature.id === featureId)
  if (sourceAt >= 0 && targetAt >= 0 && sourceAt >= targetAt) {
    return {
      kind: 'forward reference',
      message: `forward reference: ${sourceName} comes later than ${targetName}; `
        + 'reorder or project in the other direction',
    }
  }
  const entities = sourceFeature.entities ?? []
  const entity = entities.find(candidate => candidate.id === entityId)
  if (entity === undefined) {
    // A face projection derives member ids with no document row; a projection of
    // one of those is the visible member the solve produced, so it resolves.
    const member = (sourceFeature.constraints ?? []).some(constraint =>
      constraint.kind === 'projection'
      && constraint.members !== undefined
      && Object.values(constraint.members).includes(entityId))
    if (member) return null
    return {
      kind: 'unknown entity',
      message: `the picked source names no entity in ${sourceName}`,
    }
  }
  if (sourceFeature.initial?.[entityId] === undefined) {
    return {
      kind: 'unpositioned',
      message: `${entityDisplayName(sourceFeature, entityId) ?? 'the picked entity'} in ${sourceName} has no position yet; `
        + 'solve that sketch before projecting it',
    }
  }
  // A vertex suffix is checked against the kind's own operand keys: `/nope` on a
  // line can never resolve, so it is a document authoring mistake, not a solve
  // miss. The sentence lists the same set `registerSolvedGeometrySlash` publishes.
  if (parsed.vertexKey !== undefined) {
    const params = sourceFeature.initial?.[entityId] ?? []
    const keys = entityPointKeys(entity.kind, params.length, entity.handles)
    if (keys !== undefined && !keys.has(parsed.vertexKey)) {
      const name = entityDisplayName(sourceFeature, entityId) ?? 'the picked entity'
      const kindPhrase = entityKindPhrase(entity.kind) ?? 'the shape'
      return {
        kind: 'unknown entity',
        message: `${name} of ${sourceName} has no vertex '${parsed.vertexKey}'; `
          + `${kindPhrase} has: ${[...keys].join(', ')}`,
      }
    }
  }
  return null
}

/** The refusal sentence for a new projection row, or null when it may land. */
export function describeProjectionSourceProblem(
  doc: PartDoc,
  featureId: string,
  source: string,
  targetId?: string,
): string | null {
  return classifyProjectionSource(doc, featureId, source, targetId)?.message ?? null
}

/** What a delete does to projections that source the removed geometry. */
export interface ProjectionDependentsReport {
  // `sk2/p1, sk3/q3 projected sk1/l1 and keep their last position; convert
  // them to fixed to unlink them`.
  text: string
  // The consuming sketches, in feature order, for the note's ids.
  ids: string[]
}

/**
 * The projections a delete freezes: every stored row whose source names one of
 * the deleted sketch entities. `@sk/ent` crosses sketches and `$ent` stays in
 * the deleted entity's own sketch, so both spellings are scanned. The note is
 * informational: the delete proceeds and those rows keep their last position.
 */
export function projectionDependentsReport(
  doc: PartDoc,
  targets: readonly string[],
): ProjectionDependentsReport | null {
  const deleted = new Map<string, Set<string>>()
  for (const target of targets) {
    const parts = target.split(':')
    if (parts[0] !== 'entity' && parts[0] !== 'vertex') continue
    const featureId = parts[1]
    const entityId = parts[2]
    if (!featureId || !entityId) continue
    const held = deleted.get(featureId) ?? new Set<string>()
    held.add(entityId)
    deleted.set(featureId, held)
  }
  if (deleted.size === 0) return null
  const dependents: string[] = []
  const sources: string[] = []
  const ids: string[] = []
  for (const feature of doc.features ?? []) {
    if (feature.kind !== 'sketch') continue
    for (const constraint of feature.constraints ?? []) {
      if (constraint.kind !== 'projection' || typeof constraint.source !== 'string') continue
      const target = typeof constraint.target === 'string' && constraint.target.startsWith('$')
        ? constraint.target.slice(1)
        : null
      if (target === null) continue
      const sketchSource = parseProjectionSketchSource(constraint.source)
      const local = localProjectionSource(constraint.source)
      const sourceId = sketchSource?.sketchId ?? (local === null ? null : feature.id)
      const entityId = sketchSource?.entityId ?? local
      if (sourceId === null || entityId === null) continue
      if (!deleted.get(sourceId)?.has(entityId)) continue
      const dependent = `${feature.id}/${target}`
      const source = `${sourceId}/${entityId}`
      if (!dependents.includes(dependent)) dependents.push(dependent)
      if (!sources.includes(source)) sources.push(source)
      if (!ids.includes(feature.id)) ids.push(feature.id)
    }
  }
  if (dependents.length === 0) return null
  return {
    text: `${dependents.join(', ')} projected ${sources.join(', ')} and keep their last position; `
      + 'convert them to fixed to unlink them',
    ids,
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
  const part = token.startsWith('u|') ? token.slice(2) : token.replace(/^@u\|/, '')
  const hex = part.toLowerCase().replace(/[^0-9a-f]/g, '')
  if (hex.length > 0) return hex
  return part.toLowerCase().replace(/[^0-9a-z]/g, '')
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

/** The freeze command's version of the same note: the projection is deliberately
 *  left in place, which is the opposite of what the delete note promises. */
export function projectionNoRowsToFreezeMessage(constraintIds: readonly string[]): string {
  const named = constraintIds.join(', ')
  const plural = constraintIds.length === 1 ? 'projection' : 'projections'
  return `${plural} ${named} ${constraintIds.length === 1 ? 'has' : 'have'} no solved member rows to freeze; `
    + 'left in place'
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
export interface FaceBoundaryPartLike {
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
export function faceBoundaryFromParts(
  getParts: () => Record<string, FaceBoundaryPartLike> | null | undefined,
): (source: string) => FaceBoundary | null {
  return (source) => {
    for (const part of Object.values(getParts() ?? {})) {
      const mesh = part.mesh
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
      ;(part.edge_queries ?? []).forEach((query, index) => {
        const kind = part.edges?.[index]?.kind
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
