// The instance pattern leaf: copy the source onto a sketch's points, or onto a
// picked list of any target, under `normal` (the default) or `fixed`
// orientation. The placement law is pure in instancePatternPlacement.ts; here
// the sketch site rule, the picks, the reference point and the source normal
// are resolved.
//
// Targets. The sketch form reads the same non-construction point rule the hole
// drills (shared/sketchPointSites.ts), so construction points are skipped, line
// endpoints are not targets and projected points count. The targets form takes
// any pick the table in features/shared/pickTarget.ts accepts. Numbering is
// 1..N in sketch entity order or list order, so `skip 2` is the second target;
// the naming key is the target's entity id (sketch form) or a short hash of
// the pick (targets form), so deleting an earlier point never renames a later
// copy's faces.
//
// Reference. A `reference` pick wins; else a feature subject whose first
// source's profile sketch holds exactly one non-construction point uses that
// point; else the seed's volume centroid. Source normal: the reference's
// normal, else the first source's sketch plane normal, else the first target
// that carries one (so that copy is a pure translation and the rest turn
// relative to it). `reverse_normal` flips the target normals, not the source.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import type { Repository } from '../query'
import { solidCentroid } from '../occ/primitives'
import { makeRigidTrsf } from '../occ/transforms'
import { resolveSketchPlane } from './postRegister'
import { sketchToWorld2d, type PlaneLike } from './shared/planes'
import { INSTANCE_SITE_WORDING } from './shared/drillSite'
import { sketchPointSites } from './shared/sketchPointSites'
import {
  axisSenseContext, faceIndexCache, resolvePickTarget, type PickTarget, type PickTargetContext,
} from './shared/pickTarget'
import { firstSourceToolCentroid } from './patternFeature'
import { resolvePatternSourceBody } from './patternBody'
import { instanceTotalProblem, toInstances } from './patternInstances'
import {
  keptInstances, solvePatternInstances, type Dict, type PatternCopy,
} from './pattern'
import type { PatternResult } from './patternFeature'
import type { BodyPatternResult } from './patternBody'
import {
  perpendicularTo, placeOnTargets, type InstanceOrientation, type Vec3,
} from './instancePatternPlacement'

type SourceNormalRule = 'reference' | 'sketch plane' | 'first target' | 'none'

function stripSigil(ref: string): string {
  return ref.replace(/^[@$]/, '')
}

/** The feature refs of a pattern's sources, in the authored order. */
function sourceRefsOf(sub: Dict): string[] {
  const list = sub.source_features
  if (Array.isArray(list)) return list.filter((ref): ref is string => typeof ref === 'string' && ref !== '')
  const single = sub.source_feature
  return typeof single === 'string' && single !== '' ? [single] : []
}

/** The first source feature that exists and sits before this pattern, the one
 *  `patternFeature.ts` heads its union with. */
function firstSource(featureId: string, sub: Dict, featuresById: Record<string, Dict>): Dict | null {
  // Feature-log order, not list order: the pattern leaf unions its sources in
  // the log's order, so the reference and the source normal follow the same
  // source the copies do.
  const order = Object.keys(featuresById)
  const at = order.indexOf(featureId)
  let best: { id: string; at: number; source: Dict } | null = null
  for (const ref of sourceRefsOf(sub)) {
    const id = stripSigil(ref)
    const source = featuresById[id]
    if (source === undefined) continue
    const position = order.indexOf(id)
    if (at >= 0 && position > at) continue
    if (best === null || position < best.at) best = { id, at: position, source }
  }
  return best?.source ?? null
}

/** The first profile sketch a source feature names, when it names one. */
function profileSketchOf(source: Dict, featuresById: Record<string, Dict>): Dict | null {
  const kind = String(source.kind ?? '')
  const sub = (source[kind] as Dict | undefined) ?? {}
  const raw = sub.sketch
  const refs = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  for (const ref of refs) {
    if (typeof ref !== 'string' || ref === '') continue
    const id = stripSigil(ref).split('/')[0]
    const sketch = featuresById[id]
    if (sketch !== undefined && sketch.kind === 'sketch') return sketch
  }
  return null
}

