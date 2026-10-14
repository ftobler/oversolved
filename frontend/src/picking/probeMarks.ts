// PURE LOGIC -- no three.js, no React, no GL.
//
// Mark extraction: the probe's world-space pickables are derived from the same
// builder output the ID layers register, so the probe can never describe
// geometry the resolver's pixels were not drawn from. The ID layers own the
// GPU buffers; this module owns the probe-facing view of the same data.

import { sketchPointToWorld, type ProbePickableSource, type ProbePlane } from './sceneProbe'

export function pointPickable(
  layer: string, entityKey: string, point: readonly [number, number, number],
): ProbePickableSource {
  return { pickKey: entityKey, entityKey, layer, kind: 'point', points: [point] }
}

export function polylinePickable(
  layer: string, entityKey: string, points: ReadonlyArray<readonly [number, number, number]>,
): ProbePickableSource {
  return { pickKey: entityKey, entityKey, layer, kind: 'polyline', points }
}

/**
 * One point pickable per vertex/query pair, skipping non-finite positions the
 * way `VertexIdLayer` does before it allocates an id.
 */
export function pointPickables(
  layer: string,
  vertices: ReadonlyArray<readonly [number, number, number]>,
  vertexQueries: ReadonlyArray<string>,
): ProbePickableSource[] {
  const out: ProbePickableSource[] = []
  for (let i = 0; i < vertices.length; i++) {
    const query = vertexQueries[i]
    if (query === undefined) continue
    const v = vertices[i]
    if (!Number.isFinite(v[0]) || !Number.isFinite(v[1]) || !Number.isFinite(v[2])) continue
    out.push(pointPickable(layer, query, v))
  }
  return out
}

/**
 * Group an edge layer's segment soup into one polyline per edge, in edge-seen
 * order. Consecutive segment endpoints that coincide are collapsed, which is
 * what turns a sampled circle's 64 segments into one 65-point ring.
 */
export function polylinePickables(
  layer: string,
  edgeQueries: ReadonlyArray<string>,
  segmentPositions: ArrayLike<number>,
  segmentToEdge: ArrayLike<number>,
): ProbePickableSource[] {
  const pointsByEdge = new Map<number, [number, number, number][]>()
  const numSegments = Math.floor(segmentPositions.length / 6)
  for (let s = 0; s < numSegments; s++) {
    const edge = segmentToEdge[s]
    if (edgeQueries[edge] === undefined) continue
    const base = s * 6
    const a: [number, number, number] = [segmentPositions[base], segmentPositions[base + 1], segmentPositions[base + 2]]
    const b: [number, number, number] = [segmentPositions[base + 3], segmentPositions[base + 4], segmentPositions[base + 5]]
    if (![...a, ...b].every(Number.isFinite)) continue
    let pts = pointsByEdge.get(edge)
    if (!pts) { pts = []; pointsByEdge.set(edge, pts) }
    appendPointIfNew(pts, a)
    appendPointIfNew(pts, b)
  }
  const out: ProbePickableSource[] = []
  for (const [edge, points] of pointsByEdge) {
    out.push(polylinePickable(layer, edgeQueries[edge], points))
  }
  return out
}

function appendPointIfNew(
  pts: [number, number, number][], p: readonly [number, number, number],
): void {
  const last = pts[pts.length - 1]
  if (last && last[0] === p[0] && last[1] === p[1] && last[2] === p[2]) return
  pts.push([p[0], p[1], p[2]])
}

export interface ProbeSurfaceOutline {
  query: string
  // Outer boundary in sketch-local 2D coordinates.
  outline: ReadonlyArray<readonly [number, number]>
}

/**
 * One polygon pickable per surface outline, transformed to world space. Holes
 * are not published in phase 1: the visible surface fill is holed, but the
 * probe's area coverage is only used for ordering and gross reach, so the
 * outer ring is the exact shape where it matters (the boundary) and an
 * accepted approximation inside a hole.
 */
export function polygonPickables(
  layer: string,
  surfaces: ReadonlyArray<ProbeSurfaceOutline>,
  plane: ProbePlane | null,
): ProbePickableSource[] {
  const out: ProbePickableSource[] = []
  for (const surface of surfaces) {
    if (surface.outline.length < 3) continue
    out.push({
      pickKey: surface.query,
      entityKey: surface.query,
      layer,
      kind: 'polygon',
      points: surface.outline.map(([x, y]) => sketchPointToWorld(plane, x, y)),
    })
  }
  return out
}
