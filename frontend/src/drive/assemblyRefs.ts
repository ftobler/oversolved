// Drive-side mate references: an agent picks geometry on a PART (the same
// opaque queries `select` returns), while a mate stores only the durable
// `{part, anchor, anchor_descriptor}` pair. This module is the one translation
// between the two (D4).
//
// Queries are compared, never parsed: the selector/query grammar belongs to the
// kernel's query engine, so an exact-equality miss is refused with advice to
// re-run `select` rather than guessed at here. A selector is validated by the
// same grammar the part-side `select` tool uses, then compared; it is an
// authoring aid and is never stored.

import type { AssemblyDoc, BodyResult, MateAnchorDescriptor, MateRef } from '@/types/cad'
import type { Anchor, BodyMesh, PartBundle } from '@/kernel/partBundle'
import { selectByPredicate, SelectorError, validateSelector, type Selector } from '@/kernel/select'
import { ASSEMBLY_BUILTIN_ANCHORS, ASSEMBLY_HANDLE } from '@/utils/assemblyBuiltins'
import { findInstance } from '@/utils/assemblyMutations'

/** A mate ref as an agent authors it: a part pick, an anchor id, or the frame.
 *  The selector is raw JSON: it is validated where it is resolved, exactly like
 *  the `select` tool's argument, so the sugar and refusals cannot drift. */
export type DriveMateRef =
  | { part: string; query: string }
  | { part: string; selector: unknown }
  | { part: string; anchor: string }

/**
 * Everything a ref resolve needs about one part instance, built once per memo
 * entry beside the bundle. `byQuery` carries an entry for every query the build
 * emitted, with an empty list for an entity that offers no matable anchor.
 */
export interface PartAnchorIndex {
  anchors: Record<string, Anchor>
  byQuery: Map<string, string[]>
  bodies: Record<string, BodyResult>
}

export type ResolvedDriveRef =
  | { ok: true; ref: MateRef }
  | { ok: false; code: 'unknown-target' | 'unresolved-ref' | 'invalid-ref'; message: string }

/** The failure half: the classification a caller forwards into its own error. */
export type DriveRefFailure = Extract<ResolvedDriveRef, { ok: false }>

const BUILTIN_NAMES = Object.keys(ASSEMBLY_BUILTIN_ANCHORS)

function anchorDescriptor(anchor: Anchor): MateAnchorDescriptor {
  return {
    geom_hash: anchor.geom_hash,
    kind: anchor.kind,
    created_by: anchor.created_by,
    point: anchor.point,
  }
}

// One body's positional join: entity slot i belongs to query i, and the loop is
// bounded by the ENTITY array (never the query array) so a short query array
// cannot drop the tail entities out of the index. An entity with no anchor keeps
// its empty list, which is the "no matable anchor" answer, not a missing query.
function indexBody(
  mesh: BodyMesh,
  result: BodyResult | undefined,
  byQuery: Map<string, string[]>,
): void {
  const join = (
    slots: string[][] | undefined,
    queries: readonly string[] | undefined,
  ): void => {
    if (!slots) return
    for (let i = 0; i < slots.length; i++) {
      const query = queries?.[i]
      if (query === undefined || query === '') continue
      byQuery.set(query, slots[i])
    }
  }
  join(mesh.entityAnchors?.faces, result?.mesh?.face_queries)
  join(mesh.entityAnchors?.edges, result?.edge_queries)
  join(mesh.entityAnchors?.vertices, result?.vertex_queries)
}

/**
 * Build the ref index for one bundle build. `bodies` is the same response the
 * bundle was built from, and its iteration order is the bundle's body order
 * (toPartBundle walks Object.values), so the positional join stays aligned.
 */
export function buildPartAnchorIndex(
  bundle: PartBundle,
  bodies: Record<string, BodyResult>,
): PartAnchorIndex {
  const byQuery = new Map<string, string[]>()
  const bodyResults = Object.values(bodies)
  for (let i = 0; i < bundle.bodies.length; i++) {
    indexBody(bundle.bodies[i], bodyResults[i], byQuery)
  }
  return { anchors: bundle.anchors, byQuery, bodies }
}

function builtinRef(ref: DriveMateRef): ResolvedDriveRef {
  if ('query' in ref || 'selector' in ref) {
    return {
      ok: false,
      code: 'unresolved-ref',
      message: `the assembly frame has only its four built-ins: ${BUILTIN_NAMES.join(', ')}; `
        + 'name one with {part: "__assembly", anchor: <name>}',
    }
  }
  if (!BUILTIN_NAMES.includes(ref.anchor)) {
    return {
      ok: false,
      code: 'unknown-target',
      message: `the assembly frame has no anchor "${ref.anchor}"; use one of ${BUILTIN_NAMES.join(', ')}`,
    }
  }
  return { ok: true, ref: { part: ASSEMBLY_HANDLE, anchor: ref.anchor } }
}