interface SketchPoint {
  entityId: string
  point: Vec3
  plane: PlaneLike
}

/** The non-construction points of a sketch, in entity order, solved. */
function sketchPoints(sketchId: string, sketch: Dict, globalRepo: Repository): SketchPoint[] {
  const entities = (sketch.entities as Dict[] | undefined) ?? []
  const sites = sketchPointSites(entities, sketchId, INSTANCE_SITE_WORDING)
  const initial = (sketch.initial as Record<string, number[]> | undefined) ?? {}
  const solved = globalRepo.elements.get('_pt_' + sketchId) as PlaneLike | undefined
  const plane = solved ?? resolveSketchPlane(sketch.plane as string | undefined, globalRepo) as PlaneLike
  const out: SketchPoint[] = []
  for (const site of sites) {
    const id = String(site.id ?? '')
    const params = initial[id]
    if (params === undefined) continue
    out.push({ entityId: id, point: sketchToWorld2d([params[0] ?? 0, params[1] ?? 0], plane) as Vec3, plane })
  }
  return out
}

/** The one non-construction point a source's profile sketch holds, when it
 *  holds exactly one. */
function singleProfilePoint(
  source: Dict | null,
  globalRepo: Repository,
  featuresById: Record<string, Dict>,
): SketchPoint | null {
  if (source === null) return null
  const sketch = profileSketchOf(source, featuresById)
  if (sketch === null) return null
  const id = String(sketch.id ?? '')
  const entities = (sketch.entities as Dict[] | undefined) ?? []
  const points = entities.filter((entity) => entity.kind === 'point' && entity.construction !== true)
  if (points.length !== 1) return null
  const sites = sketchPoints(id, sketch, globalRepo)
  return sites.length === 1 ? sites[0] : null
}

interface ResolvedTargets {
  targets: PickTarget[]
  warnings: string[]
}

/** The sketch form's targets: one per non-construction point, keyed by entity. */
function sketchTargets(sketchId: string, sketch: Dict, globalRepo: Repository): ResolvedTargets {
  const points = sketchPoints(sketchId, sketch, globalRepo)
  // An unsolved sketch has no plane to take a normal from; the caller refuses
  // the empty list below before the normal is ever read.
  const raw = points.length === 0 ? [0, 0, 1] : points[0].plane.normal
  const len = Math.hypot(...raw)
  const normal = (len < 1e-12 ? [0, 0, 1] : raw.map((n) => n / len)) as Vec3
  return {
    targets: points.map((p) => ({ key: p.entityId, label: p.entityId, point: p.point, normal })),
    warnings: [],
  }
}

/** The targets form: every pick the table accepts, in list order. A pick that
 *  resolves to nothing is dropped with a warning naming it. */
function pickedTargets(refs: readonly string[], ctx: PickTargetContext): ResolvedTargets {
  const sense = axisSenseContext(ctx)
  const indexFor = faceIndexCache(ctx)
  const targets: PickTarget[] = []
  const warnings: string[] = []
  for (const ref of refs) {
    const target = resolvePickTarget(ctx, ref, sense, indexFor)
    if (target === null) {
      warnings.push(`instance_pattern: target '${ref}' did not resolve to a point; it was dropped`)
      continue
    }
    targets.push(target)
  }
  return { targets, warnings }
}

/** The reference the copies are measured from, with the normal it carries. */
interface ReferencePoint {
  point: Vec3
  normal: Vec3 | null
  rule: string
}

function targetRefs(sub: Dict): string[] {
  const raw = sub.targets
  return Array.isArray(raw) ? raw.filter((ref): ref is string => typeof ref === 'string' && ref !== '') : []
}

