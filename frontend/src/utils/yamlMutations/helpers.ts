import type { PartDoc, PartFeature, PartConstraint, PartEntityDef, PartTarget, SketchFeature } from '@/types/cad'
import { VERTEX_POINT_KEYS } from '@/types/vertexKeys'
import { selectionToQuery, parseSelectionId, stripSelectionWrapper } from '@/utils/query/selectionId'
import { emitWire } from '@/utils/query'
import { failLoud } from '@/utils/invariants'

// The optional chain is the repo-wide rule for import.meta.env (see
// deployBase.test.ts): this module loads under plain Node through the fuzz
// child and the document test fixtures, where import.meta.env is undefined.
export const warn = import.meta.env?.DEV ? (...args: unknown[]) => console.warn(...args) : () => undefined

export const round = (v: number) => Math.round(v * 1e6) / 1e6

/** Boundary gate for every coordinate tuple a mutation persists. round(NaN) is
 *  still NaN and Math.min/max propagate it, so the clamps and rounds downstream
 *  are not gates themselves: a non-finite number has to be refused where it
 *  enters the document, or it survives into the YAML and every later solve. */
export const allFinite = (vs: readonly number[]) => vs.every(v => Number.isFinite(v))

export function findFeature(doc: PartDoc, featureId: string): PartFeature | undefined {
  return doc.features?.find(f => f.id === featureId)
}

/** Find a feature and require it to be a sketch. Sketch mutations address the
 *  sketch's entity/constraint containers, which no other kind carries; a stale
 *  id that names some other feature must bail like a missing one rather than
 *  write sketch fields onto it. */
export function findSketchFeature(doc: PartDoc, featureId: string): SketchFeature | undefined {
  const feature = findFeature(doc, featureId)
  return feature?.kind === 'sketch' ? feature : undefined
}

/** The three lazily-created containers of a sketch feature. A feature straight out
 *  of YAML may be missing any of them, so every mutation that writes one has to
 *  materialize it first. */
export type SketchLists = {
  entities: PartEntityDef[]
  initial: Record<string, number[]>
  constraints: PartConstraint[]
}

/** Find a sketch feature and materialize exactly the containers named in `lists`,
 *  returning it narrowed so the mutation body can index them without a `!` per
 *  line. Which containers get created is per call rather than all three always:
 *  an unrequested `constraints: []` would show up in the serialized document.
 *
 *  A missing feature yields undefined and every mutation below bails on it -- a
 *  stale feature id from the UI is not an error, the feature was just deleted.
 *
 *  Pass string LITERALS. A union-typed argument (`which: 'entities' | 'initial'`)
 *  infers K as the whole union, so the return type would claim both containers
 *  while only one was created. Every caller today passes literals. */
export function resolveSketch<K extends keyof SketchLists>(
  doc: PartDoc,
  featureId: string,
  ...lists: K[]
): (SketchFeature & Pick<SketchLists, K>) | undefined {
  const feature = findSketchFeature(doc, featureId)
  if (!feature) return undefined
  for (const list of lists) {
    if (list === 'entities') {
      if (!feature.entities) feature.entities = []
    } else if (list === 'initial') {
      if (!feature.initial) feature.initial = {}
    } else if (list === 'constraints') {
      if (!feature.constraints) feature.constraints = []
    } else {
      // Exhaustive by construction: a container added to SketchLists without a
      // branch here would be asserted present by the cast below and materialized
      // by nobody. Fail at the type level rather than at the first index.
      const unhandled: never = list
      throw new Error(`resolveSketch: unhandled container ${String(unhandled)}`)
    }
  }
  return feature as SketchFeature & Pick<SketchLists, K>
}

/** Convert a selection ID to a query string.
 *  If the target belongs to a different feature than the host, use `@<featId>/<eleId>[/<sub>]`
 *  (absolute ref, slash-joined). Otherwise use `$<eleId>` (local ref).
 *  For `face:`/`edge:` IDs, returns the raw ancestry query verbatim (already globally scoped).
 *
 *  entity/vertex IDs are serialized through the query engine (selectionToQuery +
 *  emitWire) rather than hand-built here, so the `@`/`$` wire format lives in one
 *  place (kernel/query.ts, re-exported by utils/query). face/edge wrappers and the
 *  lenient `@`/`$` fallbacks are stripped through the shared wrapper stripper
 *  (selectionId.ts stripSelectionWrapper) rather than a hand-rolled split.
 *
 *  An input that already carries the `$` local prefix is passed through
 *  unchanged, so re-running a persisted local ref through parseTarget is a
 *  no-op rather than a double-`$` corruption. */
export const parseTarget = (t: string, hostFeatureId: string): PartTarget => {
  if (t.startsWith('entity:') || t.startsWith('vertex:')) {
    return emitWire(selectionToQuery(parseSelectionId(t), hostFeatureId))
  }
  if (t.startsWith('face:') || t.startsWith('edge:')) return stripSelectionWrapper(t)
  if (t.startsWith('@')) return t  // builtin/absolute query, pass through as-is
  if (t.startsWith('$')) return t  // already a host-local wire ref; re-targeting a stored ref must not add a second $
  return '$' + t
}

