// The one relation-hint model: which selected thing a tree row or a viewport
// primitive is related to.
//
// A hint is derived state. It is computed from the editor's selection (and, for
// the pick rules only, the feature whose editor is open) on every read,
// persists nothing, records no undo entry and never writes the selection.
// Three.js-free and React-free, so the whole model is tested without a viewport
// or a mounted tree.
//
// The rules themselves are data in registry/relationRuleRegistry.ts. This file
// owns only the execution of a rule list, the id-kind classifier, and the
// per-body creator index the face/edge hints read. A new relation is one table
// row there, not a new code path here.

import type { BodyResult, Mesh3D, PartFeature } from '@/types/cad'
import { featureRefId, parseQuery } from '@/utils/query'
import { isSubtype } from '@/kernel/queryCoerce'

/** What a driver or a target of a relation is. A rule maps one kind to another. */
export type RelationKind = 'face' | 'edge' | 'feature' | 'sketch' | 'part' | 'mate'

/** The editor a rule belongs to. Two editors, two rule tables, two contexts. */
export type RelationEditor = 'part' | 'assembly'

/** Where the targets show: tree rows, viewport primitives, or both. */
export type RelationShow = 'tree' | 'viewport'

/**
 * How a rule's viewport targets are drawn. `creator` (the default) names a
 * feature whose created primitives tint; `pick` names the query of one
 * primitive the driver feature picked, so a modifier that created nothing can
 * still show where it was meant to apply.
 */
export type RelationPaint = 'creator' | 'pick'

/**
 * The structural half of a rule. The registry's `RelationRule` extends it with
 * an editor, a description and a test-facing identity; the executor needs only
 * these fields, which is what keeps the executor import-free of the registry.
 */
export interface RelationRuleLike<Ctx> {
  id: string
  from: RelationKind
  to: RelationKind
  show: readonly RelationShow[]
  enabled: boolean
  paint?: RelationPaint
  related(driverId: string, ctx: Ctx): Iterable<string>
}

/** What `relationKindOf` can consult to turn an opaque selection id into a kind. */
export interface RelationKindCtx {
  // Feature id -> the kind it selects as. A sketch and a helix select as
  // `sketch`; a datum plane and the origin are deliberately absent so they
  // relate nothing.
  featureKinds?: ReadonlyMap<string, RelationKind>
  // Assembly handles. Their ids are bare (no `@` sigil), so they cannot be
  // confused with a feature reference.
  partHandles?: ReadonlySet<string>
  mateIds?: ReadonlySet<string>
  // Pick queries the last solve resolved but refused. A `paint: 'pick'` rule
  // splits its targets by this, so the viewport can paint the same ones its
  // chip marks red.
  failedPicks?: ReadonlySet<string>
}

/** Shared empty answer. Two callers that find no relation read the same object,
 *  so memos keyed on the set do not re-run on every render. */
export const EMPTY_RELATION_SET: ReadonlySet<string> = new Set<string>()

export interface RelationHints {
  tree: ReadonlySet<string>
  viewport: ReadonlySet<string>
  // Primitives a driver picked that the shown solve still publishes, split by
  // whether that solve refused the pick. A `paint: 'pick'` rule fills these
  // instead of the creator ids, because a pick names one primitive, not a
  // feature whose output on screen can be found by its creator.
  picked: ReadonlySet<string>
  failedPicks: ReadonlySet<string>
}

export const EMPTY_RELATION_HINTS: RelationHints = {
  tree: EMPTY_RELATION_SET,
  viewport: EMPTY_RELATION_SET,
  picked: EMPTY_RELATION_SET,
  failedPicks: EMPTY_RELATION_SET,
}

/**
 * The one classifier every rule trusts. A face or edge is an ancestry query
 * whose type restriction names the family; a feature row is the `@` reference
 * the tree selects with; an assembly part handle or mate id is its bare stored
 * id. Builtins and unknown ids relate nothing in every rule.
 */
export function relationKindOf(id: string, ctx: RelationKindCtx = {}): RelationKind | null {
  if (id.startsWith('?')) {
    try {
      const query = parseQuery(id)
      if (query.kind !== 'ancestry') return null
      const type = query.typeRestriction
      // A sketch-region pick is a flatface query too, so it classifies as a
      // body face here. It is harmless because the creator index is keyed by the
      // body primitives the kernel published, and a sketch region is not one of
      // them; the id simply relates nothing.
      if (type !== null && isSubtype(type, 'face')) return 'face'
      if (type !== null && isSubtype(type, 'edge')) return 'edge'
    } catch {
      // A malformed query names no primitive, so it relates nothing.
    }
    return null
  }
  // `@builtin_origin` and `@builtin_plane_top` are the reference rows: datum
  // geometry is a later relation, not part of this one.
  if (id.startsWith('@builtin_')) return null
  const featureId = featureRefId(id)
  if (featureId !== null) return ctx.featureKinds?.get(featureId) ?? null
  if (ctx.partHandles?.has(id)) return 'part'
  if (ctx.mateIds?.has(id)) return 'mate'
  return null
}

