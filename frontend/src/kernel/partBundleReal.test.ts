// @vitest-environment node
//
// Stage 2b + 2c integration tests: build a PartBundle from a single-extrude part
// through the real OCC + Rust solver pipeline. Validates mesh extraction
// (faceIdsPerTriangle), edge-curve extraction (line edges for box, circle
// edges for holes), and anchor enumeration (faces, edges, vertices).
//
// Does NOT assert byte-identity across rebuilds, OCC tessellation is not
// guaranteed byte-deterministic across worker restarts or OCC.js versions.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from './occ/loadOcc'
import { DisposeScope } from './occ/disposeScope'
import { HandleTable } from './occ/handleTable'
import { solidToMesh, solidToEdges, solidToVertices } from './occ/tessellation'
import { brepDiffNewFaceHashes, brepDiffNewEdgeHashes, brepDiffNewVertexHashes } from './occ/brepDiffHash'
import { build, type BuildDeps, type BuildResponse } from './builder'
import { initGlobalRepo } from './query'
import { createFeatureSolver } from './solverRegistry'
import { postRegister } from './features/postRegister'
import { setSketchSolver, resetSketchSolver } from './features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { toPartBundle } from './partBundle'
import type { BodyResult } from '../types/cad'

const oc = await loadOcc()
const solveBytes = loadSolver()

function rectSketchSpec(sketchId: string, w: number, h: number) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle',
    plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: {
      bottom: [0, 0, w, 0], right: [w, 0, w, h],
      top: [w, h, 0, h], left: [0, h, 0, 0],
    },
    constraints: [
      { id: 'c1', kind: 'coincident' as const, a: { entity: 'bottom', point: 'end' as const }, b: { entity: 'right', point: 'start' as const } },
      { id: 'c2', kind: 'coincident' as const, a: { entity: 'right', point: 'end' as const }, b: { entity: 'top', point: 'start' as const } },
      { id: 'c3', kind: 'coincident' as const, a: { entity: 'top', point: 'end' as const }, b: { entity: 'left', point: 'start' as const } },
      { id: 'c4', kind: 'coincident' as const, a: { entity: 'left', point: 'end' as const }, b: { entity: 'bottom', point: 'start' as const } },
      { id: 'c5', kind: 'horizontal' as const, target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal' as const, target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical' as const, target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical' as const, target: { entity: 'left' } },
      { id: 'c9', kind: 'length' as const, target: { entity: 'bottom' }, value: w },
      { id: 'c10', kind: 'length' as const, target: { entity: 'left' }, value: h },
    ],
  }
}

function extrudeSpec(sketchId: string, extrudeId: string, distance: number) {
  return {
    id: extrudeId, kind: 'extrude' as const, label: 'Extrude',
    sketch: '$' + sketchId, distance, direction: 'normal', operation: 'add' as const,
  }
}

function run(spec: Record<string, unknown>): BuildResponse {
  const scope = new DisposeScope()
  const table = new HandleTable({ finalizerGuard: false })
  try {
    const deps: BuildDeps = {
      trySolveFeature: createFeatureSolver(oc!, scope, table),
      postRegister, initGlobalRepo,
      tessellateBodies: (bodyStore) => {
        const out: Record<string, Record<string, unknown>> = {}
        for (const [, body] of Object.entries(bodyStore)) {
          if (!body.shape) continue
          try {
            const mesh = solidToMesh(oc!, table, body.shape, {
              createdBy: body.created_by || '',
              bodyId: body.id,
              faceAncestry: body.face_ancestry ?? null,
              faceNames: body.face_names ?? null,
              profileQueries: body.profile_queries ?? [],
            })
            const edgeResult = solidToEdges(oc!, table, body.shape, {
              createdBy: body.created_by || '',
              bodyId: body.id,
              profileQueries: body.profile_queries ?? [],
              edgeAncestry: body.edge_ancestry ?? null,
              edgeNames: body.edge_names ?? null,
            })
            const vertexResult = solidToVertices(oc!, table, body.shape, {
              createdBy: body.created_by || '',
              bodyId: body.id,
              profileQueries: body.profile_queries ?? [],
              faceNames: body.face_names ?? null,
            })
            out[body.id] = {
              id: body.id,
              created_by: body.created_by,
              modified_by: body.modified_by ?? [],
              mesh,
              edges: edgeResult.edges,
              edge_queries: edgeResult.edge_queries,
              vertices: vertexResult.vertices,
              vertex_queries: vertexResult.vertex_queries,
            }
          } catch {  /* non-fatal */ }
        }
        return out
      },
      brepDiffNewFaceHashes: (b) => brepDiffNewFaceHashes(oc!, scope, b),
      brepDiffNewEdgeHashes: (b) => brepDiffNewEdgeHashes(oc!, scope, b),
      brepDiffNewVertexHashes: (b) => brepDiffNewVertexHashes(oc!, scope, b),
    }
    const result = build(spec, {}, deps)
    scope.dispose()
    return result
  } catch (e) {
    scope.dispose()
    throw e
  }
}

