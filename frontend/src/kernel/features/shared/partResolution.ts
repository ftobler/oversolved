// Body and merge-target resolution shared by the boolean, transform, delete
// and pattern leaves. Pure store lookups, no OCC.

import type { PartSolid } from '../../types3d'
import { AmbiguousQueryError, parseAncestry, type Repository } from '../../query'
import { stripRefSigil } from '@/utils/refSigil'

type Dict = Record<string, unknown>

/**
 * A ref that names several bodies where the caller can only use one. Its own
 * type because "ambiguous" and "not found" are opposite diagnoses -- leaves
 * that wrap a resolve failure in a friendlier message (pattern.ts) must let this
 * one through rather than tell the user the body does not exist while listing
 * the very ids that matched.
 */
export class AmbiguousPartRefError extends Error {}

/**
 * The single body a ref names, or null when it names none. Throws when the ref
 * names a FEATURE that owns several bodies: which sibling was meant is the
 * caller's question, and answering it with "the first one" is what let a
 * boolean subtract one half of a split body and report success.
 */
function singlePartOf(ref: string, partStore: Record<string, PartSolid>): PartSolid | null {
  const ids = resolvePartIds(ref, partStore)
  if (ids.length === 0) return null
  if (ids.length > 1) {
    throw new AmbiguousPartRefError(
      `part ref '${ref}' is ambiguous: it names a feature owning ${ids.length} parts ` +
      `(${ids.join(', ')}); name one of them`,
    )
  }
  return partStore[ids[0]]
}

/**
 * Resolve a body reference to its Body (mirrors `_resolve_body`). Accepts
 * "@feat", "feat", "body_feat", viewport selection forms ("face:id:...",
 * "entity:...", "body:id", "edge:...", "vertex:..."), and "?...:type" ancestry
 * queries (matched via their "@body_*" ancestors). Throws if nothing matches.
 *
 * Singular by contract -- every call site here wants ONE body (a boolean
 * target, a mirror source, a hole target). Exact body ids and `?` queries are
 * body-exact and always safe; a bare feature ref is only safe while that
 * feature owns one body, and fails loud otherwise (see `singleBodyOf`). Use
 * `resolvePartIds` where every body of a feature is the right answer.
 */
export function resolvePart(ref: string, partStore: Record<string, PartSolid>): PartSolid {
  const direct = singlePartOf(ref, partStore)
  if (direct !== null) return direct
  if (ref.includes(':')) {
    const parts = ref.split(':')
    if (parts.length >= 2) {
      const viewport = singlePartOf(parts[1], partStore)
      if (viewport !== null) return viewport
    }
  }
  throw new Error(`part not found for ref '${ref}'`)
}

/**
 * Build an empty Body shell with default fields (shape is assigned by the caller
 * after registration). Mirrors Python Body(id, created_by, shape, sketch_id).
 */
export function barePart(id: string, createdBy: string, sketchId = ''): PartSolid {
  return {
    id,
    created_by: createdBy,
    modified_by: [],
    shape: null,
    sketch_id: sketchId,
    brep_diff: null,
    profile_queries: [],
  }
}

/** `@<body-or-feature>/face|edge|vertex/<index>` -- see `topoFallbackQuery`. */
const TOPO_FALLBACK_REF = /^@([^/]+)\/(?:face|edge|vertex)\/\d+$/

/**
 * Every body id a ref names, or `[]` when it names none. The plural counterpart
 * to `resolvePart`, and the one place the feature->bodies direction is decided.
 *
 * A FEATURE id resolves to every body that feature made, not just the first.
 * One feature routinely owns several bodies -- it produced disjoint solids, or a
 * later cut severed what it produced (features/partSplit.ts) -- so returning
 * only the first meant "cut everything @extrude1 made" quietly cut one half and
 * left the other standing.
 *
 * Callers decide what "no match" means, which is why this returns `[]` rather
 * than throwing: the merge-target and delete-body errors read differently, and
 * delete-body still falls back to `resolvePart` for viewport-prefix forms.
 */
export function resolvePartIds<T extends { created_by: string }>(ref: string, partStore: Record<string, T>): string[] {
  const key = stripRefSigil(ref, '@')
  // An exact body id names exactly that one sibling.
  if (key in partStore) return [key]
  // A topo-fallback element ref names the body it sits on. The render layer
  // mints this form whenever the kernel produced no named query for a face,
  // edge or vertex (utils/query/selectionId.ts topoFallbackQuery), so a face
  // pick can reach any body field as `@body_ex1/face/0`; without this branch
  // the leading segment fell through to the feature scan, missed, and the pick
  // resolved to nothing. `?` is handled below and never has this shape.
  const topo = TOPO_FALLBACK_REF.exec(ref)
  if (topo) return resolvePartIds(topo[1], partStore)
  // A `?` ancestry query is body-exact: it resolves through one picked face or
  // edge, so the `@body_*` ancestor it carries IS the answer and no feature
  // scan applies. First match only, like `resolvePart` -- a query can name more
  // than one body (a boolean face descends from both inputs), and the owner is
  // the first one written.
  if (ref.startsWith('?')) {
    try {
      const [ids] = parseAncestry(ref)
      for (const aid of ids) {
        if (aid.startsWith('@body_') && aid.slice(1) in partStore) return [aid.slice(1)]
      }
    } catch {
      // unparseable query: fall through, the ref names nothing
    }
    return []
  }
  // Otherwise the ref names a FEATURE. The creator scan has to come before the
  // `body_<key>` lookup: the first sibling is literally called `body_<feature>`,
  // so that lookup would match it and hide the rest.
  const byCreator = Object.entries(partStore)
    .filter(([, body]) => body.created_by === key)
    .map(([bid]) => bid)
  if (byCreator.length > 0) return byCreator
  const prefixed = 'body_' + key
  if (prefixed in partStore) return [prefixed]
  return []
}

