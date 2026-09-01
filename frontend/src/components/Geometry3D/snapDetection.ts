// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.
import type { Sketch, LineSegment, Circle, Arc, PointEntity, Spline, Entity, PartConstraint, PartEntityDef, Topology } from '@/types/cad'
import { suggestConstraint, type DraggedElementType, type SnapKind } from '@/registry'
import { nearestPointOnEntity } from '@/components/Geometry3D/nearestPoint'
import { dockHostsOf } from '@/utils/geometry/dockHosts'
import { curvesThroughPoint } from '@/utils/geometry/curvesThroughPoint'

// Coincidence tolerance for matching a topology intersection point against the
// solved curves and existing points. The point and the curves come from the same
// solve, so they agree to high precision; this only absorbs rounding.
const INFERRED_TOL = 1e-3

export type DragSnapKind = 'vertex' | 'entity'

export interface SnapTarget {
  kind: DragSnapKind
  position: [number, number]
  constraintKind: string
  vertexId?: string
  entityRef?: string
}

export interface SnapCandidate {
  id: string
  position: [number, number]
  kind: SnapKind
  domain: 'active_sketch' | 'other_sketch' | 'projected' | 'body_3d'
}

export interface EntityCandidate {
  id: string
  entity: Entity
  domain: 'active_sketch' | 'other_sketch' | 'body_3d'
}

function collectFromSketch(sketch: Sketch, featureId: string, domain: SnapCandidate['domain']): SnapCandidate[] {
  const targets: SnapCandidate[] = []
  for (const [entityId, entity] of Object.entries(sketch)) {
    if ('start' in entity && 'end' in entity) {
      const l = entity as LineSegment | Arc
      targets.push({ id: `vertex:${featureId}:${entityId}:start`, position: l.start, kind: 'vertex', domain })
      targets.push({ id: `vertex:${featureId}:${entityId}:end`,   position: l.end,   kind: 'vertex', domain })
      if ('radius' in l && 'angle_start' in l) {
        targets.push({ id: `vertex:${featureId}:${entityId}:center`, position: (l as Arc).center, kind: 'vertex', domain })
      }
    } else if ('center' in entity && 'radius' in entity) {
      const c = entity as Circle
      targets.push({ id: `vertex:${featureId}:${entityId}:center`, position: c.center, kind: 'vertex', domain })
    } else if ('p1' in entity) {
      const sp = entity as Spline
      targets.push({ id: `vertex:${featureId}:${entityId}:start`, position: sp.p1, kind: 'vertex', domain })
      targets.push({ id: `vertex:${featureId}:${entityId}:c1`,    position: sp.p2, kind: 'vertex', domain })
      targets.push({ id: `vertex:${featureId}:${entityId}:c2`,    position: sp.p3, kind: 'vertex', domain })
      targets.push({ id: `vertex:${featureId}:${entityId}:end`,   position: sp.p4, kind: 'vertex', domain })
    } else if ('x' in entity) {
      const p = entity as PointEntity
      targets.push({ id: `vertex:${featureId}:${entityId}:xy`, position: [p.x, p.y], kind: 'vertex', domain })
    }
  }
  return targets
}

function collectEntityCandidatesFromSketch(
  sketch: Sketch,
  featureId: string,
  domain: EntityCandidate['domain'],
): EntityCandidate[] {
  return Object.entries(sketch).map(([entityId, entity]) => ({
    id: `entity:${featureId}:${entityId}`,
    entity,
    domain,
  }))
}

export function sketchToVertexCandidates(
  sketch: Sketch,
  featureId: string,
  domain: SnapCandidate['domain'],
): SnapCandidate[] {
  return collectFromSketch(sketch, featureId, domain)
}

/** Convert a solved Sketch entity to the raw {kind, params} form `dockHostsOf`
 *  consumes. Only line/circle/arc carry a tangent contact, so other kinds are
 *  dropped (a tangent naming them yields no foot anyway). */
function sketchEntityToParams(entity: Entity): { kind: string; params: number[] } | null {
  if ('start' in entity && 'end' in entity) {
    if ('radius' in entity && 'angle_start' in entity) {
      const a = entity as Arc
      return { kind: 'arc', params: [a.center[0], a.center[1], a.radius, a.angle_start, a.angle_end] }
    }
    const l = entity as LineSegment
    return { kind: 'line', params: [l.start[0], l.start[1], l.end[0], l.end[1]] }
  }
  if ('center' in entity && 'radius' in entity) {
    const c = entity as Circle
    return { kind: 'circle', params: [c.center[0], c.center[1], c.radius] }
  }
  return null
}