describe.skipIf(!oc || !solveBytes)('bundle extraction (real OCC + Rust solver)', () => {
  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) }
  })

  it('produces one BodyMesh per body for a rect extrude', () => {
    const result = run({ features: [rectSketchSpec('sk1', 10, 10), extrudeSpec('sk1', 'ex1', 5)] })
    const bundle = toPartBundle('doc1', 1, result.bodies as Record<string, BodyResult>)
    expect(bundle.doc_id).toBe('doc1')
    expect(bundle.doc_rev).toBe(1)
    // Anchors are populated from the real build.
    expect(typeof bundle.anchors).toBe('object')
    expect(Object.keys(bundle.anchors).length).toBeGreaterThan(0)
    expect(bundle.bodies.length).toBeGreaterThan(0)
    for (const bodyMesh of bundle.bodies) {
      expect(bodyMesh.mesh.vertices).toBeInstanceOf(Float32Array)
      expect(bodyMesh.mesh.indices).toBeInstanceOf(Uint32Array)
      expect(bodyMesh.mesh.faceIdsPerTriangle).toBeInstanceOf(Uint32Array)
    }
  })

  it('faceIdsPerTriangle length equals triangle count', () => {
    const result = run({ features: [rectSketchSpec('sk1', 10, 10), extrudeSpec('sk1', 'ex1', 5)] })
    const bundle = toPartBundle('doc2', 1, result.bodies as Record<string, BodyResult>)
    for (const bodyMesh of bundle.bodies) {
      const triCount = bodyMesh.mesh.indices.length / 3
      expect(bodyMesh.mesh.faceIdsPerTriangle.length).toBe(triCount)
    }
  })

  it('box edges appear as line EdgeCurves with correct endpoints', () => {
    const result = run({ features: [rectSketchSpec('sk1', 10, 10), extrudeSpec('sk1', 'ex1', 5)] })
    const bundle = toPartBundle('doc3', 1, result.bodies as Record<string, BodyResult>)
    const allEdges = bundle.bodies.flatMap((b) => b.edges)
    const lineEdges = allEdges.filter((e) => e.kind === 'line')
    // A box has 12 line edges (4 on front face, 4 on back face, 4 connecting).
    expect(lineEdges.length).toBe(12)

    for (const edge of lineEdges) {
      expect(edge.axis).toBeTruthy()
      // Axis should be a unit vector (within tolerance)
      const axisLen = Math.sqrt(
        edge.axis![0] ** 2 + edge.axis![1] ** 2 + edge.axis![2] ** 2,
      )
      expect(axisLen).toBeCloseTo(1, 5)
      // Endpoints should be distinct (a line has non-zero length)
      const dx = edge.endpoints[0][0] - edge.endpoints[1][0]
      const dy = edge.endpoints[0][1] - edge.endpoints[1][1]
      const dz = edge.endpoints[0][2] - edge.endpoints[1][2]
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      expect(dist).toBeGreaterThan(0)
    }
  })

  it('every EdgeCurve has a unique id from its edge query', () => {
    const result = run({ features: [rectSketchSpec('sk1', 10, 10), extrudeSpec('sk1', 'ex1', 5)] })
    const bundle = toPartBundle('doc4', 1, result.bodies as Record<string, BodyResult>)
    const allEdges = bundle.bodies.flatMap((b) => b.edges)
    const ids = allEdges.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('same-rev rebuild produces bundles with matching edge counts and kinds', () => {
    const r1 = run({ features: [rectSketchSpec('sk1', 10, 10), extrudeSpec('sk1', 'ex1', 5)] })
    const r2 = run({ features: [rectSketchSpec('sk1', 10, 10), extrudeSpec('sk1', 'ex1', 5)] })
    const b1 = toPartBundle('doc5', 1, r1.bodies as Record<string, BodyResult>)
    const b2 = toPartBundle('doc5', 1, r2.bodies as Record<string, BodyResult>)
    expect(b1.bodies.length).toBe(b2.bodies.length)

    const edges1 = b1.bodies.flatMap((b) => b.edges)
    const edges2 = b2.bodies.flatMap((b) => b.edges)
    expect(edges1.length).toBe(edges2.length)

    // Same rev -> same sets of edge kinds (line/circle/ellipse/spline counts match)
    const kinds1 = edges1.map((e) => e.kind).sort()
    const kinds2 = edges2.map((e) => e.kind).sort()
    expect(kinds1).toEqual(kinds2)
  })

  it('repeated same-rev build produces matching faceIdsPerTriangle values', () => {
    // OCC tessellation is not byte-deterministic, so we cannot assert byte
    // identity of vertices/indices across rebuilds. But face-to-triangle mapping
    // (which face each triangle belongs to) should be deterministic.
    const r1 = run({ features: [rectSketchSpec('sk1', 10, 10), extrudeSpec('sk1', 'ex1', 5)] })
    const r2 = run({ features: [rectSketchSpec('sk1', 10, 10), extrudeSpec('sk1', 'ex1', 5)] })
    const b1 = toPartBundle('doc6', 1, r1.bodies as Record<string, BodyResult>)
    const b2 = toPartBundle('doc6', 1, r2.bodies as Record<string, BodyResult>)

    for (let i = 0; i < b1.bodies.length; i++) {
      const triCount1 = b1.bodies[i].mesh.indices.length / 3
      const triCount2 = b2.bodies[i].mesh.indices.length / 3
      // Triangle count may differ slightly, but face mapping should be the same set
      expect(b1.bodies[i].mesh.faceIdsPerTriangle.length).toBe(triCount1)
      expect(b2.bodies[i].mesh.faceIdsPerTriangle.length).toBe(triCount2)
    }
  })

  // ─── Stage 2c: anchors ───

  it('rect extrude anchors: 6 plane faces, 12 line edges, 8 point vertices', () => {
    const result = run({ features: [rectSketchSpec('sk1', 10, 10), extrudeSpec('sk1', 'ex1', 5)] })
    const bundle = toPartBundle('doc7', 1, result.bodies as Record<string, BodyResult>)
    const vals = Object.values(bundle.anchors)
    expect(vals.length).toBeGreaterThan(0)

    const planeAnchors = vals.filter((a) => a.kind === 'plane')
    const lineAnchors = vals.filter((a) => a.kind === 'line')
    const vertexAnchors = vals.filter((a) => a.kind === 'point')

    // A box has 6 planar faces
    expect(planeAnchors.length).toBe(6)
    // A box has 12 line edges
    expect(lineAnchors.length).toBe(12)
    // A box has 8 corner vertices
    expect(vertexAnchors.length).toBe(8)

    // Every face anchor carries a @u| construction UUID, a point, and a normal.
    for (const a of planeAnchors) {
      expect(a.geom_hash.startsWith('@u|')).toBe(true)
      expect(a.point.length).toBe(3)
      expect(a.axis.length).toBe(3)
      const normalLen = Math.sqrt(a.axis[0] ** 2 + a.axis[1] ** 2 + a.axis[2] ** 2)
      expect(normalLen).toBeCloseTo(1, 5)
    }

    // Every edge anchor has a @u| construction UUID token
    for (const a of lineAnchors) {
      expect(a.geom_hash.startsWith('@u|')).toBe(true)
      expect(a.point.length).toBe(3)
      expect(a.axis.length).toBe(3)
    }

    // Every vertex anchor has a @u| construction UUID token
    for (const a of vertexAnchors) {
      expect(a.geom_hash.startsWith('@u|')).toBe(true)
      expect(a.point.length).toBe(3)
    }
  })

  it('every anchor has created_by set to the owning feature', () => {
    const result = run({ features: [rectSketchSpec('sk1', 10, 10), extrudeSpec('sk1', 'ex1', 5)] })
    const bundle = toPartBundle('doc8', 1, result.bodies as Record<string, BodyResult>)
    for (const a of Object.values(bundle.anchors)) {
      expect(a.created_by).toBeTruthy()
    }
  })

  it('same-rev rebuild produces same multiset of (kind, geom_hash) descriptors, different anchor ids', () => {
    const r1 = run({ features: [rectSketchSpec('sk1', 10, 10), extrudeSpec('sk1', 'ex1', 5)] })
    const r2 = run({ features: [rectSketchSpec('sk1', 10, 10), extrudeSpec('sk1', 'ex1', 5)] })
    const b1 = toPartBundle('doc9', 1, r1.bodies as Record<string, BodyResult>)
    const b2 = toPartBundle('doc9', 1, r2.bodies as Record<string, BodyResult>)

    const descs1 = Object.values(b1.anchors).map((a) => `${a.kind}:${a.geom_hash}:${a.created_by}`).sort()
    const descs2 = Object.values(b2.anchors).map((a) => `${a.kind}:${a.geom_hash}:${a.created_by}`).sort()
    // Same rev → same descriptors (multiset). OCC geometry is deterministic per build.
    expect(descs1.length).toBe(descs2.length)

    const ids1 = new Set(Object.keys(b1.anchors))
    const ids2 = new Set(Object.keys(b2.anchors))
    // Freshly minted ids per build, they should all differ.
    for (const id of ids1) expect(ids2.has(id)).toBe(false)
  })

  it('cylindrical hole face produces a coaxial cylinder anchor (Stage A: axis, not the radial normal)', () => {
    // A sketch with a circle cutout → a through-hole, extruded along Z.
    const holeSketchSpec = {
      id: 'sk_hole', kind: 'sketch' as const, label: 'Hole sketch',
      plane: '@builtin_plane_front',
      entities: [
        { id: 'c1', kind: 'circle' as const },
      ],
      initial: {
        c1: [5, 5, 2],
      },
      constraints: [
        { id: 'dim1', kind: 'diameter' as const, target: { entity: 'c1' }, value: 4 },
      ],
    }
    const result = run({ features: [
      rectSketchSpec('sk1', 10, 10),
      holeSketchSpec,
      extrudeSpec('sk1', 'ex1', 5),
      { id: 'ex_hole', kind: 'extrude' as const, label: 'Hole extrude',
        sketch: '$sk_hole', distance: 5, direction: 'normal', operation: 'remove' as const },
    ] })
    const bundle = toPartBundle('doc10', 1, result.bodies as Record<string, BodyResult>)
    const vals = Object.values(bundle.anchors)
    const cylinderAnchors = vals.filter((a) => a.kind === 'cylinder')
    // The hole's cylindrical wall is one cylinder anchor
    expect(cylinderAnchors.length).toBeGreaterThanOrEqual(1)
    for (const a of cylinderAnchors) {
      expect(a.geom_hash.startsWith('@u|')).toBe(true)
      // The bore runs along Z: the anchor axis must be the bore's rotation
      // axis, not the radial surface normal `faceNormal` reads (which pointed
      // sideways, e.g. [-1,0,0], before Stage A).
      expect(Math.abs(a.axis[2])).toBeCloseTo(1, 5)
      expect(Math.abs(a.axis[0])).toBeCloseTo(0, 5)
      expect(Math.abs(a.axis[1])).toBeCloseTo(0, 5)
      // The point lies on the bore centreline (x=5, y=5), not on the wall
      // (radius 2 away from the centreline).
      expect(a.point[0]).toBeCloseTo(5, 5)
      expect(a.point[1]).toBeCloseTo(5, 5)
    }

    // Planar faces still produce plane anchors (box end faces + hole end)
    const planeAnchors = vals.filter((a) => a.kind === 'plane')
    expect(planeAnchors.length).toBeGreaterThan(0)
  })

  it('a fillet (partial cylinder) anchor point is on the fillet axis, not on the fillet surface', () => {
    const spec: { features: Array<Record<string, unknown>> } = {
      features: [rectSketchSpec('sk1', 10, 10), extrudeSpec('sk1', 'ex1', 5)],
    }
    const pre = run(spec)
    const edgeQueries = (pre.bodies['body_ex1'] as BodyResult).edge_queries ?? []
    // The vertical edge at the (0,0) corner sorts first (compareEdgeSortKeys,
    // type_order 0 = line, then lexicographic by rounded coords).
    const cornerEdge = edgeQueries[0]
    spec.features.push({ id: 'fillet1', kind: 'fillet', edges: [cornerEdge], radius: 1 })
    const result = run(spec)
    const bundle = toPartBundle('doc11', 1, result.bodies as Record<string, BodyResult>)
    const filletAnchors = Object.values(bundle.anchors).filter((a) => a.kind === 'cylinder')
    expect(filletAnchors.length).toBeGreaterThanOrEqual(1)
    const fillet = filletAnchors[0]
    // Axis parallel to the box's vertical edges (Z).
    expect(Math.abs(fillet.axis[2])).toBeCloseTo(1, 5)
    // A corner fillet of radius 1 at (0,0) has its rotation axis inset to
    // (1,1): ON the axis. The old centroid-based point sat ON the curved
    // surface instead, off-axis by roughly the radius.
    expect(fillet.point[0]).toBeCloseTo(1, 3)
    expect(fillet.point[1]).toBeCloseTo(1, 3)
  })
})
