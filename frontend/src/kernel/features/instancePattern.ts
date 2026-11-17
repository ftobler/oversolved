// The instance pattern leaf: copy the source onto a list of points, under
// `normal` (the default) or `fixed` orientation. The placement law is pure in
// instancePatternPlacement.ts; here the sketch site rule, the picks, the
// reference point and the source normal are resolved.
//
// Targets. One list. A ref that names a sketch feature expands in place to that
// sketch's non-construction points, the same rule the hole drills
// (shared/sketchPointSites.ts), so construction points are skipped, line
// endpoints are not targets and projected points count. Every other ref is a
// pick the table in features/shared/pickTarget.ts accepts. Numbering is 1..N in
// list order with each sketch expanded where it stands, so `skip 2` is the
// second target; the naming key is the target's entity id or a short hash of
// the pick, so deleting an earlier point never renames a later copy's faces. A
// point reached twice (a sketch row plus one of its own point picks, or the
// same pick twice) is kept once with a warning naming the dropped row.
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

/** A sketch row's targets: one per non-construction point, keyed by entity. */
function sketchTargets(sketchId: string, sketch: Dict, globalRepo: Repository): ResolvedTargets {
  const points = sketchPoints(sketchId, sketch, globalRepo)
  // An unsolved sketch has no plane to take a normal from; the caller drops the
  // empty list below before the normal is ever read.
  const raw = points.length === 0 ? [0, 0, 1] : points[0].plane.normal
  const len = Math.hypot(...raw)
  const normal = (len < 1e-12 ? [0, 0, 1] : raw.map((n) => n / len)) as Vec3
  return {
    targets: points.map((p) => ({
      key: p.entityId,
      label: p.entityId,
      point: p.point,
      normal,
      identity: `${sketchId}:${p.entityId}`,
    })),
    warnings: [],
  }
}

/** The sketch feature a plain target ref names, or null for every other pick.
 *  A sketch row is written bare or `@`-prefixed; a `/` makes it one of the
 *  sketch's entities, which the pick table reads instead. */
function sketchRow(ref: string, featuresById: Record<string, Dict>): { id: string; sketch: Dict } | null {
  const id = ref.replace(/^@/, '')
  if (id === '' || id.includes('/')) return null
  const sketch = featuresById[id]
  return sketch !== undefined && sketch.kind === 'sketch' ? { id, sketch } : null
}

function samePoint(a: Vec3, b: Vec3): boolean {
  return Math.abs(a[0] - b[0]) <= 1e-9
    && Math.abs(a[1] - b[1]) <= 1e-9
    && Math.abs(a[2] - b[2]) <= 1e-9
}

/** Whether two targets reached the same place. A sketch entity's identity is
 *  authoritative when both carry one (two sketches may share an entity id); a
 *  body pick has no identity, so its position decides. */
function sameTarget(a: PickTarget, b: PickTarget): boolean {
  if (a.identity !== undefined && b.identity !== undefined) return a.identity === b.identity
  return samePoint(a.point, b.point)
}

/** The target list: a sketch row expands to its points where it stands, every
 *  other ref is one pick the table accepts, and a point reached twice is kept
 *  once. Every dropped row earns a warning naming it. */
function pickedTargets(refs: readonly string[], ctx: PickTargetContext): ResolvedTargets {
  const sense = axisSenseContext(ctx)
  const indexFor = faceIndexCache(ctx)
  const candidates: { target: PickTarget; name: string }[] = []
  const warnings: string[] = []
  for (const ref of refs) {
    const row = sketchRow(ref, ctx.featuresById)
    if (row !== null) {
      let expanded: PickTarget[] = []
      try {
        expanded = sketchTargets(row.id, row.sketch, ctx.globalRepo).targets
      } catch {
        // The shared site rule names the hole's remedy, which is not this
        // leaf's: a sketch row with no point is one dropped target among many.
      }
      if (expanded.length === 0) {
        warnings.push(`instance_pattern: target '${ref}' did not resolve to a point; it was dropped`)
        continue
      }
      for (const target of expanded) {
        candidates.push({ target, name: `entity:${row.id}:${target.key}` })
      }
      continue
    }
    const target = resolvePickTarget(ctx, ref, sense, indexFor)
    if (target === null) {
      warnings.push(`instance_pattern: target '${ref}' did not resolve to a point; it was dropped`)
      continue
    }
    candidates.push({ target, name: ref })
  }
  const targets: PickTarget[] = []
  for (const { target, name } of candidates) {
    if (targets.some((kept) => sameTarget(kept, target))) {
      warnings.push(`instance_pattern: target '${name}' is the same point as an earlier target; it was dropped`)
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
    const body = resolvePatternSourceBody(sub, ctx.partStore)
    const shape = ctx.table.get<OccShape>(body.shape!)
    return { point: solidCentroid(ctx.oc, ctx.scope, shape) as Vec3, normal: null, rule: 'the source part\'s centroid' }
  }
  const centroid = firstSourceToolCentroid(
    ctx.oc, ctx.scope, ctx.table,
    { id: featureId }, sub, ctx.globalRepo, ctx.partStore, ctx.featuresById, solveContext,
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
  const refs = targetRefs(sub)
  // The retired `sketch` key is the leading target for a document that slipped
  // past the loader's fold; the kernel never refuses the pair.
  const legacySketch = typeof sub.sketch === 'string' && sub.sketch !== '' ? sub.sketch : ''
  if (legacySketch !== '') refs.unshift(legacySketch)

  const ctx: PickTargetContext = { oc, scope, table, globalRepo, partStore: bodyStore, featuresById }
  const subject = (sub.subject as string) ?? 'body'
  const source = subject === 'feature' ? firstSource(featureId, sub, featuresById) : null

  const resolved = pickedTargets(refs, ctx)
  if (resolved.targets.length === 0) {
    throw new Error(`instance_pattern: no target resolved; ${resolved.warnings.join('; ') || 'the list is empty'}`)
  }
  const sketchPoint: SketchPoint | null = singleProfilePoint(source, globalRepo, featuresById)

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
