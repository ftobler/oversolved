// An assembly entity pick mapped to a world primitive from the bundle's own
// facts. Version 1 measured off mate anchors only, so a lone pick said nothing
// and a circle or a cylinder had no radius. The bundle now carries the same
// analytic records the part editor's `BodyResult` does (edges, plus face facts
// since BUNDLE_SCHEMA 6), so this adapter classifies them through the shared
// helpers in `analytic.ts` and the assembly reads the part editor's numbers.
//
// The facts arrive in the solved pose: `solveAssembly` transforms the bundle's
// edges and faces with the instance pose the render already baked, exactly as
// it transforms the vertices. A drag that is committed but not yet re-solved is
// carried by the caller as a relative pose (`transformPrimitive`), so the
// readout follows the geometry the viewport is drawing.
import type { BundleFaceFact, EdgeCurve } from '@/kernel/partBundle'
import { distance, normalize, type Primitive, type Vec3 } from '../primitives'
import {
  analyticEdgePrimitive,
  boundaryCircleOf,
  circularFacePrimitive,
  isFullSweep,
  sameCircle,
  surfacePrimitive,
  TWO_PI,
  type AnalyticEdge,
  type BoundaryCircle,
} from './analytic'

/** The measurement facts of one solved shape, keyed by its body id. */
export interface BundleEntityFacts {
  edges: readonly EdgeCurve[]
  faces?: readonly BundleFaceFact[]
}

function endpointsCoincide(curve: EdgeCurve): boolean {
  return distance(curve.endpoints[0], curve.endpoints[1]) <= 1e-9
}

/** The bundle's edge record as the shared analytic shape. */
function analyticEdgeOf(curve: EdgeCurve): AnalyticEdge {
  switch (curve.kind) {
    case 'line':
      return { kind: 'line', start: curve.endpoints[0], end: curve.endpoints[1] }
    case 'circle':
      return { kind: 'circle', center: curve.point, axis: curve.axis, radius: curve.radius }
    case 'ellipse': {
      // A bundle cached before the parametric fields existed has no angles; its
      // coincident endpoints are the only full-turn evidence available.
      const fullTurn = curve.angle_start != null && curve.angle_end != null
        ? Math.abs(curve.angle_end - curve.angle_start) >= TWO_PI - 1e-9
        : endpointsCoincide(curve)
      return {
        kind: 'ellipse',
        center: curve.point,
        axis: curve.axis,
        a: curve.radius,
        b: curve.minor_radius,
        fullTurn,
      }
    }
    case 'b-spline':
      return { kind: 'spline' }
  }
}

/** The sweep one curve covers, before any sibling merge. */
function curveSweep(curve: EdgeCurve): number {
  if (curve.kind !== 'circle') return 0
  if (curve.angle_start != null && curve.angle_end != null) {
    return Math.abs(curve.angle_end - curve.angle_start)
  }
  return endpointsCoincide(curve) ? TWO_PI : 0
}

/**
 * Which face owns each boundary edge. Built once per pick: a face's boundary
 * walk is small, but the body can have hundreds of edges and a per-edge scan
 * over every face would be quadratic on a coarse triangulation.
 */
function facesByEdge(facts: BundleEntityFacts): Map<number, BundleFaceFact> {
  const out = new Map<number, BundleFaceFact>()
  for (const face of facts.faces ?? []) {
    for (const edge of face.face_edges ?? []) {
      if (!out.has(edge)) out.set(edge, face)
    }
  }
  return out
}

/**
 * The sweep a circle edge really covers, merged with same-circle siblings on
 * its own face. A STEP circle is often two half arcs, and a hole rim then reads
 * a diameter instead of a radius and a 180 degree sweep. This mirrors the part
 * adapter's `mergedSweep`; the boundary walk is the bundle's `face_edges`
 * instead of `face_edge_queries`.
 */
function mergedSweep(
  facts: BundleEntityFacts,
  index: number,
  owner: ReadonlyMap<number, BundleFaceFact>,
): number {
  const curve = facts.edges[index]
  if (!curve || curve.kind !== 'circle' || curve.radius == null) return 0
  const ownSweep = curveSweep(curve)
  if (isFullSweep(ownSweep, curve.radius)) return TWO_PI
  const own = boundaryCircleOf(analyticEdgeOf(curve), ownSweep)
  if (!own) return ownSweep
  let sweep = ownSweep
  for (const siblingIndex of owner.get(index)?.face_edges ?? []) {
    if (siblingIndex === index) continue
    const sibling = facts.edges[siblingIndex]
    if (!sibling || sibling.kind !== 'circle' || sibling.radius == null) continue
    const siblingSweep = curveSweep(sibling)
    if (isFullSweep(siblingSweep, sibling.radius)) continue
    const other = boundaryCircleOf(analyticEdgeOf(sibling), siblingSweep)
    if (!other || !sameCircle(own, other)) continue
    sweep += siblingSweep
  }
  return sweep
}

/**
 * A flat face that is really a disc or a ring: the boundary walk is resolved to
 * circles and the shared area check decides. The part adapter reaches the same
 * classification from its query walk, so a hole cover reads one diameter in
 * both editors.
 */
function circularFace(
  facts: BundleEntityFacts,
  fact: BundleFaceFact,
  owner: ReadonlyMap<number, BundleFaceFact>,
): Primitive | null {
  const walk = fact.face_edges
  if (!walk?.length || fact.area == null || !(fact.area > 0)) return null
  const normal = fact.normal ? normalize(fact.normal) : null
  if (!normal) return null
  const rings: BoundaryCircle[] = []
  for (const index of walk) {
    const curve = facts.edges[index]
    if (!curve) return null
    const ring = boundaryCircleOf(analyticEdgeOf(curve), mergedSweep(facts, index, owner))
    // A line, spline or ellipse in the boundary keeps the face a plane.
    if (!ring) return null
    rings.push(ring)
  }
  return circularFacePrimitive(rings, fact.area, normal)
}

/**
 * The primitive one face, edge or vertex pick of a bundle body states. A vertex
 * is not here: its anchor IS the point, so the caller keeps the anchor adapter
 * for vertices and the assembly's built-ins. A body pick is a `solid` the
 * caller builds, because it names the instance rather than an element.
 */
export function bundleEntityPrimitive(
  facts: BundleEntityFacts | undefined,
  kind: 'edge' | 'face' | 'vertex',
  index: number,
  ref: string,
): Primitive | null {
  if (!facts) return null
  const owner = facesByEdge(facts)
  if (kind === 'edge') {
    const curve = facts.edges[index]
    if (!curve) return null
    return analyticEdgePrimitive(analyticEdgeOf(curve), mergedSweep(facts, index, owner), ref)
  }
  if (kind === 'face') {
    const fact = facts.faces?.[index]
    if (!fact) return null
    // The round-flat-face check only means something for a flat face; a curved
    // face is classified from its frame alone (the radial-normal trap).
    const flat = fact.surface_type === undefined || fact.surface_type === 'flatface'
    const circular = flat ? circularFace(facts, fact, owner) : null
    return surfacePrimitive(
      {
        surfaceType: fact.surface_type,
        centroid: [...fact.centroid] as Vec3,
        normal: fact.normal ? [...fact.normal] as Vec3 : null,
        frame: fact.frame
          ? {
              origin: [...fact.frame.origin] as Vec3,
              axis: [...fact.frame.axis] as Vec3,
              radius: fact.frame.radius,
              semiAngle: fact.frame.semi_angle,
              minorRadius: fact.frame.minor_radius,
            }
          : null,
      },
      circular,
      fact.axial_length ?? null,
      ref,
    )
  }
  return null
}
