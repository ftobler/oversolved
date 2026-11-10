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
}

export function buildPartRelationCtx(
  features: readonly PartFeature[],
  bodies: Readonly<Record<string, BodyResult>>,
  activeFeatureIds?: ReadonlySet<string>,
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
  return {
    featureById,
    featureKinds,
    featureIdOf: (selectionId) => featureRefId(selectionId) ?? selectionId,
    creators: buildCreatorIndex(bodies),
    consumedByFeature,
    consumersBySketch: new Map([...consumersBySketch].map(([id, set]) => [id, [...set]] as const)),
    activeFeatureIds: activeFeatureIds ?? new Set(features.map(f => f.id)),
  }
}

const activeTarget = (id: string, ctx: PartRelationCtx): readonly string[] =>
  ctx.activeFeatureIds.has(id) ? [id] : []

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