function resolvedReference(
  sub: Dict,
  featureId: string,
  ctx: PickTargetContext,
  targets: readonly PickTarget[],
  subject: string,
  sketchPoint: SketchPoint | null,
  solveContext: { variables: Record<string, number>; laterVariables: Record<string, number> },
): ReferencePoint {
  const sense = axisSenseContext(ctx)
  const indexFor = faceIndexCache(ctx)
  const ref = typeof sub.reference === 'string' ? sub.reference : ''
  if (ref !== '') {
    const picked = resolvePickTarget(ctx, ref, sense, indexFor)
    if (picked === null) throw new Error(`instance_pattern: reference '${ref}' did not resolve to a point`)
    return { point: picked.point, normal: picked.normal, rule: 'the reference pick' }
  }
  if (sketchPoint !== null) {
    const len = Math.hypot(...sketchPoint.plane.normal)
    return {
      point: sketchPoint.point,
      normal: len < 1e-12 ? null : sketchPoint.plane.normal.map((n) => n / len) as Vec3,
      rule: 'the source sketch\'s only point',
    }
  }
  if (subject === 'body') {
    const body = resolvePatternSourceBody(sub, ctx.bodyStore)
    const shape = ctx.table.get<OccShape>(body.shape!)
    return { point: solidCentroid(ctx.oc, ctx.scope, shape) as Vec3, normal: null, rule: 'the source body\'s centroid' }
  }
  const centroid = firstSourceToolCentroid(
    ctx.oc, ctx.scope, ctx.table,
    { id: featureId }, sub, ctx.globalRepo, ctx.bodyStore, ctx.featuresById, solveContext,
  )
  if (centroid === null) {
    const first = targets[0]
    if (first === undefined) throw new Error('instance_pattern: no target and no source geometry to measure from')
    return { point: first.point, normal: first.normal, rule: 'the first target' }
  }
  return { point: centroid as Vec3, normal: null, rule: 'the source tool\'s centroid' }
}

/** The source normal, first rule that applies. */
function sourceNormalOf(
  reference: ReferencePoint,
  subject: string,
  source: Dict | null,
  targets: readonly PickTarget[],
  globalRepo: Repository,
  featuresById: Record<string, Dict>,
): { normal: Vec3 | null; rule: SourceNormalRule; sourceX: Vec3 | null } {
  if (reference.normal !== null) {
    return { normal: reference.normal, rule: 'reference', sourceX: null }
  }
  if (subject === 'feature' && source !== null) {
    const sketch = profileSketchOf(source, featuresById)
    if (sketch !== null) {
      const sketchId = String(sketch.id ?? '')
      const solved = globalRepo.elements.get('_pt_' + sketchId) as PlaneLike | undefined
      const plane = solved ?? resolveSketchPlane(sketch.plane as string | undefined, globalRepo) as PlaneLike
      const len = Math.hypot(...plane.normal)
      if (len > 1e-12) {
        return {
          normal: plane.normal.map((n) => n / len) as Vec3,
          rule: 'sketch plane',
          sourceX: [...plane.x_axis] as Vec3,
        }
      }
    }
  }
  for (const target of targets) {
    if (target.normal !== null) return { normal: target.normal, rule: 'first target', sourceX: null }
  }
  return { normal: null, rule: 'none', sourceX: null }
}

export interface InstancePatternOutcome {
  copies: PatternCopy[]
  warnings: string[]
  labels: string[]
  // The target list length, the source's own slot and skips included.
  targetCount: number
  orientation: InstanceOrientation
  sourceRule: SourceNormalRule
  referenceRule: string
}

