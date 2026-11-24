// Reference parsing shared by the leaf feature solvers: surface ancestry ids
// and viewport sketch picks. Pure, no OCC. It also owns the user-facing naming
// helpers (`entityKindWord`, `entityDisplayName`, `noAreaReason`) so a pick
// refusal and a build message name an entity the same way.

import { parseAncestry, type Repository } from '../../query'
import { ENTITY_BY_KIND } from '@/registry/entityRegistry'

type Dict = Record<string, unknown>

/**
 * Sorted, deduped entity ids referenced by a surface's ancestry query, or `[]`
 * if the query is absent/non-ancestry/unparsable. Dedup mirrors Python's
 * frozenset, since parseAncestry can repeat ids.
 */
export function surfaceEntityIds(surface: Dict): string[] {
  const query = (surface.query as string) ?? ''
  if (!query.startsWith('?')) return []
  let ids: string[]
  try {
    ;[ids] = parseAncestry(query)
  } catch {
    return []
  }
  return [...new Set(ids.filter((i) => i.startsWith('@') && i.includes('/')))].sort()
}

/**
 * Split a viewport sketch pick (`entity:<sketchId>:<eid>` or
 * `vertex:<sketchId>:<eid>:<sub>`) into the sketch and the entity it names.
 * Returns null for every other ref form (`$sketch`, `@feat/...`, `?...`).
 *
 * These are selection ids, not queries: the viewport toggles them into
 * `normalSelection` verbatim and the pick chips persist them unchanged (a
 * rewritten value would no longer match the re-click that unpicks it), so the
 * feature leaves have to understand the raw form. A `vertex:` pick names the
 * entity that owns the vertex, which is what both the sweep path and the
 * profile paths want from it.
 */
export function parseSketchEntityRef(ref: string): { sketchId: string; eid: string } | null {
  if (!ref.startsWith('entity:') && !ref.startsWith('vertex:')) return null
  const parts = ref.split(':')
  const sketchId = parts[1] ?? ''
  const eid = parts[2] ?? ''
  if (!sketchId || !eid) return null
  return { sketchId, eid }
}

/**
 * Sketch a `?...` ancestry query is drawn on: the first ancestor token that
 * names a registered sketch plane (`_pt_<id>`). An area pick carries its sketch
 * as a bare `@<sketchId>` token beside the `@<sketchId>/<eid>` tokens that name
 * the curves bounding it, so the plane registry is what tells the two apart.
 * Returns null when no token names a sketch (a body-face query, say).
 */
export function sketchIdFromQuery(query: string, globalRepo: Repository): string | null {
  if (!query.startsWith('?')) return null
  let ids: string[]
  try {
    ;[ids] = parseAncestry(query)
  } catch {
    return null
  }
  for (const id of ids) {
    if (!id.startsWith('@') || id.includes('/')) continue
    const candidate = id.slice(1)
    if (globalRepo.elements.get('_pt_' + candidate) !== undefined) return candidate
  }
  return null
}

/**
 * The one entity of `sketchId` a sketch-area query is bounded by, or null when
 * it names none or several. A click on the fill inside a lone circle and a click
 * on the circle itself are the same gesture as far as a feature is concerned, so
 * this is what lets the area form answer like the `entity:` form; a region
 * bounded by four lines names four entities and gets no single answer.
 */
export function soleEntityInQuery(query: string, sketchId: string): string | null {
  let ids: string[]
  try {
    ;[ids] = parseAncestry(query)
  } catch {
    return null
  }
  const prefix = '@' + sketchId + '/'
  const named = [...new Set(ids.filter((i) => i.startsWith(prefix)))]
  return named.length === 1 ? named[0].slice(prefix.length) : null
}

/**
 * Sketch a `?...` ancestry query names when the caller knows the document's
 * sketch rows rather than the plane registry: the first token whose feature id
 * is a known sketch. The editor and the drive value boundary have the document,
 * not `_pt_` planes, so they narrow a circle area pick through this.
 */
