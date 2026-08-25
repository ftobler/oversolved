/**
 * Compute ``BrepDiff`` new-face / new-edge / new-vertex geometry hashes from
 * raw OCC handles. Used by the builder inside the feature loop while OCC shapes
 * are still live, so downstream ancestry queries correctly attribute new
 * sub-shapes to the modifying feature rather than the body's original creator.
 *
 * Mirrors ``builder.py`` ``_brep_diff_new_face_hashes`` /
 * ``_brep_diff_new_edge_hashes`` / ``_brep_diff_new_vertex_hashes``.
 */

import type { DisposeScope } from './disposeScope'
import type { OccModule, OccShape } from './occTypes'
import type { Body } from '../types3d'
import { faceGeometryHash, edgeGeometryHash, vertexGeometryHash } from '../geomHash'
import { faceCentroid, faceNormal, edgeToGeom } from './primitives'

type Vec3 = [number, number, number]

/**
 * Compute ``faceGeometryHash(centroid, normal)`` for every face in
 * ``body.brep_diff.new_faces``.
 */
export function brepDiffNewFaceHashes(
  oc: OccModule,
  scope: DisposeScope,
  body: Body,
): Set<string> {
  const diff = body.brep_diff
  if (!diff || !diff.new_faces || diff.new_faces.length === 0) return new Set()
  const hashes = new Set<string>()
  for (const topoFace of diff.new_faces) {
    try {
      const centroid = faceCentroid(oc, scope, topoFace as OccShape)
      const normal = faceNormal(oc, scope, topoFace as OccShape)
      hashes.add(faceGeometryHash(centroid, normal))
    } catch {
      // skip un-hashable faces
    }
  }
  return hashes
}

/**
 * Compute ``edgeGeometryHash`` for every edge in ``body.brep_diff.new_edges``.
 * Line edges are hashed both directions; arc/circle edges use the standard
 * edge-hash fields. Mirrors the fillet-chamfer ``brepDiffNewEdgeHashes``.
 */
export function brepDiffNewEdgeHashes(
  oc: OccModule,
  scope: DisposeScope,
  body: Body,
): Set<string> {
  const diff = body.brep_diff
  if (!diff || !diff.new_edges || diff.new_edges.length === 0) return new Set()
  const hashes = new Set<string>()
  for (const raw of diff.new_edges) {
    try {
      const { ed } = edgeToGeom(oc, scope, raw as OccShape)
      if (ed.kind === 'line') {
        const s = (ed as { start: number[] }).start
        const e = (ed as { end: number[] }).end
        hashes.add(edgeGeometryHash({ kind: 'line', start: s, end: e }))
        hashes.add(edgeGeometryHash({ kind: 'line', start: e, end: s }))
      } else if (ed.kind === 'circle' || ed.kind === 'arc') {
        hashes.add(edgeGeometryHash(ed as unknown as Record<string, unknown>))
      }
    } catch {
      // skip un-hashable edges (splines, freed handles)
    }
  }
  return hashes
}

/**
 * Compute vertex geometry hashes for endpoints that appear in ``new_edges`` but
 * NOT in ``inherited_edges``. These are "purely new" vertices (e.g. the corners
 * of a cut window) whose ancestry should track the modifying feature.
 */
export function brepDiffNewVertexHashes(
  oc: OccModule,
  scope: DisposeScope,
  body: Body,
): Set<string> {
  const diff = body.brep_diff
  if (!diff || !diff.new_edges || diff.new_edges.length === 0) return new Set()

  const newVertHashes = new Set<string>()
  const inheritedVertHashes = new Set<string>()

  function collectEndpoints(edges: unknown[], into: Set<string>): void {
    for (const topoShape of edges) {
      try {
        const ad = scope.track(new oc.BRepAdaptor_Curve_2(topoShape as OccShape))
        // Value() returns a fresh by-value gp_Pnt per endpoint: read, then drop.
        const p0 = ad.Value(ad.FirstParameter())
        const p1 = ad.Value(ad.LastParameter())
        const v0: Vec3 = [p0.X(), p0.Y(), p0.Z()]
        const v1: Vec3 = [p1.X(), p1.Y(), p1.Z()]
        p0.delete()
        p1.delete()
        into.add(vertexGeometryHash(v0))
        into.add(vertexGeometryHash(v1))
      } catch {
        // skip
      }
    }
  }

  collectEndpoints(diff.new_edges, newVertHashes)
  collectEndpoints(diff.inherited_edges ?? [], inheritedVertHashes)

  // Only vertices that are new (not in inherited) are truly new.
  for (const h of inheritedVertHashes) newVertHashes.delete(h)
  return newVertHashes
}
