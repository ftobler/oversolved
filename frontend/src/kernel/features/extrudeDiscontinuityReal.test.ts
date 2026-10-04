// @vitest-environment node
//
// Regression for bugreports/extrude_discontinuous_20260703_174517.md.
//
// Same peanut-with-hole body that the extrude-add-hole-seam fix stabilised,
// but with a LARGE fillet (radius 5) on the two lobe-intersection edges before
// the top-face add.  The big fillet wraps so far into the inner (hole-cylinder)
// region that the multi-group prism's Cocylindrical-wall canonicalisation no
// longer makes the add-fuse merge continuously: extrude 2 ends up splitting every
// wall at z=10 (the extrude-2 profile outline plane).  The body must keep a
// single continuous B-rep -- no face split along the z=10 cap recovery plane.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { DisposeScope } from '../occ/disposeScope'
import { HandleTable } from '../occ/handleTable'
import { solidToMesh, solidToEdges, solidToVertices } from '../occ/tessellation'
import { brepDiffNewFaceHashes, brepDiffNewEdgeHashes, brepDiffNewVertexHashes } from '../occ/brepDiffHash'
import { build, type BuildDeps, type BuildResponse } from '../builder'
import { initGlobalRepo } from '../query'
import { createFeatureSolver } from '../solverRegistry'
import { postRegister } from '../features/postRegister'
import { setSketchSolver, resetSketchSolver } from '../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
const oc = await loadOcc()
const solveBytes = loadSolver()

// Exact peanut-with-hole sketch from the bug AST (entity ids preserved so the
// face / edge queries resolve to the same geometry).
const SK = '6pRTd41W5i8Ux58DLe2HoXwA'
const BODY1 = 'b9WPcaHhXLtCABRq9yR_GR84'

const peanutWithHoleSketch = {
  id: SK, kind: 'sketch', label: 'sketch 1', plane: '@builtin_plane_front', visible: false,
  entities: [
    { id: 'tAIT7LO2t-mfyDjZ', kind: 'circle' },  // LEFT lobe (center -6.614)
    { id: '4Az9tprfTrOkMYl7', kind: 'circle' },  // RIGHT lobe (center +6.614)
    { id: 'jSAuMvz_p3ieIewg', kind: 'line' },     // the chord line at x=0
    { id: '-cLbxUUuVmfr7yga', kind: 'point' },    // top intersection
    { id: 'aCJgpbTP4YLRUy4V', kind: 'point' },    // bottom intersection
    { id: 'MOV3k8CiX8vkv1ai', kind: 'circle' },   // the hole
  ],
  initial: {
    '-cLbxUUuVmfr7yga': [-5.666401792225884e-10, 15],
    '4Az9tprfTrOkMYl7': [6.614378452301025, 7.5, 10],
    'MOV3k8CiX8vkv1ai': [-6.614378452301025, 7.5, 5.703681945800781],
    'aCJgpbTP4YLRUy4V': [-2.0734318428861087e-10, -9.581109516876296e-11],
    'jSAuMvz_p3ieIewg': [-4.6335985048884254e-10, 15, -3.4213840094388104e-10, -2.674688803772085e-10],
    'tAIT7LO2t-mfyDjZ': [-6.614378452301025, 7.5, 10],
  },
  constraints: [
    { id: 'c_equal_length_UoPkejSs', kind: 'equal_length', a: '$4Az9tprfTrOkMYl7', b: '$tAIT7LO2t-mfyDjZ' },
    { id: 'c_coincident_znMNoZC7', kind: 'coincident', a: '$-cLbxUUuVmfr7ygaxy', b: '$tAIT7LO2t-mfyDjZ' },
    { id: 'c_coincident_wasOxKv9', kind: 'coincident', a: '$-cLbxUUuVmfr7ygaxy', b: '$4Az9tprfTrOkMYl7' },
    { id: 'c_coincident_VcijX4gc', kind: 'coincident', a: '$jSAuMvz_p3ieIewgstart', b: '$-cLbxUUuVmfr7ygaxy' },
    { id: 'c_coincident_AuHq7PiY', kind: 'coincident', a: '$aCJgpbTP4YLRUy4Vxy', b: '$tAIT7LO2t-mfyDjZ' },
    { id: 'c_coincident_8_UphUjz', kind: 'coincident', a: '$aCJgpbTP4YLRUy4Vxy', b: '$4Az9tprfTrOkMYl7' },
    { id: 'c_coincident_EaHQtUxi', kind: 'coincident', a: '$jSAuMvz_p3ieIewgend', b: '$aCJgpbTP4YLRUy4Vxy' },
    { id: 'c_vertical_FYc_Z2ik', kind: 'vertical', target: '$jSAuMvz_p3ieIewg' },
    { id: 'c_coincident_LyXWU0tj', kind: 'coincident', a: '@builtin_origin', b: '$aCJgpbTP4YLRUy4Vxy' },
    { id: 'c_length_7nwTkx7r', kind: 'length', target: '$jSAuMvz_p3ieIewg', value: 15 },
    { id: 'c_diameter_Ei5UQX_V', kind: 'diameter', target: '$4Az9tprfTrOkMYl7', value: 20 },
    { id: 'c_coincident_i9norqI4', kind: 'coincident', a: '$MOV3k8CiX8vkv1aicenter', b: '$tAIT7LO2t-mfyDjZcenter' },
  ],
}