/** Snap candidates for the inferred contacts of dockable hosts (lazy inferred
 *  materialization). Each tangent contact is offered as a 0-D snap target whose id
 *  is the transient `dock:<featureId>:<hostId>` handle -- snapping to it (e.g.
 *  dragging an endpoint onto it) authors a `coincident` against the handle, which
 *  `applyAddConstraint` materializes into a real point. Hosts a `dock` constraint
 *  already names are omitted by `dockHostsOf`; hosts whose contact a real point
 *  occupies by any other route are omitted by `inferredContactCandidates`, which
 *  is where the sketch's own vertices are in hand. Either way the real point is
 *  its own vertex candidate and the contact is offered once. */
export function sketchToDockCandidates(
  sketch: Sketch,
  featureId: string,
  constraints: PartConstraint[],
  domain: SnapCandidate['domain'],
): SnapCandidate[] {
  const entities: PartEntityDef[] = []
  const params: Record<string, number[]> = {}
  for (const [id, entity] of Object.entries(sketch)) {
    const geo = sketchEntityToParams(entity)
    if (!geo) continue
    entities.push({ id, kind: geo.kind })
    params[id] = geo.params
  }
  return dockHostsOf(entities, constraints, params).map(h => ({
    id: `dock:${featureId}:${h.hostId}`,
    position: h.at,
    kind: 'vertex' as SnapKind,
    domain,
  }))
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4

/** Snap candidates for free curve-curve intersections -- the other half of the
 *  inferred-point set (the topology emits a crossing point where two curves meet
 *  with no constraint relating them). Each is offered as a 0-D target whose id
 *  `isect:<fid>:<x>:<y>:<curveA>:<curveB>...` bakes in the contributing curves
 *  (resolved here, where the solved geometry is richest) so the materialize
 *  interception needs no geometry: it just calls `applyAddPointAtIntersection`.
 *
 *  A crossing already owned by a materialized point is NOT offered: the topology
 *  itself drops it (`reconcileMaterializedContacts`, slice 4), so its
 *  `intersection_points` no longer lists the contact and the real point's vertex
 *  candidate stands in. */
export function sketchToIntersectionCandidates(
  sketch: Sketch,
  topology: Topology | undefined,
  featureId: string,
  domain: SnapCandidate['domain'],
): SnapCandidate[] {
  if (!topology) return []
  const out: SnapCandidate[] = []
  for (const pt of Object.values(topology.intersection_points)) {
    const at: [number, number] = [pt.x, pt.y]
    const curves = curvesThroughPoint(sketch, at, INFERRED_TOL)
    if (curves.length < 2) continue
    out.push({
      id: `isect:${featureId}:${round4(at[0])}:${round4(at[1])}:${curves.join(':')}`,
      position: at,
      kind: 'vertex' as SnapKind,
      domain,
    })
  }
  return out
}

/** The full inferred-point snap/pick set: dockable-host contacts UNION free
 *  curve-curve intersections, the two halves the design names. An intersection
 *  coinciding with a dock (a tangent contact that also has a tangent constraint)
 *  is dropped so the contact is offered once, as a dock.
 *
 *  A contact a REAL point already sits on is not offered at all. That is the
 *  rule both halves already state -- `dockHostsOf` omits a docked host and the
 *  topology omits a crossing owned by a materialized point, both because "the
 *  real point covers it" -- but the dock half tested only for a `dock`
 *  constraint, and a `dock` constraint is not the only way a contact becomes
 *  real. A line endpoint constrained `coincident` on the circle its line is
 *  tangent to IS the tangent point: the same spot, arrived at by the ordinary
 *  route rather than by materializing a dock. Offered anyway, the handle drew a
 *  ring over a point that was already there and invited the user to materialize
 *  a second point on top of the first.
 *
 *  The intersection half is held to the same rule rather than left to the
 *  topology alone, because the two are now coupled: dropping a dock must not
 *  resurrect a crossing at the spot the dock was dropped FOR.
 *
 *  Checked here rather than in `dockHostsOf`, which takes entities and params
 *  and would have to rebuild the vertex set this module already has, and which
 *  is the same function `dockLocationOf` deliberately shares with the
 *  materialize interception -- that caller wants the foot whether or not
 *  anything occupies it. */
export function inferredContactCandidates(
  sketch: Sketch,
  featureId: string,
  constraints: PartConstraint[],
  topology: Topology | undefined,
  domain: SnapCandidate['domain'],
): SnapCandidate[] {
  const docks = sketchToDockCandidates(sketch, featureId, constraints, domain)
  const isects = sketchToIntersectionCandidates(sketch, topology, featureId, domain)
  const real = sketchToVertexCandidates(sketch, featureId, domain)
  const near = (a: SnapCandidate, b: SnapCandidate) =>
    Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1]) < INFERRED_TOL
  const free = docks.filter(d => !real.some(v => near(d, v)))
  const deduped = isects.filter(ic => !free.some(d => near(d, ic)) && !real.some(v => near(v, ic)))
  return [...free, ...deduped]
}