export function sketchIdFromAncestry(query: string, sketchIds: ReadonlySet<string>): string | null {
  if (!query.startsWith('?')) return null
  let ids: string[]
  try {
    ;[ids] = parseAncestry(query)
  } catch {
    return null
  }
  for (const id of ids) {
    if (!id.startsWith('@')) continue
    const token = id.slice(1)
    const slash = token.indexOf('/')
    const candidate = slash >= 0 ? token.slice(0, slash) : token
    if (sketchIds.has(candidate)) return candidate
  }
  return null
}

/**
 * The sketch and one entity a pick names, resolved against the document's
 * sketch ids. `entity:`/`vertex:` name it directly; a `?` area narrows only
 * when the region is bounded by exactly one entity of one sketch. Null keeps
 * the whole-sketch meaning (or an unresolvable pick) for the caller.
 */
export function pickedSketchEntity(
  ref: string,
  sketchIds: ReadonlySet<string>,
): { sketchId: string; entityId: string } | null {
  const direct = parseSketchEntityRef(ref)
  if (direct !== null) return { sketchId: direct.sketchId, entityId: direct.eid }
  if (!ref.startsWith('?')) return null
  const sketchId = sketchIdFromAncestry(ref, sketchIds)
  if (sketchId === null) return null
  const entityId = soleEntityInQuery(ref, sketchId)
  return entityId === null ? null : { sketchId, entityId }
}

// ─── Naming sketch entities for the user ───

/** What the naming helpers below need from a sketch row: its label (the tree
 *  name) and its entity list. Read as `unknown` so a raw document record and a
 *  typed `PartFeature` both pass. */
interface SketchNamingSource {
  label?: unknown
  entities?: unknown
}

/** The entity list of a sketch row, when it has one. */
function sketchEntities(source: SketchNamingSource): { id?: unknown; kind?: unknown }[] {
  return Array.isArray(source.entities) ? source.entities as { id?: unknown; kind?: unknown }[] : []
}

/** The kind word the user reads for an entity: the registry label, lowercased
 *  ("line", "arc", "bezier"). Null for a kind the app does not have, so a
 *  caller falls back instead of printing the raw kind string. */
export function entityKindWord(kind: string): string | null {
  return ENTITY_BY_KIND.get(kind)?.label.toLowerCase() ?? null
}

/** A kind word with its indefinite article, `a line` / `an arc`. Null for an
 *  unknown kind. */
export function entityKindPhrase(kind: string): string | null {
  const word = entityKindWord(kind)
  if (word === null) return null
  return `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`
}

/**
 * One entity's name as the user reads it: `line 12`, its 1-based ordinal among
 * the sketch's entities OF THAT KIND in document order. The ordinal is per
 * kind, so adding a circle never renumbers the lines. Null when the id is not
 * in the sketch (a dangling ref) or its kind is unknown; callers then say "the
 * picked entity" rather than fall back to the id, which the user cannot read.
 */
export function entityDisplayName(sketch: SketchNamingSource | undefined, eid: string): string | null {
  if (sketch === undefined) return null
  const entities = sketchEntities(sketch)
  const at = entities.findIndex((entity) => entity.id === eid)
  if (at < 0) return null
  const kind = entities[at].kind
  if (typeof kind !== 'string') return null
  const word = entityKindWord(kind)
  if (word === null) return null
  let ordinal = 0
  for (let i = 0; i <= at; i++) if (entities[i].kind === kind) ordinal++
  return `${word} ${ordinal}`
}

/** The one sentence for a profile pick that encloses nothing, shared by the
 *  chip's refusal and the build's. `subject` is a kind phrase ("a line") at the
 *  chip and a display name ("line 12 of 'Sketch 1'") in the build. */
export function noAreaReason(subject: string): string {
  return `${subject} has no area of its own; pick the area beside it, or a closed curve such as a circle`
}