/** The current selection as hint drivers. One builder per editor, so the tree
 *  and the viewport can never read the selection two different ways. Hover is
 *  deliberately not an input: hovering a row or a face drives no hint. */
export function hintDrivers(selection: Iterable<string>): readonly string[] {
  return [...selection]
}

/**
 * Run every enabled rule whose `from` matches each driver's kind and split the
 * answer by where the rule says it shows. Single-hop only: a rule that wants
 * "face -> feature -> its sketch" is a separate rule, so a rule's effect is
 * always readable from its own row.
 *
 * A driver is never its own target: selecting a row marks what it relates, not
 * itself. A driver CAN be marked by another selected driver's rule, which is
 * what keeps `.selected.related` (a party to a relation that is also selected)
 * meaningful.
 *
 * `focus` names a feature the editor is acting on without a selection, e.g. the
 * one whose editor is open. Only `paint: 'pick'` rules run for it: an open
 * editor should show the feature's own picks, not tint every face it created.
 */
export function relatedHints<Ctx extends RelationKindCtx>(
  drivers: readonly string[],
  rules: readonly RelationRuleLike<Ctx>[],
  ctx: Ctx,
  focus: readonly string[] = [],
): RelationHints {
  if (drivers.length === 0 && focus.length === 0) return EMPTY_RELATION_HINTS
  const enabled = rules.filter(rule => rule.enabled)
  if (enabled.length === 0) return EMPTY_RELATION_HINTS

  const failedPicks = ctx.failedPicks ?? EMPTY_RELATION_SET
  let tree: Set<string> | null = null
  let viewport: Set<string> | null = null
  let picked: Set<string> | null = null
  let failed: Set<string> | null = null
  const canonical = (id: string): string => featureRefId(id) ?? id
  for (const [group, isFocus] of [[drivers, false], [focus, true]] as const) {
    for (const driver of group) {
      const kind = relationKindOf(driver, ctx)
      if (kind === null) continue
      for (const rule of enabled) {
        if (rule.from !== kind) continue
        if (isFocus && rule.paint !== 'pick') continue
        for (const target of rule.related(driver, ctx)) {
          if (!target) continue
          const id = canonical(target)
          // Tree rows are selected by their `@<feature>` spelling; an assembly
          // handle or mate id is selected bare. The rule returns the canonical
          // bare id and the executor applies the tree's one spelling. A selected
          // row never marks itself; the viewport may still name its own driver,
          // because a feature's own faces are the hint for that feature.
          if (rule.show.includes('tree') && id !== canonical(driver)) {
            const rowId = rule.to === 'feature' || rule.to === 'sketch' ? `@${id}` : id
            ;(tree ??= new Set()).add(rowId)
          }
          if (!rule.show.includes('viewport')) continue
          if (rule.paint === 'pick') {
            // The viewport keys primitives by their query, so a pick target is
            // the answer itself and needs no creator lookup.
            ;(failedPicks.has(id) ? (failed ??= new Set()) : (picked ??= new Set())).add(id)
          } else {
            // A feature may name itself: its own faces are the hint.
            ;(viewport ??= new Set()).add(id)
          }
        }
      }
    }
  }
  return {
    tree: tree ?? EMPTY_RELATION_SET,
    viewport: viewport ?? EMPTY_RELATION_SET,
    picked: picked ?? EMPTY_RELATION_SET,
    failedPicks: failed ?? EMPTY_RELATION_SET,
  }
}

// ─── the creator index ───
// A face's creator is the feature that minted it, carried by the kernel as
// `face_created_by` (see kernel/occ/tessellation.ts) with the face query's
// ancestry as the recovery path. A face a later feature only modified keeps the
// creator of the operation that made it: the user's rule, and what the kernel's
// owner map already says.

const ANCESTRY_INFRA = (token: string): boolean =>
  token.startsWith('u|') ||
  token.startsWith('body_') ||
  token.startsWith('cls_') ||
  token.startsWith('builtin_')