// Generate a random base64url ID.  bytes=12 for elements, bytes=18 for features.
function cryptoRandomId(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

/** The minted-id source. The app leaves this at the crypto default; the drive
 *  CLI and journal replay install a seeded source so the ids a mutation handler
 *  mints internally (add_rect, add_ngon, uniqueConstraintId) come out the same
 *  on every run. A null source restores the crypto default. */
export type IdSource = (bytes: number) => string

let idSource: IdSource | null = null

export function setIdSource(source: IdSource | null): void {
  idSource = source
}

export function getIdSource(): IdSource | null {
  return idSource
}

// The ids the document the current apply starts from already holds, plus every
// id minted since the scope opened. A source whose sequence restarts (a replayed
// or re-seeded generation) can then never hand out an id the document already
// carries: the mint is skipped and the next one drawn. The session installs a
// scope around each apply and restores the previous one after; outside an apply
// (the app's UI mints) there is none.
let idScope: Set<string> | null = null

const MAX_ID_REDRAWS = 64

/** Install the minted-id scope for one apply, returning the previous one so a
 *  nested caller can restore it. */
export function setIdScope(scope: Set<string> | null): Set<string> | null {
  const previous = idScope
  idScope = scope
  return previous
}

export function randomId(bytes: number): string {
  const mint = idSource ?? cryptoRandomId
  const scope = idScope
  if (!scope) return mint(bytes)
  let id = mint(bytes)
  // Bounded: a source that cannot produce a fresh id (a broken double, a
  // sequence whose whole space is taken) must not spin the apply forever, so
  // past the bound the collision is reported instead of hanging.
  let redraws = 0
  while (scope.has(id) && redraws < MAX_ID_REDRAWS) {
    id = mint(bytes)
    redraws++
  }
  if (scope.has(id)) {
    // The minted id still collides, so the scope guarantee is broken. Report it
    // (throws in test, warns in dev, silent in production) and return it anyway:
    // an exhausted id space must not abort an apply in production.
    failLoud(`randomId: minted id ${id} still collides after ${MAX_ID_REDRAWS} redraws`)
  }
  scope.add(id)
  return id
}

export function uniqueConstraintId(constraints: PartConstraint[], kind: string): string {
  const existing = new Set(constraints.map(c => c.id))
  let id = `c_${kind}_${randomId(6)}`
  while (existing.has(id)) id = `c_${kind}_${randomId(6)}`
  return id
}

/** `count` fresh entity ids, colliding with neither an existing entity nor each
 *  other. The sugar mutations mint their whole run up front because they need the
 *  ids as an array before the push loop is written -- a rectangle names all four
 *  lines while constraining them to one another. Callers that push each entity as
 *  they go want `mintEntityId` against the live list instead. */
export function freshEntityIds(entities: PartEntityDef[], count: number): string[] {
  const existing = new Set(entities.map(e => e.id))
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    let id = randomId(12)
    while (existing.has(id)) id = randomId(12)
    existing.add(id)
    ids.push(id)
  }
  return ids
}

/** The id for one new entity. A supplied `given` is taken verbatim, NOT re-rolled:
 *  a caller only supplies one when it must reference the entity right away (the
 *  dimension tool targets the projection it makes in the same click), and a
 *  re-roll would orphan the reference it already holds. So a supplied id must
 *  already be unique within the feature. */
export function mintEntityId(entities: PartEntityDef[], given?: string): string {
  return given ?? freshEntityIds(entities, 1)[0]
}

// Coerce a feature ref field (single query, list, or empty) into a query list.
export function normalizeRefList(ref: string | string[] | undefined): string[] {
  if (Array.isArray(ref)) return ref
  return ref ? [ref] : []
}

// Constraint fields that can carry an entity ref. Deletion GC (sketch.ts) and
// solve-result cleanup (solveResult.ts) must agree on what names an entity, so
// the key list lives here rather than as two hand-maintained copies.
export const CONSTRAINT_REF_FIELDS: (keyof PartConstraint)[] = [
  'target', 'a', 'b', 'line', 'arc', 'point', 'point_a', 'point_b',
]

// True when a stored wire-format ref addresses entityId: either the bare form
// `$<eid>` or a vertex sub-point `$<eid><vertexKey>`. Exact-or-known-suffix,
// not startsWith -- ids are random base64url so prefixes never collide in
// practice, but hand-authored YAML and human-readable fixture ids ($l10 vs $l1)
// do. Cross-sketch `@` refs and non-ref strings never match.
export function refMatchesEntity(ref: unknown, entityId: string): boolean {
  if (typeof ref !== 'string' || !ref.startsWith('$')) return false
  const bare = ref.slice(1)
  if (bare === entityId) return true
  if (!bare.startsWith(entityId)) return false
  return (VERTEX_POINT_KEYS as readonly string[]).includes(bare.slice(entityId.length))
}
