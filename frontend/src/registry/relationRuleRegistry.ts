// The relation-rule registry: one table row per relation the hint system can
// draw. The executor in picking/relationHint.ts runs the table; a tree or a
// body never names a relation itself.
//
// To add a relation: add a row here, add a `describe('<id>')` block to the
// registry test, and (if it shows in the viewport) read the new target kind in
// the one viewport consumer that owns it. Nothing else changes.

import type { BodyResult, MateFeature, PartFeature } from '@/types/cad'
import { consumedSketchIds } from '@/utils/query/consumedSketches'
import { featureRefId } from '@/utils/query'
import {
  EMPTY_RELATION_SET,
  buildCreatorIndex,
  featureKindFor,
  type RelationEditor,
  type RelationKind,
  type RelationKindCtx,
  type RelationRuleLike,
  type RelationShow,
} from '@/picking/relationHint'

export interface RelationRule<Ctx> extends RelationRuleLike<Ctx> {
  editor: RelationEditor
  // One line, for the rule's own test and for the docs.
  description: string
}

// ─── part editor context ───

export interface PartRelationCtx extends RelationKindCtx {
  featureById: ReadonlyMap<string, PartFeature>
  // The bare feature id a selected row names (`@ex1` -> `ex1`, a query stays a
  // query). Rules look up their maps by this, never by parsing the selection id.
  featureIdOf: (selectionId: string) => string
  // Query -> creator features, over every body in the store.
  creators: (query: string) => readonly string[]
  // Feature -> the sketch-class features it consumes as profile or path.
  consumedByFeature: ReadonlyMap<string, readonly string[]>
  // Sketch-class feature -> the features consuming it.
  consumersBySketch: ReadonlyMap<string, readonly string[]>
  // Features inside the rollback window. A rolled-back consumer hints nothing.
  activeFeatureIds: ReadonlySet<string>
  // Whether the shown solve still publishes the primitive a query names. A pick
  // hint read against the INPUT body, not the feature's output: a modifier that
  // consumed the edge it was given has nothing left to draw, which is exactly
  // how a built feature and a refused one differ.
  publishesQuery: (query: string) => boolean
  // Feature -> the primitive queries it picked as an edge/face modifier.
  pickedQueriesOf: (featureId: string) => readonly string[]
}

/** A stored ref list, tolerant of the single-string spelling a hand-edited doc
 *  can carry: the relation hint must degrade, not take the page down. */
function refList(ref: readonly string[] | string | undefined): readonly string[] {
  if (Array.isArray(ref)) return ref.filter((q): q is string => typeof q === 'string' && q !== '')
  return typeof ref === 'string' && ref !== '' ? [ref] : []
}

/** The primitive picks a modifier stores: its input geometry, not its output. */
function pickedPrimitiveQueries(feature: PartFeature): readonly string[] {
  // Tolerant of a missing def for the same reason consumedSketches is: a
  // hand-edited kind without its payload degrades to "picked nothing".
  switch (feature.kind) {
    case 'fillet': return refList(feature.fillet?.edges)
    case 'chamfer': return refList(feature.chamfer?.edges)
    case 'shell': return refList(feature.shell?.faces)
    case 'move_face': return refList(feature.move_face?.faces)
    case 'delete_face': return refList(feature.delete_face?.faces)
    default: return []
  }
}

/** Every query a shown body publishes for its own primitives. A pick that is
 *  not here names geometry that no longer exists (consumed by this feature or
 *  gone in a later one), so there is nothing to paint. */
function publishedQueries(bodies: Readonly<Record<string, BodyResult>>): ReadonlySet<string> {
  const out = new Set<string>()
  for (const body of Object.values(bodies)) {
    for (const q of body.edge_queries ?? []) if (q) out.add(q)
    for (const q of body.mesh?.face_queries ?? []) if (q) out.add(q)
  }
  return out
}

export function buildPartRelationCtx(
  features: readonly PartFeature[],
  bodies: Readonly<Record<string, BodyResult>>,
  activeFeatureIds?: ReadonlySet<string>,
  failedPicks: ReadonlySet<string> = EMPTY_RELATION_SET,
): PartRelationCtx {
  const featureById = new Map(features.map(f => [f.id, f] as const))
  const featureKinds = new Map<string, RelationKind>()
  for (const feature of features) {
    const kind = featureKindFor(feature)
    if (kind !== null) featureKinds.set(feature.id, kind)
  }
  const consumedByFeature = new Map<string, readonly string[]>()
  const consumersBySketch = new Map<string, Set<string>>()
  for (const feature of features) {
    const consumed = consumedSketchIds(feature, [...features])
    if (consumed.length === 0) continue
    consumedByFeature.set(feature.id, consumed)
    for (const sketchId of consumed) {
      let consumers = consumersBySketch.get(sketchId)
      if (!consumers) consumersBySketch.set(sketchId, (consumers = new Set()))
      consumers.add(feature.id)
    }
  }
  const pickedByFeature = new Map<string, readonly string[]>()
  for (const feature of features) {
    const picks = pickedPrimitiveQueries(feature)
    if (picks.length > 0) pickedByFeature.set(feature.id, picks)
  }
  const published = publishedQueries(bodies)
  return {
    featureById,
    featureKinds,
    featureIdOf: (selectionId) => featureRefId(selectionId) ?? selectionId,
    creators: buildCreatorIndex(bodies),
    consumedByFeature,
    consumersBySketch: new Map([...consumersBySketch].map(([id, set]) => [id, [...set]] as const)),
    activeFeatureIds: activeFeatureIds ?? new Set(features.map(f => f.id)),
    publishesQuery: (query) => published.has(query),
    pickedQueriesOf: (featureId) => pickedByFeature.get(featureId) ?? [],
    failedPicks,
  }
}