/** The feature named by the first bare `@<id>` ancestry token of a query. */
export function creatorOfQuery(query: string | undefined): string | null {
  if (!query) return null
  try {
    const parsed = parseQuery(query)
    if (parsed.kind !== 'ancestry') return null
    for (const raw of parsed.ancestorIds) {
      if (!raw.startsWith('@')) continue
      const id = raw.slice(1)
      if (!id || id.includes('/') || ANCESTRY_INFRA(id)) continue
      return id
    }
  } catch {
    // A query the codec cannot read names no creator; the caller falls back.
  }
  return null
}

/**
 * The creator of every face of `mesh`, aligned with the face index list the
 * viewport paints. `face_created_by` wins when it is present and aligned; a
 * missing or misaligned array falls back per face to the query's lineage and
 * then to the body's creator, so the fallback can never be one entry off.
 */
export function faceCreatorsOf(
  mesh: Mesh3D | undefined,
  bodyCreatedBy: string,
  faceCount?: number,
): readonly string[] {
  if (!mesh) return []
  const queries = mesh.face_queries ?? []
  const count = faceCount ?? Math.max(queries.length, mesh.face_data?.length ?? 0)
  if (count === 0) return []
  const supplied = mesh.face_created_by
  const aligned = supplied !== undefined && supplied.length === count
  const out = new Array<string>(count)
  for (let i = 0; i < count; i++) {
    out[i] = (aligned ? supplied[i] : '') || creatorOfQuery(queries[i]) || bodyCreatedBy
  }
  return out
}

/** The same recovery for a body's edges, aligned with `edge_queries`. */
export function edgeCreatorsOf(body: BodyResult): readonly string[] {
  const count = Math.max(body.edge_queries?.length ?? 0, body.edges?.length ?? 0)
  if (count === 0) return []
  const supplied = body.edge_created_by
  const aligned = supplied !== undefined && supplied.length === count
  const out = new Array<string>(count)
  for (let i = 0; i < count; i++) {
    out[i] = (aligned ? supplied[i] : '') || creatorOfQuery(body.edge_queries?.[i]) || body.created_by
  }
  return out
}

/**
 * Query -> every feature recorded as its creator across the store's bodies.
 * Built once per `bodies` reference by the editor context, so a rule never
 * builds its own index. A query shared by primitives with different creators
 * answers all of them, never an arbitrary one.
 */
export function buildCreatorIndex(
  bodies: Readonly<Record<string, BodyResult>>,
): (query: string) => readonly string[] {
  const index = new Map<string, Set<string>>()
  const add = (query: string | undefined, creator: string): void => {
    if (!query || !creator) return
    let creators = index.get(query)
    if (!creators) index.set(query, (creators = new Set()))
    creators.add(creator)
  }
  for (const body of Object.values(bodies)) {
    const faceQueries = body.mesh?.face_queries ?? []
    const faceCreators = faceCreatorsOf(body.mesh, body.created_by, faceQueries.length)
    faceCreators.forEach((creator, i) => add(faceQueries[i], creator))
    const edgeQueries = body.edge_queries ?? []
    const edgeCreators = edgeCreatorsOf(body)
    edgeCreators.forEach((creator, i) => add(edgeQueries[i], creator))
  }
  return (query) => {
    const creators = index.get(query)
    return creators ? [...creators] : []
  }
}

/**
 * Per-body hint flags, mirroring `HighlightIndex`: a feature id -> indices map
 * plus a shared all-false answer by reference. A body owning none of the hinted
 * features answers `none` without walking its primitives, so a row selection
 * leaves every unrelated body's paint memo identity-stable.
 */
export class HintIndex {
  readonly none: readonly boolean[]
  private readonly byFeature = new Map<string, number[]>()

  constructor(creators: readonly string[]) {
    this.none = new Array<boolean>(creators.length).fill(false)
    creators.forEach((creator, i) => {
      if (!creator) return
      let indices = this.byFeature.get(creator)
      if (!indices) this.byFeature.set(creator, (indices = []))
      indices.push(i)
    })
  }

  compute(hintedFeatureIds: ReadonlySet<string>): readonly boolean[] {
    if (hintedFeatureIds.size === 0 || this.byFeature.size === 0) return this.none
    let intersects = false
    for (const id of hintedFeatureIds) {
      if (this.byFeature.has(id)) { intersects = true; break }
    }
    if (!intersects) return this.none
    const out = new Array<boolean>(this.none.length).fill(false)
    for (const id of hintedFeatureIds) {
      const indices = this.byFeature.get(id)
      if (indices) for (const i of indices) out[i] = true
    }
    return out
  }
}

/** The feature id a part feature selects as, for the kind classifier. */
export function featureKindFor(feature: PartFeature): RelationKind | null {
  if (feature.kind === 'sketch' || feature.kind === 'helix') return 'sketch'
  if (feature.kind === 'origin' || feature.kind === 'plane') return null
  return 'feature'
}