/** Build the copies a `instance_pattern` feature generates. */
export function buildInstancePatternCopies(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  featureId: string,
  sub: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
  featuresById: Record<string, Dict>,
  solveContext: { variables: Record<string, number>; laterVariables: Record<string, number> },
): InstancePatternOutcome {
  const sketchRef = typeof sub.sketch === 'string' && sub.sketch !== '' ? sub.sketch : ''
  const refs = targetRefs(sub)
  if (sketchRef !== '' && refs.length > 0) {
    throw new Error('instance_pattern: set either sketch or targets, not both; keep one target form')
  }
  if (sketchRef === '' && refs.length === 0) {
    throw new Error('instance_pattern: requires a sketch or a list of targets')
  }

  const ctx: PickTargetContext = { oc, scope, table, globalRepo, bodyStore, featuresById }
  const subject = (sub.subject as string) ?? 'body'
  const source = subject === 'feature' ? firstSource(featureId, sub, featuresById) : null

  let resolved: ResolvedTargets
  let sketchPoint: SketchPoint | null = null
  if (sketchRef !== '') {
    const sketchId = stripSigil(sketchRef).split('/')[0]
    const sketch = featuresById[sketchId]
    if (sketch === undefined || sketch.kind !== 'sketch') {
      throw new Error(`instance_pattern: sketch '${sketchRef}' does not resolve to a sketch`)
    }
    try {
      resolved = sketchTargets(sketchId, sketch, globalRepo)
    } catch (e) {
      // The shared site rule's sentences are the hole's own; this leaf names
      // itself in front, the way the hole leaf does.
      throw new Error(`instance_pattern: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (resolved.targets.length === 0) {
      throw new Error(`instance_pattern: sketch '${sketchId}' has no non-construction point to copy onto`)
    }
  } else {
    resolved = pickedTargets(refs, ctx)
    if (resolved.targets.length === 0) {
      throw new Error(`instance_pattern: no target resolved; ${resolved.warnings.join('; ') || 'the list is empty'}`)
    }
  }
  sketchPoint = singleProfilePoint(source, globalRepo, featuresById)

  const cap = instanceTotalProblem(resolved.targets.length)
  if (cap !== null) throw new Error(`instance_pattern: ${cap}`)
  const generated = toInstances(resolved.targets.map((_, i) => i + 1))
  const { kept, warnings } = keptInstances(generated, sub, resolved.targets.length, 'the target list')

  const keptTargets = kept.map((instance) => resolved.targets[Number(instance.index) - 1])
  const reference = resolvedReference(sub, featureId, ctx, resolved.targets, subject, sketchPoint, solveContext)
  const sourceNormal = sourceNormalOf(reference, subject, source, keptTargets, globalRepo, featuresById)
  const orientation: InstanceOrientation = sub.orientation === 'fixed' ? 'fixed' : 'normal'
  const placed = placeOnTargets({
    reference: reference.point,
    sourceNormal: orientation === 'normal' ? sourceNormal.normal : null,
    sourceX: sourceNormal.sourceX ?? (sourceNormal.normal === null ? null : perpendicularTo(sourceNormal.normal)),
    targets: keptTargets,
    orientation,
    reverseNormal: sub.reverse_normal === true,
  })

  const copies: PatternCopy[] = placed.placements.map((placement) => ({
    key: placement.key,
    trsf: makeRigidTrsf(oc, scope, placement.transform),
  }))
  return {
    copies,
    warnings: [...resolved.warnings, ...warnings],
    labels: resolved.targets.map((target, i) => `${i + 1} = ${target.label}`),
    targetCount: resolved.targets.length,
    orientation,
    sourceRule: sourceNormal.rule,
    referenceRule: reference.rule,
  }
}

/** The `instance_pattern` leaf entry. */
export function solveInstancePattern(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Dict,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
  featuresById: Record<string, Dict> = {},
  solveContext: { variables: Record<string, number>; laterVariables: Record<string, number> } = {
    variables: {}, laterVariables: {},
  },
): PatternResult | BodyPatternResult {
  const featureId = (feature.id as string) ?? ''
  const sub = (feature.instance_pattern as Dict) ?? {}
  const built: { value: InstancePatternOutcome | null } = { value: null }
  const result = solvePatternInstances(
    oc, scope, table, feature, sub, globalRepo, bodyStore, featuresById, solveContext,
    () => {
      const outcome = buildInstancePatternCopies(
        oc, scope, table, featureId, sub, globalRepo, bodyStore, featuresById, solveContext,
      )
      built.value = outcome
      return { copies: outcome.copies, warnings: outcome.warnings }
    },
  )
  const outcome = built.value
  if (outcome !== null) {
    // The editor hint and a headless report both read these: which target each
    // number names, what orientation was used, and which rule supplied the
    // source normal.
    result.resolved_targets = outcome.labels
    result.orientation = outcome.orientation
    result.source_normal_rule = outcome.sourceRule
    result.reference_rule = outcome.referenceRule
    result.target_count = outcome.targetCount
  }
  return result
}