const activeTarget = (id: string, ctx: PartRelationCtx): readonly string[] =>
  ctx.activeFeatureIds.has(id) ? [id] : []

/** The modifier picks of `featureId` that the shown solve still publishes. A
 *  rolled-back modifier hints nothing, and a pick its build consumed no longer
 *  names geometry, so only a refused or still-pending pick is drawn. */
const activePickedQueries = (featureId: string, ctx: PartRelationCtx): readonly string[] => {
  const id = ctx.featureIdOf(featureId)
  if (!ctx.activeFeatureIds.has(id)) return []
  return ctx.pickedQueriesOf(id).filter((query) => ctx.publishesQuery(query))
}

// ─── assembly editor context ───

export interface AssemblyRelationCtx extends RelationKindCtx {
  mates: readonly MateFeature[]
  mateById: ReadonlyMap<string, MateFeature>
}

export function buildAssemblyRelationCtx(mates: readonly MateFeature[]): AssemblyRelationCtx {
  const partHandles = new Set<string>()
  const mateIds = new Set<string>()
  const mateById = new Map<string, MateFeature>()
  for (const { id, mate } of mates) {
    mateIds.add(id)
    mateById.set(id, { id, mate })
    partHandles.add(mate.ref_a.part)
    partHandles.add(mate.ref_b.part)
  }
  return { mates, mateById, featureKinds: undefined, partHandles, mateIds }
}

// ─── part rules ───

export const PART_RULES: readonly RelationRule<PartRelationCtx>[] = [
  {
    id: 'face->creator',
    editor: 'part',
    from: 'face',
    to: 'feature',
    show: ['tree'],
    enabled: true,
    description: 'A selected face marks the feature that created it.',
    related: (query, ctx) => ctx.creators(query),
  },
  {
    id: 'edge->creator',
    editor: 'part',
    from: 'edge',
    to: 'feature',
    show: ['tree'],
    enabled: true,
    description: 'A selected edge marks the feature that created it.',
    related: (query, ctx) => ctx.creators(query),
  },
  {
    id: 'feature->faces',
    editor: 'part',
    from: 'feature',
    to: 'feature',
    show: ['viewport'],
    enabled: true,
    description: 'A selected feature tints every face it created.',
    related: (featureId, ctx) => activeTarget(ctx.featureIdOf(featureId), ctx),
  },
  {
    id: 'feature->picked-edges',
    editor: 'part',
    from: 'feature',
    to: 'edge',
    show: ['viewport'],
    enabled: true,
    paint: 'pick',
    description: 'A selected edge modifier draws the edges it picked that the shown solve still publishes.',
    related: activePickedQueries,
  },
  {
    id: 'feature->picked-faces',
    editor: 'part',
    from: 'feature',
    to: 'face',
    show: ['viewport'],
    enabled: true,
    paint: 'pick',
    description: 'A selected face modifier draws the faces it picked that the shown solve still publishes.',
    related: activePickedQueries,
  },
  {
    id: 'feature->consumed-sketch',
    editor: 'part',
    from: 'feature',
    to: 'sketch',
    show: ['tree', 'viewport'],
    enabled: true,
    description: 'A selected feature marks and draws the sketches it consumes.',
    related: (featureId, ctx) => {
      const id = ctx.featureIdOf(featureId)
      return ctx.activeFeatureIds.has(id) ? ctx.consumedByFeature.get(id) ?? [] : []
    },
  },
  {
    id: 'sketch->consumers',
    editor: 'part',
    from: 'sketch',
    to: 'feature',
    show: ['tree'],
    enabled: true,
    description: 'A selected sketch marks the features that consume it.',
    related: (sketchId, ctx) => {
      const id = ctx.featureIdOf(sketchId)
      return (ctx.consumersBySketch.get(id) ?? []).filter(consumer => ctx.activeFeatureIds.has(consumer))
    },
  },
]

// ─── assembly rules ───

export const ASSEMBLY_RULES: readonly RelationRule<AssemblyRelationCtx>[] = [
  {
    id: 'part->mates',
    editor: 'assembly',
    from: 'part',
    to: 'mate',
    show: ['tree'],
    enabled: true,
    description: 'A selected part marks every mate that references it.',
    related: (handle, ctx) =>
      ctx.mates.filter(({ mate }) => mate.ref_a.part === handle || mate.ref_b.part === handle).map(m => m.id),
  },
  {
    id: 'mate->parts',
    editor: 'assembly',
    from: 'mate',
    to: 'part',
    show: ['tree'],
    enabled: true,
    description: 'A selected mate marks the parts it mates.',
    related: (mateId, ctx) => {
      const found = ctx.mateById.get(mateId)
      return found ? [found.mate.ref_a.part, found.mate.ref_b.part] : []
    },
  },
]

/** Every rule in the registry, for the coverage test. */
export const ALL_RELATION_RULES: readonly RelationRule<PartRelationCtx | AssemblyRelationCtx>[] = [
  ...PART_RULES,
  ...ASSEMBLY_RULES,
]

export type { RelationKind, RelationShow }
