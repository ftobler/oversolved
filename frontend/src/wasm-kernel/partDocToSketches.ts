/**
 * Lower the sketch features of a live PartDoc into the resolved `SketchInput`
 * the Rust shadow solver consumes.
 *
 * Live constraints carry sketch-local query-string refs (`$line1`, `$arc1start`)
 * which we resolve to `{entity, point}` dict form here -- the same sketch-local
 * resolution `geometryMapping.resolveQueryRef` already does for rendering, NOT
 * the ancestral / projection query system (that is phase 2c). A constraint whose
 * refs do not all resolve to local entities is dropped, mirroring the backend's
 * `_filter_local_constraints`; the Python solver drops them too, so the
 * constraint sets stay aligned.
 *
 * Sketches that need resolution we cannot do client-side yet -- projected
 * entities (a `source` query into ancestral brep) and `center_rect` sugar -- are
 * skipped with a reason. Those await the phase-2 projection lowering.
 */

import type { PartConstraint, PartFeature } from '@/types/cad'
import type { SketchInput } from './lowerSketch'

export interface ExtractedSketch {
  featureId: string
  sketch: SketchInput
}

export interface SkippedSketch {
  featureId: string
  reason: string
}

export interface ExtractResult {
  sketches: ExtractedSketch[]
  skipped: SkippedSketch[]
}

const KNOWN_POINTS = ['start', 'end', 'center', 'xy', 'major1', 'major2', 'minor1', 'minor2', 'c1', 'c2'] as const
const REF_KEYS = ['target', 'a', 'b', 'line', 'arc', 'point', 'point_a', 'point_b'] as const

/**
 * Resolve a constraint ref against the sketch's local entity ids. Accepts
 * the live `$entityId[point]` query-string form, the already-resolved
 * `{entity, point}` dict form, and `@builtin_origin` (the origin-point
 * query that every sketch needs for coincident-to-origin constraints --
 * maps to `{external_xy:[0,0]}` which the Rust solver's coincident handler
 * accepts natively).
 */
function resolveLocal(
  q: unknown,
  entityIds: Set<string>,
): { entity: string; point?: string } | { external_xy: [number, number] } | null {
  if (q && typeof q === 'object') {
    const obj = q as { entity?: unknown; point?: unknown }
    if (typeof obj.entity === 'string' && entityIds.has(obj.entity)) {
      return typeof obj.point === 'string'
        ? { entity: obj.entity, point: obj.point }
        : { entity: obj.entity }
    }
    return null
  }
  if (typeof q === 'string') {
    if (q === '@builtin_origin') return { external_xy: [0, 0] }
    if (!q.startsWith('$')) return null
    const local = q.slice(1)
    for (const pt of KNOWN_POINTS) {
      if (local.length > pt.length && local.endsWith(pt)) {
        const eid = local.slice(0, -pt.length)
        if (entityIds.has(eid)) return { entity: eid, point: pt }
      }
    }
    if (entityIds.has(local)) return { entity: local }
  }
  return null
}

/**
 * Lower one constraint to dict-ref form. Returns null (drop the constraint) when
 * any present ref does not resolve to a local entity -- matching the backend.
 */
function lowerConstraint(
  c: PartConstraint,
  entityIds: Set<string>,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = { id: c.id, kind: c.kind }
  for (const key of REF_KEYS) {
    const raw = c[key]
    if (raw == null) continue
    const resolved = resolveLocal(raw, entityIds)
    if (!resolved) return null
    out[key] = resolved
  }
  if (typeof c.value === 'number') out.value = c.value
  if (typeof c.x === 'number' && typeof c.y === 'number') {
    out.x = c.x
    out.y = c.y
  }
  if (typeof c.axis === 'string') out.axis = c.axis
  return out
}

/**
 * Expand a single `ngon` sugar constraint into the primitive constraints that
 * make the member lines a regular polygon: every side equal in length, and a
 * minimal set of fixed turn angles. The member lines already form a closed
 * coincident chain (added at mutation time), which together with N-1 equal
 * lengths and N-3 fixed exterior angles (360/N degrees, the angle the solver
 * measures between consecutive edge directions) pins the polygon to the
 * similarity family of regular N-gons. The solver never sees `ngon`.
 */
function lowerNgonConstraint(c: PartConstraint): PartConstraint[] {
  const refs = c.refs ?? []
  const n = refs.length
  if (n < 3) return []
  const out: PartConstraint[] = []
  // All sides equal length (pair every side with the first).
  for (let i = 1; i < n; i++) {
    out.push({ id: `${c.id}_eq${i}`, kind: 'equal_length', a: refs[0], b: refs[i] })
  }
  // Fix N-3 consecutive turn angles; closure + equal lengths determine the rest.
  const turn = 360 / n
  for (let i = 0; i < n - 3; i++) {
    out.push({ id: `${c.id}_ang${i}`, kind: 'angle', a: refs[i], b: refs[i + 1], value: turn })
  }
  return out
}

/** Replace `ngon` sugar constraints with their primitive expansions, leaving
 *  every other constraint untouched. Runs before the resolve loop so the solver
 *  only ever sees real constraint kinds. (Offset is not sugar at this layer: it
 *  is stored directly as parallel/concentric + an ordinary dimension.) */
function expandSugarConstraints(feature: PartFeature): PartConstraint[] {
  const out: PartConstraint[] = []
  for (const c of feature.constraints ?? []) {
    if (c.kind === 'ngon') out.push(...lowerNgonConstraint(c))
    else out.push(c)
  }
  return out
}

export function partDocToSketches(features: PartFeature[] | undefined): ExtractResult {
  const sketches: ExtractedSketch[] = []
  const skipped: SkippedSketch[] = []

  for (const feature of features ?? []) {
    if (feature.kind !== 'sketch') continue
    const entities = feature.entities ?? []

    if (entities.some((e) => e.source)) {
      skipped.push({ featureId: feature.id, reason: 'projection (needs phase-2 lowering)' })
      continue
    }
    if (entities.some((e) => e.kind === 'center_rect')) {
      skipped.push({ featureId: feature.id, reason: 'center_rect sugar (not expanded)' })
      continue
    }

    const entityIds = new Set(entities.map((e) => e.id))
    const constraints: Array<Record<string, unknown>> = []
    for (const c of expandSugarConstraints(feature)) {
      const lowered = lowerConstraint(c, entityIds)
      if (lowered) constraints.push(lowered)
    }

    const sketch: SketchInput = {
      id: feature.id,
      plane: feature.plane ?? null,
      entities: entities.map((e) => ({ id: e.id, kind: e.kind })),
      initial: feature.initial ?? {},
      constraints,
    }
    sketches.push({ featureId: feature.id, sketch })
  }

  return { sketches, skipped }
}
