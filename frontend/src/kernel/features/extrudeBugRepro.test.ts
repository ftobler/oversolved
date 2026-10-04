// @vitest-environment node
//
// Regression for bugreports/extrude_failing_20260621_213845.md.
//
// Two equal circles intersect at (0,0) and (0,15); a vertical line runs exactly
// along that chord (the radical line), with its endpoints pinned to those two
// intersection points. The solver converges the circle centre to a value ~1.7e-7
// off the ideal sqrt(43.75), so the radius-10 arc misses the shared vertex by
// ~1.5e-7. The arc's OCC endpoint is locked to its circle while the line's
// endpoint sits exactly on the vertex, so the joint gap (~1.5e-7) exceeds OCC's
// confusion tolerance and makeWire used to drop the arc edge ("only 1 of 2 edges
// connected"). buildWire now snaps the free line endpoint onto the arc endpoint,
// so the half-lens flatface extrudes into a single body.

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

const SK = '6pRTd41W5i8Ux58DLe2HoXwA'
// Flatface selection of the half-lens bounded by the right circle's left arc and
// the chord line (the exact token from the bug report).
const HALF_LENS = `?2a,2a,9,19;@${SK}/4Az9tprfTrOkMYl7@${SK}/jSAuMvz_p3ieIewgsurface:1@${SK}:flatface`
// The crescent bounded by both circle arcs (arc+arc joint, exercised for parity).
const CRESCENT = `?2a,2a,9,19;@${SK}/4Az9tprfTrOkMYl7@${SK}/tAIT7LO2t-mfyDjZsurface:2@${SK}:flatface`

function bugSpec(selection: string) {
  return {
    features: [
      { id: 'Origin', kind: 'origin' },
      { id: 'Top', kind: 'plane', visible: false },
      { id: 'Front', kind: 'plane', visible: false },
      { id: 'Right', kind: 'plane', visible: false },
      {
        id: SK, kind: 'sketch', label: 'sketch 1', plane: '@builtin_plane_front',
        entities: [
          { id: 'tAIT7LO2t-mfyDjZ', kind: 'circle' },
          { id: '4Az9tprfTrOkMYl7', kind: 'circle' },
          { id: 'jSAuMvz_p3ieIewg', kind: 'line' },
          { id: '-cLbxUUuVmfr7yga', kind: 'point' },
          { id: 'aCJgpbTP4YLRUy4V', kind: 'point' },
        ],
        initial: {
          '-cLbxUUuVmfr7yga': [-1.1227721877227204e-11, 15],
          '4Az9tprfTrOkMYl7': [6.614378452301025, 7.5, 10],
          'aCJgpbTP4YLRUy4V': [-4.583253047918401e-12, -4.0981915777615896e-11],
          'jSAuMvz_p3ieIewg': [-8.848310972808804e-12, 15, -6.6483849675558204e-12, -9.326887873140066e-11],
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
        ],
      },
      {
        id: 'b9WPcaHhXLtCABRq9yR_GR84', kind: 'extrude', label: 'extrude 1',
        extrude: { sketch: [selection], direction: 'normal', distance: 10 },
      },
    ],
  }
}

describe.skipIf(!oc || !solveBytes)('extrude radical-line half-lens (real OCC + Rust solver)', () => {
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

  it('half-lens flatface (arc + chord line) extrudes into one body', () => {
    const result = run(bugSpec(HALF_LENS))
    const ex = res(result, 'b9WPcaHhXLtCABRq9yR_GR84')
    expect(ex.status).toBe('ok')
    expect(Object.keys(result.bodies as Record<string, unknown>)).toHaveLength(1)
  })

  it('crescent flatface (arc + arc) extrudes into one body', () => {
    const result = run(bugSpec(CRESCENT))
    const ex = res(result, 'b9WPcaHhXLtCABRq9yR_GR84')
    expect(ex.status).toBe('ok')
    expect(Object.keys(result.bodies as Record<string, unknown>)).toHaveLength(1)
  })
})