export function sketchToEntityCandidates(
  sketch: Sketch,
  featureId: string,
  domain: EntityCandidate['domain'],
): EntityCandidate[] {
  return collectEntityCandidatesFromSketch(sketch, featureId, domain)
}

export function collectVertexTargetsFlat(
  candidates: SnapCandidate[],
  skipIds: ReadonlySet<string>,
): SnapCandidate[] {
  if (skipIds.size === 0) return candidates
  return candidates.filter(t => {
    for (const skipId of skipIds) {
      if (t.id.includes(`:${skipId}:`)) return false
    }
    return true
  })
}

export function collectEntityCandidatesFlat(
  candidates: EntityCandidate[],
  skipIds: ReadonlySet<string>,
): EntityCandidate[] {
  if (skipIds.size === 0) return candidates
  return candidates.filter(t => {
    for (const skipId of skipIds) {
      if (t.id === `entity:${skipId}`) return false
    }
    return true
  })
}

export function collectVertexTargets(
  sketch: Sketch,
  featureId: string,
  skipEntityId: string,
  otherSketches?: Record<string, Sketch>,
): SnapCandidate[] {
  const skipIds = new Set<string>()
  if (skipEntityId) skipIds.add(skipEntityId)
  const targets = sketchToVertexCandidates(sketch, featureId, 'active_sketch')
  const filtered = collectVertexTargetsFlat(targets, skipIds)
  if (otherSketches) {
    for (const [otherFeatId, otherSketch] of Object.entries(otherSketches)) {
      filtered.push(...sketchToVertexCandidates(otherSketch, otherFeatId, 'other_sketch'))
    }
  }
  return filtered
}

export function collectEntityCandidates(
  sketch: Sketch,
  featureId: string,
  skipEntityId: string,
  otherSketches?: Record<string, Sketch>,
): EntityCandidate[] {
  const skipIds = new Set<string>()
  if (skipEntityId) skipIds.add(`${featureId}:${skipEntityId}`)
  const targets = sketchToEntityCandidates(sketch, featureId, 'active_sketch')
  const filtered = collectEntityCandidatesFlat(targets, skipIds)
  if (otherSketches) {
    for (const [otherFeatId, otherSketch] of Object.entries(otherSketches)) {
      filtered.push(...sketchToEntityCandidates(otherSketch, otherFeatId, 'other_sketch'))
    }
  }
  return filtered
}

export function findSnapTarget(
  candidates: SnapCandidate[],
  entityCandidates: EntityCandidate[],
  draggedType: DraggedElementType,
  x: number,
  y: number,
  vertexThreshold: number,
  entityThreshold: number,
): SnapTarget | null {
  let bestVertex: (SnapCandidate & { dist: number }) | null = null
  let bestVertexDist = vertexThreshold
  for (const t of candidates) {
    const d = Math.hypot(t.position[0] - x, t.position[1] - y)
    if (d < bestVertexDist) {
      const cKind = suggestConstraint(draggedType, t.kind)
      if (cKind !== null) {
        bestVertexDist = d
        bestVertex = { ...t, dist: d }
      }
    }
  }
  if (bestVertex) {
    const cKind = suggestConstraint(draggedType, bestVertex.kind)!
    return { kind: 'vertex', position: bestVertex.position, constraintKind: cKind, vertexId: bestVertex.id }
  }

  const pathConstraintKind = suggestConstraint(draggedType, 'path')
  if (pathConstraintKind === null) return null

  let bestEntity: SnapTarget | null = null
  let bestEntityDist = entityThreshold

  for (const ec of entityCandidates) {
    const result = nearestPointOnEntity(x, y, ec.entity)
    if (result && result.distance < bestEntityDist) {
      bestEntityDist = result.distance
      bestEntity = {
        kind: 'entity',
        position: result.position as [number, number],
        constraintKind: pathConstraintKind,
        entityRef: ec.id,
      }
    }
  }

  return bestEntity
}