// The four ring surfaces that bound the peanut-with-hole (the exact `sketch`
// profile entries in the bug AST, with two duplicated-key suffixes so each
// flatface is distinct).  Resolved lazily from the post-sketch topo snapshot.
function surfaceQueriesFromSketch(result: BuildResponse): string[] {
  const state = result._build_state as unknown as {
    checkpoints: Record<string, { repo_snapshot: { elements: Record<string, unknown> } }>
  }
  const cp = Object.values(state.checkpoints)[0]
  const topo = cp?.repo_snapshot?.elements?.['_topo_' + SK] as { surfaces?: Array<{ query?: string }> } | undefined
  return (topo?.surfaces ?? []).map((s) => s.query ?? '')
}

function topFaceQuery(result: BuildResponse, bodyId: string): string {
  const bd = (result.bodies as Record<string, Record<string, unknown>>)[bodyId] ?? {}
  const mesh = bd.mesh as {
    face_data?: Array<{ normal: number[]; surface_type?: string }>
    face_queries?: string[]
  } | undefined
  let q = ''
  mesh?.face_data?.forEach((fd, i) => {
    if (fd.normal[2] > 0.9 && fd.surface_type === 'flatface') q = mesh.face_queries?.[i] ?? ''
  })
  return q
}

describe.skipIf(!oc || !solveBytes)('extrude add of a body face after a large fillet keeps a continuous B-rep', () => {
  beforeAll(() => {
    if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) }
  })

  function run(spec: Record<string, unknown>) {
    const scope = new DisposeScope()
    const table = new HandleTable()
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
                createdBy: body.created_by || '', bodyId: body.id,
                faceAncestry: body.face_ancestry ?? null, faceNames: body.face_names ?? null,
                profileQueries: body.profile_queries ?? [],
              })
              const edgeResult = solidToEdges(oc!, table, body.shape, {
                createdBy: body.created_by || '', bodyId: body.id,
                profileQueries: body.profile_queries ?? [],
                edgeAncestry: body.edge_ancestry ?? null, edgeNames: body.edge_names ?? null,
              })
              const vertexResult = solidToVertices(oc!, table, body.shape, {
                createdBy: body.created_by || '', bodyId: body.id, profileQueries: body.profile_queries ?? [],
              })
              out[body.id] = {
                mesh, edges: edgeResult.edges, edge_queries: edgeResult.edge_queries,
                vertices: vertexResult.vertices, vertex_queries: vertexResult.vertex_queries,
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

  function res(result: BuildResponse, featureId: string): Record<string, unknown> {
    return (result.result as Record<string, Record<string, unknown>>)[featureId] ?? {}
  }

  function body(result: BuildResponse, bodyId: string): Record<string, unknown> {
    return (result.bodies as Record<string, Record<string, unknown>>)[bodyId] ?? {}
  }

  // Build only the first two features (sketch + ex1), pull out the last two
  // lobe-intersection straight edges for the fillet and the top-face query for
  // ex2's profile, then return the fully-built two-extrude-one-fillet spec.
  function buildSpec(filletRadius: number) {
    const surfs = surfaceQueriesFromSketch(run({ features: [peanutWithHoleSketch] }))
    // The hole sits on the LEFT lobe (tAIT7's center).  The 4 ring surfaces end
    // at the two hole-disk surfaces; slice the first four so ex1 keeps the hole.
    const profile = surfs.slice(0, 4)
    const r1 = run({
      features: [
        peanutWithHoleSketch,
        { id: BODY1, kind: 'extrude', label: 'extrude 1', sketch: profile, distance: 10, direction: 'normal' },
      ],
    })
    expect(res(r1, BODY1).status).toBe('ok')
    const edgeQueries = (body(r1, `body_${BODY1}`).edge_queries as string[]) ?? []
    const edges = (body(r1, `body_${BODY1}`).edges as Array<{
      kind?: string; start?: number[]; end?: number[]
    }>) ?? []
    // The two vertical lobe-intersection edges: straight edges at x~=0 spanning
    // z 0..10 (the lobe seam line).  Bind them to that, not to the face / arc
    // tag, so a tessellation or geometry tweak does not silently rebind.
    const vertEdgeIndex: number[] = []
    for (let i = 0; i < edges.length && vertEdgeIndex.length < 2; i++) {
      const e = edges[i]
      const s = e.start ?? [0, 0, 0]
      const en = e.end ?? [0, 0, 0]
      const vertical = Math.abs(s[0] - en[0]) < 1e-3 && Math.abs(s[1] - en[1]) < 1e-3 && Math.abs(s[2] - en[2]) > 1
      const onLensLine = Math.abs((s[0] + en[0]) / 2) < 0.2  // x ~= 0
      const spansBody = Math.min(s[2], en[2]) < 1e-2 && Math.max(s[2], en[2]) > 10 - 1e-2  // z 0..10
      if (vertical && onLensLine && spansBody) vertEdgeIndex.push(i)
    }
    expect(vertEdgeIndex).toHaveLength(2)
    const filletEdges = vertEdgeIndex.map((i) => edgeQueries[i]).filter((q) => !!q)
    expect(filletEdges).toHaveLength(2)
    const topQuery = topFaceQuery(r1, `body_${BODY1}`)
    expect(topQuery).not.toBe('')
    return {
      features: [
        peanutWithHoleSketch,
        { id: BODY1, kind: 'extrude', label: 'extrude 1', sketch: profile, distance: 10, direction: 'normal' },
        { id: 'fil1', kind: 'fillet', edges: filletEdges, radius: filletRadius },
        { id: 'ex2', kind: 'extrude', label: 'extrude 2', sketch: topQuery, distance: 10, direction: 'normal' },
      ],
    }
  }

  function wallSplitsAtZ10(fd: Array<{ centroid: number[]; normal: number[]; surface_type?: string }>): number {
    const walls = fd.filter((f) => Math.abs(f.normal[2]) < 0.9)
    let splitCount = 0
    for (const w of walls) {
      const cz = w.centroid[2]
      if (Math.abs(cz - 5) < 0.5 || Math.abs(cz - 15) < 0.5) splitCount++
    }
    return splitCount
  }

  it('no fillet: holes/outer walls continuous after add', () => {
    // Baseline: the existing fine-grained test already proves this case, but
    // check the split-signal our radius-5 case fails on so we trust the metric.
    const surfs = surfaceQueriesFromSketch(run({ features: [peanutWithHoleSketch] }))
    const profile = surfs.slice(0, 4)
    const r1 = run({
      features: [
        peanutWithHoleSketch,
        { id: BODY1, kind: 'extrude', label: 'extrude 1', sketch: profile, distance: 10, direction: 'normal' },
      ],
    })
    const topQuery = topFaceQuery(r1, `body_${BODY1}`)
    const result = run({
      features: [
        peanutWithHoleSketch,
        { id: BODY1, kind: 'extrude', label: 'extrude 1', sketch: profile, distance: 10, direction: 'normal' },
        { id: 'ex2', kind: 'extrude', label: 'extrude 2', sketch: topQuery, distance: 10, direction: 'normal' },
      ],
    })
    expect(res(result, 'ex2').status).toBe('ok')
    const fd = (body(result, `body_${BODY1}`).mesh as { face_data?: Array<{ centroid: number[]; normal: number[]; surface_type?: string }> }).face_data ?? []
    expect(wallSplitsAtZ10(fd)).toBe(0)
  })

  it('small fillet (radius 0.5): outer walls stay continuous after add', () => {
    const result = run(buildSpec(0.5))
    expect(res(result, 'ex2').status).toBe('ok')
    const fd = (body(result, `body_${BODY1}`).mesh as { face_data?: Array<{ centroid: number[]; normal: number[]; surface_type?: string }> }).face_data ?? []
    if ((import.meta.env.DEBUG_FACES ?? '') !== '') {
      console.log('radius 0.5 face count', fd.length)
      fd.forEach((f, i) => {
        console.log(i, f.surface_type, 'c', f.centroid.map((v) => v.toFixed(3)).join(','), 'n', f.normal.map((v) => v.toFixed(3)).join(','))
      })
    }
    expect(wallSplitsAtZ10(fd)).toBe(0)
  })

  it('large fillet (radius 5) then top-face add keeps a single continuous hole wall', () => {
    const result = run(buildSpec(5))
    expect(res(result, 'ex2').status).toBe('ok')
    const mesh = body(result, `body_${BODY1}`).mesh as {
      face_data?: Array<{ centroid: number[]; normal: number[]; surface_type?: string }>
    } | undefined
    const fd = mesh?.face_data ?? []

    // No wall -- planar (fillet-tangent at radius 5) or cylindrical -- may be
    // split at z=10 (the extrude-2 profile outline plane).  Every lateral wall
    // spans the full 0..20 range, so its centroid sits at z=10, NOT at z=5 or
    // z=15 (those half-spans are exactly the seam-split signal).  A flat cap's
    // normal has |z| ~= 1; walls are everything else -- filter them out.
    expect(wallSplitsAtZ10(fd)).toBe(0)

    // The hole cylinder specifically -- centered on tAIT7's center, the hole
    // radius 5.7037 -- is one continuous face across z 0..20.
    const holeCyls = fd.filter(
      (f) => f.surface_type === 'cylinderface' &&
        Math.abs(f.centroid[0] - (-6.614378452301025)) < 0.5 &&
        Math.abs(f.centroid[1] - 7.5) < 0.5,
    )
    expect(holeCyls).toHaveLength(1)
    expect(holeCyls[0].centroid[2]).toBeCloseTo(10, 0)
  })
})