function anchorRef(part: string, id: string, anchor: Anchor): ResolvedDriveRef {
  return { ok: true, ref: { part, anchor: id, anchor_descriptor: anchorDescriptor(anchor) } }
}

function queryRef(part: string, query: string, index: PartAnchorIndex, docId: string): ResolvedDriveRef {
  const ids = index.byQuery.get(query)
  if (ids === undefined) {
    return {
      ok: false,
      code: 'unresolved-ref',
      message: `query not found in part "${docId}"; run select on that part's docHash and pass a query it returned`,
    }
  }
  if (ids.length === 0) {
    return {
      ok: false,
      code: 'unresolved-ref',
      message: 'the entity has no matable anchor (freeform faces and ellipse/spline edges have none)',
    }
  }
  if (ids.length > 1) {
    // One anchor per entity by construction (toPartBundle mints one per
    // element); more than one means the index is corrupt, so fail loud.
    throw new Error(`ref index maps one query to ${ids.length} anchors: ${query}`)
  }
  const anchor = index.anchors[ids[0]]
  if (!anchor) {
    return { ok: false, code: 'unresolved-ref', message: `query "${query}" names anchor ${ids[0]}, which the bundle does not carry` }
  }
  return { ok: true, ref: { part, anchor: ids[0], anchor_descriptor: anchorDescriptor(anchor) } }
}

function selectorQuery(ref: { selector: unknown }, index: PartAnchorIndex): { ok: true; query: string } | ResolvedDriveRef {
  // Structural validation first: the engine only understands vectors, so the
  // letter axis sugar must be expanded here, and a typo must read as a bad
  // ref rather than as a candidate set that happened to project to NaN.
  let selector: Selector
  try {
    selector = validateSelector(ref.selector)
  } catch (e) {
    if (!(e instanceof SelectorError)) throw e
    return { ok: false, code: 'invalid-ref', message: e.message }
  }
  let result: ReturnType<typeof selectByPredicate>
  try {
    result = selectByPredicate(selector, index.bodies)
  } catch (e) {
    // The select engine owns the nearest-miss wording; pass it through.
    return { ok: false, code: 'unresolved-ref', message: e instanceof Error ? e.message : String(e) }
  }
  if (result.queries.length !== 1) {
    const shown = result.queries.slice(0, 4).map(query => `"${query}"`).join(', ')
    return {
      ok: false,
      code: 'unresolved-ref',
      message: `selector matched ${result.queries.length} entities; make it name exactly one`
        + (shown === '' ? '' : ` (first matches: ${shown})`),
    }
  }
  return { ok: true, query: result.queries[0] }
}

/**
 * Resolve one authored ref against the document and the part's build index.
 * `indexFor` returns the index for an instance handle, or the build error that
 * made it unavailable.
 */
export function resolveDriveRef(
  ref: DriveMateRef,
  doc: AssemblyDoc,
  indexFor: (handle: string) => PartAnchorIndex | Error,
): ResolvedDriveRef {
  if (ref.part === ASSEMBLY_HANDLE) return builtinRef(ref)
  const instance = findInstance(doc, ref.part)
  if (!instance) {
    const handles = (doc.features ?? [])
      .filter(f => f.kind === 'part_instance' && f.instance)
      .map(f => f.instance!.handle)
    return {
      ok: false,
      code: 'unknown-target',
      message: `part "${ref.part}" is not an instance of this assembly; instances: ${handles.join(', ') || 'none'}`,
    }
  }
  const index = indexFor(ref.part)
  if (index instanceof Error) {
    return { ok: false, code: 'unresolved-ref', message: `could not build part "${instance.doc_id}": ${index.message}` }
  }
  if ('selector' in ref) {
    const selected = selectorQuery(ref, index)
    if (!('query' in selected)) return selected
    return queryRef(ref.part, selected.query, index, instance.doc_id)
  }
  if ('query' in ref) return queryRef(ref.part, ref.query, index, instance.doc_id)
  const anchor = index.anchors[ref.anchor]
  if (!anchor) {
    return {
      ok: false,
      code: 'unresolved-ref',
      message: `part "${instance.doc_id}" has no anchor "${ref.anchor}"; use a query from select or an anchor id the bundle reports`,
    }
  }
  return anchorRef(ref.part, ref.anchor, anchor)
}