/**
 * Resolve one PLURAL body ref to the store keys it names, throwing when it
 * names none. The resolver behind every multi-select body field (delete_body's
 * `bodies`, transform's `bodies`).
 *
 * A `?` query is body-exact -- it resolves through a specific face/edge, so it
 * names the one sibling that owns it, and that is what the UI picker writes. A
 * plain ref may instead name a FEATURE, and a feature owns every body it made
 * (features/partSplit.ts): `['@extrude1']` has to name `body_extrude1` AND its
 * split siblings, not quietly leave the other halves behind. `resolvePart` is
 * still the fallback for the viewport-prefix forms (`face:id:...`) it alone
 * understands.
 *
 * `leaf` only names the caller in the error message, so a failed pick reads as
 * the feature the user was editing.
 */
export function resolvePartRefKeys(
  partQuery: string,
  globalRepo: Repository,
  partStore: Record<string, PartSolid>,
  leaf: string,
): string[] {
  if (!partQuery.startsWith('?')) {
    const ids = resolvePartIds(partQuery, partStore)
    return ids.length > 0 ? ids : [resolvePart(partQuery, partStore).id]
  }
  // The repo goes first because it is the precise answer: it resolves the picked
  // face itself and reads the body that owns it, which is what disambiguates a
  // boolean face descending from two inputs.
  let resolved: Dict | null = null
  try {
    resolved = globalRepo.query(partQuery, null, partStore) as Dict | null
  } catch (e) {
    // An ambiguous query is not an error for THIS question. A face with no
    // construction UUID, no ancestor tokens and no classifier is named by its
    // body alone (kernel/faceQuery.ts), so every such face of that body shares
    // one query string -- routine on imported geometry, where picking one face
    // of a 56-face part matched all 56 and failed the solve. Every candidate
    // sits on the same body by construction, since they all had to carry the
    // `@body_*` token the query matched on, so the body is unambiguous even
    // though the face is not. Anything else the repo throws is a real failure.
    if (!(e instanceof AmbiguousQueryError)) throw e
  }
  // A resolved Body carries created_by + id; a geometry dict carries body_id.
  if (resolved !== null) {
    if ('created_by' in resolved && typeof resolved.id === 'string') return [resolved.id]
    if (resolved.body_id) return [String(resolved.body_id)]
  }
  // Also the path for a face the user picked that no longer exists -- a later
  // edit reshaped the body under it. The body still does, and it is the body
  // this feature names, so read the `@body_*` ancestor out of the query rather
  // than failing the whole solve over an element nobody asked to keep.
  const ids = resolvePartIds(partQuery, partStore)
  if (ids.length > 0) return ids
  throw new Error(`${leaf}: query did not resolve to a part: ${JSON.stringify(partQuery)}`)
}

/**
 * Every store key a list of body refs names, in pick order, deduplicated.
 *
 * Resolution happens against the INTACT store before any caller acts on the
 * result: two picks landing on the same body (different faces) must collapse
 * into one entry rather than letting the second ref fail against a slot the
 * first already consumed.
 */
export function resolvePartRefList(
  partQueries: string[],
  globalRepo: Repository,
  partStore: Record<string, PartSolid>,
  leaf: string,
): string[] {
  const keys: string[] = []
  for (const partQuery of partQueries) {
    for (const key of resolvePartRefKeys(partQuery, globalRepo, partStore, leaf)) {
      if (!keys.includes(key)) keys.push(key)
    }
  }
  return keys
}

/**
 * Body IDs a body operation should target (mirrors `_resolve_merge_targets`).
 * Empty/None merge target means ALL bodies; anything else goes through
 * `resolvePartIds`.
 *
 * `opName` names the calling operation in the failure so a bad merge target on
 * a revolve or sweep is not misreported as an extrude.
 */
export function resolveMergeTargets(
  mergeTarget: string | null | undefined,
  partStore: Record<string, PartSolid>,
  opName = '',
): string[] {
  if (!mergeTarget) return Object.keys(partStore)
  const ids = resolvePartIds(mergeTarget, partStore)
  if (ids.length === 0) {
    const prefix = opName ? `${opName}: ` : ''
    throw new Error(`${prefix}merge target '${mergeTarget}' not found`)
  }
  return ids
}
