// Extrude profile from picked B-rep edges (feature: extrude-brep-profile).
//
// Today an extrude profile comes from a sketch ($sketch) or a whole planar body
// face (@feat/face/N, resolved in faceProfile.ts). This adds the third source:
// a set of selected B-rep edges that bound a coplanar region. The edges are
// routed to their owning body and resolved to OCC edges via the same machinery
// fillet/chamfer use (resolveFilletEdges), then assembled into a single planar
// face that the extrude leaf builds exactly like a picked face (the cqFaces path
// in extrude.ts).
//
// v1 supports one connected, coplanar, closed loop. Non-coplanar or open edge
// sets fail loudly so the feature surfaces as a red error rather than a silent
// no-op.

import type { DisposeScope } from '../occ/disposeScope'
import type { OccModule, OccShape } from '../occ/occTypes'
import type { HandleTable } from '../occ/handleTable'
import type { Body } from '../types3d'
import { bodyIdOf, parseAncestry } from '../query'
import { makeWire } from '../occ/primitives'
import { resolveFilletEdges } from './filletChamfer'

/**
 * True when a profile ref addresses a B-rep edge rather than a sketch/face.
 * Matches both the ancestry forms (type restriction `edge`/`straightedge`) and
 * the `?body_x:edge:N` index alias registered by buildEdgeIndex.
 */
export function isEdgeProfileRef(refStr: string): boolean {
  if (!refStr.startsWith('?')) return false
  if (/:(?:straight)?edge:\d+$/.test(refStr)) return true
  try {
    const [, kind] = parseAncestry(refStr)
    return kind === 'edge' || kind === 'straightedge'
  } catch {
    return false
  }
}

/**
 * Assemble coplanar B-rep edges into one planar profile face. Throws when the
 * edges do not chain into a single connected loop, or are not coplanar.
 */
export function edgesToProfileFace(oc: OccModule, scope: DisposeScope, edges: OccShape[]): OccShape {
  if (edges.length === 0) throw new Error('extrude: no edges to build a profile from')
  // Route through makeWire so a joint gap beyond the kernel tolerance fails
  // loud. A raw MakeWire silently drops the unconnectable edge and stays done,
  // which used to build the face off a shortened loop (an open U of the
  // remaining sides) with no error at all.
  //
  // requireClosed because these edges are a PROFILE boundary, not a spine. The
  // edge count alone does not catch the other half of the same bug: pick 3 of a
  // rectangle's 4 edges and every edge connects, so the count guard passes,
  // MakeFace finds a plane through the open chain and reports IsDone, and the
  // extrude quietly produces a solid bounded by an open U.
  const wire = scope.track(makeWire(oc, scope, edges, { requireClosed: true }))
  // onlyPlane=true forces a planar surface; a non-coplanar wire leaves the
  // builder not-done instead of silently producing a curved/garbage face.
  const faceBuilder = scope.track(new oc.BRepBuilderAPI_MakeFace_15(wire, true))
  if (!faceBuilder.IsDone()) {
    throw new Error('extrude: selected edges are not coplanar or do not close a region')
  }
  return faceBuilder.Face()
}

/**
 * Resolve a list of edge profile refs to OCC edges, routing each ref to the body
 * that owns it (the `@body_x` token is a hint; geometry resolution wins, same as
 * fillet). Throws for any ref that no body can resolve.
 */
export function resolveProfileEdges(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  edgeRefs: string[],
  bodyStore: Record<string, Body>,
): OccShape[] {
  const edges: OccShape[] = []
  for (const refStr of edgeRefs) {
    const named = bodyIdOf(refStr, bodyStore)
    const order =
      named && named in bodyStore
        ? [named, ...Object.keys(bodyStore).filter((b) => b !== named)]
        : Object.keys(bodyStore)
    let resolved: OccShape[] = []
    for (const bid of order) {
      const body = bodyStore[bid]
      if (body === undefined || body.shape === null) continue
      resolved = resolveFilletEdges(oc, scope, table, body, [refStr], bodyStore)
      if (resolved.length > 0) break
    }
    if (resolved.length === 0) {
      throw new Error(`extrude: could not resolve profile edge '${refStr}'`)
    }
    edges.push(...resolved)
  }
  return edges
}

/** Resolve edge refs and assemble them into a single planar profile face. */
export function resolveEdgeProfileFace(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  edgeRefs: string[],
  bodyStore: Record<string, Body>,
): OccShape {
  return edgesToProfileFace(oc, scope, resolveProfileEdges(oc, scope, table, edgeRefs, bodyStore))
}
