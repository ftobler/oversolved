// @vitest-environment node
//
// Gated real-OCC feature-level extrude tests using the full build pipeline
// (OCC.js + Rust WASM sketch solver). Ports the build-layer extrude scenarios
// from test_extrude_mesh.py.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { DisposeScope } from '../occ/disposeScope'
import { HandleTable } from '../occ/handleTable'
import { solidToMesh, solidToEdges, solidToVertices } from '../occ/tessellation'
import { brepDiffNewFaceHashes, brepDiffNewEdgeHashes, brepDiffNewVertexHashes } from '../occ/brepDiffHash'
import { build, repoFromSnapshot, type BuildDeps, type BuildResponse } from '../builder'
import { initGlobalRepo, makeAncestryQuery } from '../query'
import { createFeatureSolver } from '../solverRegistry'
import { postRegister } from '../features/postRegister'
import { setSketchSolver, resetSketchSolver } from '../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
const oc = await loadOcc()
const solveBytes = loadSolver()

function rectSketchSk(sketchId: string, w: number, h: number, plane = '@builtin_plane_front') {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane,
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: {
      bottom: [0, 0, w, 0],
      right: [w, 0, w, h],
      top: [w, h, 0, h],
      left: [0, h, 0, 0],
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

function extrudeSpec(sketchId: string, extrudeId: string, opts: {
  distance?: number; operation?: string; direction?: string; nested?: boolean
} = {}) {
  const distance = opts.distance ?? 5
  const direction = opts.direction ?? 'normal'
  const operation = opts.operation ?? 'add'
  if (opts.nested) {
    return {
      id: extrudeId, kind: 'extrude', label: 'Extrude',
      extrude: { sketch: '$' + sketchId, distance, direction, operation },
    }
  }
  return {
    id: extrudeId, kind: 'extrude', label: 'Extrude',
    sketch: '$' + sketchId, distance, direction, operation,
  }
}

function fullRectExtrudeSpec(w = 10, h = 10, d = 5, direction = 'normal') {
  return { features: [rectSketchSk('sk1', w, h), extrudeSpec('sk1', 'ex1', { distance: d, direction })] }
}

function assertMeshValid(mesh: Record<string, unknown>): void {
  const verts = mesh.vertices as number[][] | undefined
  const faces = mesh.faces as number[][] | undefined
  if (!verts || !faces) throw new Error('mesh missing vertices or faces')
  const n = verts.length
  if (n === 0) throw new Error('mesh has no vertices')
  if (faces.length === 0) throw new Error('mesh has no faces')
  for (let i = 0; i < faces.length; i++) {
    const [a, b, c] = faces[i]
    if (a < 0 || a >= n) throw new Error(`face ${i}: vertex a=${a} out of range [0,${n})`)
    if (b < 0 || b >= n) throw new Error(`face ${i}: vertex b=${b} out of range [0,${n})`)
    if (c < 0 || c >= n) throw new Error(`face ${i}: vertex c=${c} out of range [0,${n})`)
    if (a === b || b === c || a === c) throw new Error(`face ${i} is degenerate: (${a},${b},${c})`)
  }
}

function assertMeshBbox(mesh: Record<string, unknown>, xRange: [number, number], yRange: [number, number], zRange: [number, number], tol = 0.1): void {
  const verts = mesh.vertices as number[][] | undefined
  if (!verts) throw new Error('mesh missing vertices')
  const xs = verts.map((v) => v[0])
  const ys = verts.map((v) => v[1])
  const zs = verts.map((v) => v[2])
  const check = (vals: number[], lo: number, hi: number, axis: string) => {
    const actualLo = Math.min(...vals), actualHi = Math.max(...vals)
    if (actualLo < lo - tol) throw new Error(`${axis} min=${actualLo.toFixed(4)} expected >= ${lo}`)
    if (actualHi > hi + tol) throw new Error(`${axis} max=${actualHi.toFixed(4)} expected <= ${hi}`)
    if (actualLo > lo + tol) throw new Error(`${axis} min=${actualLo.toFixed(4)} not close to ${lo}`)
    if (actualHi < hi - tol) throw new Error(`${axis} max=${actualHi.toFixed(4)} not close to ${hi}`)
  }
  check(xs, xRange[0], xRange[1], 'x')
  check(ys, yRange[0], yRange[1], 'y')
  check(zs, zRange[0], zRange[1], 'z')
}

/** Two disjoint 2x2 rectangles in one sketch on the Front plane. */
function disjointTwoRectSpec(operation = 'new') {
  return {
    features: [
      {
        id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [
          { id: 'a_bot', kind: 'line' as const }, { id: 'a_right', kind: 'line' as const },
          { id: 'a_top', kind: 'line' as const }, { id: 'a_left', kind: 'line' as const },
          { id: 'b_bot', kind: 'line' as const }, { id: 'b_right', kind: 'line' as const },
          { id: 'b_top', kind: 'line' as const }, { id: 'b_left', kind: 'line' as const },
        ],
        initial: {
          a_bot: [0, 0, 2, 0], a_right: [2, 0, 2, 2], a_top: [2, 2, 0, 2], a_left: [0, 2, 0, 0],
          b_bot: [5, 0, 7, 0], b_right: [7, 0, 7, 2], b_top: [7, 2, 5, 2], b_left: [5, 2, 5, 0],
        },
        constraints: [
          { id: 'ca1', kind: 'coincident' as const, a: { entity: 'a_bot', point: 'end' as const }, b: { entity: 'a_right', point: 'start' as const } },
          { id: 'ca2', kind: 'coincident' as const, a: { entity: 'a_right', point: 'end' as const }, b: { entity: 'a_top', point: 'start' as const } },
          { id: 'ca3', kind: 'coincident' as const, a: { entity: 'a_top', point: 'end' as const }, b: { entity: 'a_left', point: 'start' as const } },
          { id: 'ca4', kind: 'coincident' as const, a: { entity: 'a_left', point: 'end' as const }, b: { entity: 'a_bot', point: 'start' as const } },
          { id: 'cb1', kind: 'coincident' as const, a: { entity: 'b_bot', point: 'end' as const }, b: { entity: 'b_right', point: 'start' as const } },
          { id: 'cb2', kind: 'coincident' as const, a: { entity: 'b_right', point: 'end' as const }, b: { entity: 'b_top', point: 'start' as const } },
          { id: 'cb3', kind: 'coincident' as const, a: { entity: 'b_top', point: 'end' as const }, b: { entity: 'b_left', point: 'start' as const } },
          { id: 'cb4', kind: 'coincident' as const, a: { entity: 'b_left', point: 'end' as const }, b: { entity: 'b_bot', point: 'start' as const } },
          { id: 'ha', kind: 'horizontal' as const, target: { entity: 'a_bot' } },
          { id: 'hb', kind: 'horizontal' as const, target: { entity: 'b_bot' } },
          { id: 'la', kind: 'length' as const, target: { entity: 'a_bot' }, value: 2 },
          { id: 'lb', kind: 'length' as const, target: { entity: 'b_bot' }, value: 2 },
        ],
      },
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 3, direction: 'normal', operation },
    ],
  }
}

/**
 * Two equal overlapping circles bisected by a vertical line through their two
 * intersection points (the segmented_surface_after_extrude bug report). The
 * sketch subdivides into four adjacent regions (two crescents + two lens halves)
 * that are all connected, so extruding the whole sketch must fuse into ONE body.
 */
function vennBisectSpec(operation = 'add') {
  return {
    features: [
      {
        id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [
          { id: 'cL', kind: 'circle' as const },
          { id: 'cR', kind: 'circle' as const },
          { id: 'ln', kind: 'line' as const },
          { id: 'pTop', kind: 'point' as const },
          { id: 'pBot', kind: 'point' as const },
        ],
        initial: {
          pTop: [0, 15],
          cR: [6.614378452301025, 7.5, 10],
          pBot: [0, 0],
          ln: [0, 15, 0, 0],
          cL: [-6.614378452301025, 7.5, 10],
        },
        constraints: [
          { id: 'eq', kind: 'equal_length' as const, a: '$cL', b: '$cR' },
          { id: 'co1', kind: 'coincident' as const, a: '$pTopxy', b: '$cR' },
          { id: 'co2', kind: 'coincident' as const, a: '$pTopxy', b: '$cL' },
          { id: 'co3', kind: 'coincident' as const, a: '$lnstart', b: '$pTopxy' },
          { id: 'co4', kind: 'coincident' as const, a: '$pBotxy', b: '$cR' },
          { id: 'co5', kind: 'coincident' as const, a: '$pBotxy', b: '$cL' },
          { id: 'co6', kind: 'coincident' as const, a: '$lnend', b: '$pBotxy' },
          { id: 'vert', kind: 'vertical' as const, target: '$ln' },
          { id: 'co7', kind: 'coincident' as const, a: '@builtin_origin', b: '$pBotxy' },
          { id: 'len', kind: 'length' as const, target: '$ln', value: 15 },
          { id: 'dia', kind: 'diameter' as const, target: '$cR', value: 20 },
        ],
      },
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'normal', operation },
    ],
  }
}

describe.skipIf(!oc || !solveBytes)('extrude feature (real OCC + Rust solver)', () => {
  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) }
  })

  function run(spec: Record<string, unknown>) {
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
                faceLineage: body.face_lineage ?? null,
                profileQueries: body.profile_queries ?? [],
              })
              const edgeResult = solidToEdges(oc!, table, body.shape, {
                createdBy: body.created_by || '',
                bodyId: body.id,
                profileQueries: body.profile_queries ?? [],
                edgeLineage: body.edge_lineage ?? null,
              })
              const vertexResult = solidToVertices(oc!, table, body.shape, {
                createdBy: body.created_by || '',
                bodyId: body.id,
                profileQueries: body.profile_queries ?? [],
              })
              out[body.id] = {
                mesh,
                edges: edgeResult.edges,
                edge_queries: edgeResult.edge_queries,
                vertices: vertexResult.vertices,
                vertex_queries: vertexResult.vertex_queries,
              }
            } catch { /* non-fatal */ }
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

  // ── Basic mesh / bbox tests ──────────────────────────────────────────────

  it('basic rect extrude produces a valid mesh', () => {
    const result = run(fullRectExtrudeSpec(10, 10, 5))
    expect(res(result, 'ex1').status).toBe('ok')
    const mesh = body(result, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshValid(mesh)
  })

  it('rect extrude bbox normal direction', () => {
    const result = run(fullRectExtrudeSpec(10, 8, 5, 'normal'))
    expect(res(result, 'ex1').status).toBe('ok')
    const mesh = body(result, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshBbox(mesh, [0, 10], [0, 8], [0, 5])
  })

  it('rect extrude bbox reverse direction', () => {
    const result = run(fullRectExtrudeSpec(6, 6, 4, 'reverse'))
    expect(res(result, 'ex1').status).toBe('ok')
    const mesh = body(result, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshBbox(mesh, [0, 6], [0, 6], [-4, 0])
  })

  it('rect extrude bbox symmetric direction', () => {
    const result = run(fullRectExtrudeSpec(4, 4, 6, 'symmetric'))
    expect(res(result, 'ex1').status).toBe('ok')
    const mesh = body(result, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshBbox(mesh, [0, 4], [0, 4], [-3, 3])
  })

  it('all face indices are valid', () => {
    const result = run(fullRectExtrudeSpec())
    expect(res(result, 'ex1').status).toBe('ok')
    const mesh = body(result, 'body_ex1').mesh as { vertices: number[][]; faces: number[][] } | undefined
    expect(mesh).toBeDefined()
    if (mesh) {
      const n = mesh.vertices.length
      for (const [a, b, c] of mesh.faces) {
        expect(a).toBeGreaterThanOrEqual(0); expect(a).toBeLessThan(n)
        expect(b).toBeGreaterThanOrEqual(0); expect(b).toBeLessThan(n)
        expect(c).toBeGreaterThanOrEqual(0); expect(c).toBeLessThan(n)
      }
    }
  })

  it('no degenerate faces', () => {
    const result = run(fullRectExtrudeSpec())
    expect(res(result, 'ex1').status).toBe('ok')
    const mesh = body(result, 'body_ex1').mesh as { vertices: number[][]; faces: number[][] } | undefined
    expect(mesh).toBeDefined()
    if (mesh) {
      for (const [a, b, c] of mesh.faces) {
        expect(a).not.toBe(b)
        expect(b).not.toBe(c)
        expect(a).not.toBe(c)
      }
    }
  })

  // ── Nested UI format / bare plane id ─────────────────────────────────────

  it('nested extrude UI format produces valid mesh', () => {
    /** Regression: UI serializes extrude as {kind, id, extrude: {sketch, distance,...}}. */
    const result = run({
      features: [
        {
          id: 'sk1', kind: 'sketch', plane: 'Top',
          entities: [{ id: 'c1', kind: 'circle' }],
          initial: { c1: [0, 0, 0.5] },
          constraints: [
            { id: 'co1', kind: 'coincident', a: '$sk1c1center', b: '@builtin_origin' },
            { id: 'd1', kind: 'diameter', target: '$sk1c1', value: 1 },
          ],
        },
        { id: 'ex1', kind: 'extrude', label: 'extrude 1',
          extrude: { sketch: '$sk1', distance: 2, direction: 'normal' } },
      ],
    })
    expect(res(result, 'sk1').status).not.toBe('exception')
    expect(res(result, 'ex1').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_ex1')
    const mesh = body(result, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshBbox(mesh, [-0.5, 0.5], [0, 2], [-0.5, 0.5])
  })

  it('bare builtin plane id is resolved', () => {
    /** Bare plane id 'Top' (no @ prefix) must resolve to the correct builtin plane. */
    const result = run({
      features: [
        {
          id: 'sk1', kind: 'sketch', plane: 'Top',
          entities: [{ id: 'c1', kind: 'circle' }],
          initial: { c1: [0, 0, 0.5] },
          constraints: [
            { id: 'co1', kind: 'coincident', a: '$sk1c1center', b: '@builtin_origin' },
            { id: 'd1', kind: 'diameter', target: '$sk1c1', value: 1 },
          ],
        },
        { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 2, direction: 'normal' },
      ],
    })
    expect(res(result, 'sk1').status).not.toBe('exception')
    expect(res(result, 'ex1').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_ex1')
    const mesh = body(result, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshBbox(mesh, [-0.5, 0.5], [0, 2], [-0.5, 0.5])
  })

  it('circle sketch with ghost line constraints still extrudes', () => {
    /** Ghost constraints referencing non-existent line entities must be ignored. */
    const result = run({
      features: [
        {
          id: 'sk1', kind: 'sketch', plane: 'Top',
          entities: [{ id: 'circ1', kind: 'circle' }],
          initial: { circ1: [0, 0, 0.5] },
          constraints: [
            { id: 'c_co', kind: 'coincident', a: '$sk1circ1center', b: '@builtin_origin' },
            { id: 'c_diam', kind: 'diameter', target: '$sk1circ1', value: 1 },
            { id: 'c_ghost1', kind: 'coincident', a: '$sk1line1end', b: '$sk1line2start' },
            { id: 'c_ghost2', kind: 'equal_length', a: '$sk1line1', b: '$sk1line3' },
            { id: 'c_ghost3', kind: 'horizontal', target: '$sk1line1' },
          ],
        },
        { id: 'ex1', kind: 'extrude', label: 'extrude 1',
          extrude: { sketch: '$sk1', distance: 1, direction: 'normal' } },
      ],
    })
    expect(res(result, 'sk1').status).not.toBe('exception')
    expect(res(result, 'ex1').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_ex1')
    const mesh = body(result, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshValid(mesh)
  })

  // ── Top face plane / stacked extrudes ────────────────────────────────────

  it('top face plane is at correct z', () => {
    /**
     * The top face centroid must be at z=distance. The plane feature kind is not ported to the
     * TS kernel, so test directly via mesh face_data z-coordinates.
     */
    const d = 7
    const result = run({
      features: [
        rectSketchSk('sk1', 10, 10, '@builtin_plane_front'),
        extrudeSpec('sk1', 'ex1', { distance: d }),
      ],
    })
    expect(res(result, 'ex1').status).toBe('ok')
    const mesh = body(result, 'body_ex1').mesh as { face_data?: Array<{ centroid: number[]; normal: number[] }> } | undefined
    expect(mesh).toBeDefined()
    const topFace = mesh?.face_data?.find((fd) => fd.normal[2] > 0.9)
    expect(topFace).toBeDefined()
    expect(topFace!.centroid[2]).toBeCloseTo(d, 0)
  })

  it('two extrudes stacked one on top of the other', () => {
    /** Second extrude on top of first with operation=new. */
    const result = run({
      features: [
        rectSketchSk('sk1', 10, 10, '@builtin_plane_front'),
        extrudeSpec('sk1', 'ex1', { distance: 5 }),
        {
          id: 'sk2', kind: 'sketch', plane: '@ex1/top_face',
          entities: [
            { id: 'bottom', kind: 'line' }, { id: 'right', kind: 'line' },
            { id: 'top', kind: 'line' }, { id: 'left', kind: 'line' },
          ],
          initial: {
            bottom: [0, 0, 4, 0], right: [4, 0, 4, 4],
            top: [4, 4, 0, 4], left: [0, 4, 0, 0],
          },
          constraints: [
            { id: 'c1', kind: 'coincident', a: { entity: 'bottom', point: 'end' }, b: { entity: 'right', point: 'start' } },
            { id: 'c2', kind: 'coincident', a: { entity: 'right', point: 'end' }, b: { entity: 'top', point: 'start' } },
            { id: 'c3', kind: 'coincident', a: { entity: 'top', point: 'end' }, b: { entity: 'left', point: 'start' } },
            { id: 'c4', kind: 'coincident', a: { entity: 'left', point: 'end' }, b: { entity: 'bottom', point: 'start' } },
            { id: 'c5', kind: 'horizontal', target: { entity: 'bottom' } },
            { id: 'c6', kind: 'horizontal', target: { entity: 'top' } },
            { id: 'c7', kind: 'vertical', target: { entity: 'right' } },
            { id: 'c8', kind: 'vertical', target: { entity: 'left' } },
            { id: 'c9', kind: 'length', target: { entity: 'bottom' }, value: 4 },
            { id: 'c10', kind: 'length', target: { entity: 'left' }, value: 4 },
          ],
        },
        extrudeSpec('sk2', 'ex2', { distance: 3, operation: 'new' }),
      ],
    })
    expect(res(result, 'ex1').status).toBe('ok')
    expect(res(result, 'ex2').status).toBe('ok')
    const mesh2 = body(result, 'body_ex2').mesh as { vertices: number[][] } | undefined
    expect(mesh2).toBeDefined()
    if (mesh2) {
      const zs = mesh2.vertices.map((v) => v[2])
      expect(Math.min(...zs)).toBeCloseTo(5, 0)
      expect(Math.max(...zs)).toBeCloseTo(8, 0)
    }
  })

  // ── Surface queries ──────────────────────────────────────────────────────

  it('extrude from sketch surface query (circle profile)', () => {
    /** Extrude uses a ?-ancestry query for a sketch surface flatface as the profile. */
    const surfaceQuery = makeAncestryQuery(['@sk1/c1', 'surface:0', '@sk1'], 'flatface')
    const result = run({
      features: [
        {
          id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
          entities: [{ id: 'c1', kind: 'circle' }],
          initial: { c1: [0, 0, 0.5] },
          constraints: [
            { id: 'co1', kind: 'coincident', a: '$sk1c1center', b: '@builtin_origin' },
            { id: 'd1', kind: 'diameter', target: '$sk1c1', value: 1 },
          ],
        },
        { id: 'ex1', kind: 'extrude', sketch: surfaceQuery, distance: 2, direction: 'normal' },
      ],
    })
    expect(res(result, 'sk1').status).not.toBe('exception')
    expect(res(result, 'ex1').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_ex1')
    const mesh = body(result, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshValid(mesh)
  })

  it('extrude uses only selected surface, not whole sketch', () => {
    /** When a sketch has two circles and one is selected via ?, only that surface is extruded. */
    const sk = 'sk1'
    const surfaceQuery = makeAncestryQuery([`@${sk}/c2`, 'surface:1', `@${sk}`], 'flatface')
    const result = run({
      features: [
        {
          id: sk, kind: 'sketch', plane: '@builtin_plane_front',
          entities: [{ id: 'c1', kind: 'circle' }, { id: 'c2', kind: 'circle' }],
          initial: { c1: [0, 0, 0.5], c2: [3, 0, 0.5] },
          constraints: [
            { id: 'co1', kind: 'coincident', a: `$${sk}c1center`, b: '@builtin_origin' },
            { id: 'd1', kind: 'diameter', target: `$${sk}c1`, value: 1 },
            { id: 'd2', kind: 'diameter', target: `$${sk}c2`, value: 1 },
          ],
        },
        { id: 'ex1', kind: 'extrude', sketch: surfaceQuery, distance: 1, direction: 'normal' },
      ],
    })
    expect(res(result, 'ex1').status).toBe('ok')
    const mesh = body(result, 'body_ex1').mesh as { vertices: number[][] } | undefined
    expect(mesh).toBeDefined()
    if (mesh) {
      const xs = mesh.vertices.map((v) => v[0])
      expect(Math.min(...xs)).toBeGreaterThan(1)  // c2 is near x=3, c1 at origin must not be included
    }
  })

  it('extrude from top face named query (@ex1/top_face)', () => {
    /** Second extrude uses @ex1/top_face as its profile. */
    const result = run({
      features: [
        rectSketchSk('sk1', 10, 10, '@builtin_plane_front'),
        extrudeSpec('sk1', 'ex1', { distance: 5 }),
        { id: 'ex2', kind: 'extrude', sketch: '@ex1/top_face', distance: 3, direction: 'normal', operation: 'new' },
      ],
    })
    expect(res(result, 'ex1').status).toBe('ok')
    expect(res(result, 'ex2').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_ex2')
    const mesh2 = body(result, 'body_ex2').mesh as { vertices: number[][] } | undefined
    expect(mesh2).toBeDefined()
    if (mesh2) {
      const zs = mesh2.vertices.map((v) => v[2])
      expect(Math.min(...zs)).toBeCloseTo(5, 0)
      expect(Math.max(...zs)).toBeCloseTo(8, 0)
    }
  })

  // ── Sketch list tests ────────────────────────────────────────────────────

  it('extrude sketch list with two profiles produces one body', () => {
    /** sketch field as a list of two sketch refs. */
    const result = run({
      features: [
        rectSketchSk('sk1', 2, 2, '@builtin_plane_front'),
        rectSketchSk('sk2', 2, 2, '@builtin_plane_front'),
        { id: 'ex1', kind: 'extrude', sketch: ['$sk1', '$sk2'], distance: 3, direction: 'normal' },
      ],
    })
    expect(res(result, 'ex1').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_ex1')
    const mesh = body(result, 'body_ex1').mesh as { vertices: number[][]; faces: number[][] } | undefined
    expect(mesh).toBeDefined()
    if (mesh) {
      expect(mesh.vertices.length).toBeGreaterThan(0)
      expect(mesh.faces.length).toBeGreaterThan(0)
    }
  })

  it('extrude sketch list with single element', () => {
    /** A list with one sketch ref behaves like the string form. */
    const result = run({
      features: [
        rectSketchSk('sk1', 4, 4, '@builtin_plane_front'),
        { id: 'ex1', kind: 'extrude', sketch: ['$sk1'], distance: 2, direction: 'normal' },
      ],
    })
    expect(res(result, 'ex1').status).toBe('ok')
    const mesh = body(result, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshBbox(mesh, [0, 4], [0, 4], [0, 2])
  })

  it('extrude sketch empty list errors', () => {
    /** Empty sketch list returns exception. */
    const result = run({
      features: [{ id: 'ex1', kind: 'extrude', sketch: [], distance: 2 }],
    })
    expect(res(result, 'ex1').status).toBe('exception')
  })

  it('extrude sketch not found returns exception', () => {
    /** Extrude with a sketch ref that has no closed profile returns exception. */
    const result = run({
      features: [
        {
          id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
          entities: [{ id: 'L1', kind: 'line' }],
          constraints: [{ id: 'c1', kind: 'horizontal', target: { entity: 'L1' } }],
        },
        { id: 'ex1', kind: 'extrude', sketch: ['@sk1'], distance: 5 },
      ],
    })
    expect(res(result, 'ex1').status).toBe('exception')
  })

  it('extrude key error still returns exception dict', () => {
    /** A KeyError-like situation must yield exception status. */
    const result = run({
      features: [{ id: 'ex1', kind: 'extrude', sketch: [] }],
    })
    expect(res(result, 'ex1').status).toBe('exception')
  })

  // ── Cut extrude tests ────────────────────────────────────────────────────

  it('cut extrude removes volume from base body', () => {
    /** Cut extrusion subtracts from a base body. */
    const result = run({
      features: [
        rectSketchSk('sk1', 10, 10, '@builtin_plane_front'),
        extrudeSpec('sk1', 'ex1', { distance: 10 }),
        extrudeSpec('sk1', 'ex2', { distance: 5, operation: 'cut' }),
      ],
    })
    expect(res(result, 'ex1').status).toBe('ok')
    expect(res(result, 'ex2').status).toBe('ok')
    expect(result.bodies).not.toHaveProperty('body_ex2')
    expect(result.bodies).toHaveProperty('body_ex1')
    const mesh = body(result, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshBbox(mesh, [0, 10], [0, 10], [5, 10])
  })

  it('cut extrude must not produce a body in output', () => {
    /** Cut extrude feature must not produce a body in the bodies dict. */
    const result = run({
      features: [
        rectSketchSk('sk1', 6, 6, '@builtin_plane_front'),
        extrudeSpec('sk1', 'ex1', { distance: 8 }),
        extrudeSpec('sk1', 'ex2', { distance: 4, operation: 'cut' }),
      ],
    })
    expect(result.bodies).not.toHaveProperty('body_ex2')
    expect(result.bodies).toHaveProperty('body_ex1')
  })

  it('cut extrude nested UI format', () => {
    /** Cut operation read from nested extrude sub-dict. */
    const result = run({
      features: [
        rectSketchSk('sk1', 10, 10, '@builtin_plane_front'),
        { id: 'ex1', kind: 'extrude', label: 'Base',
          extrude: { sketch: '$sk1', distance: 10, direction: 'normal' } },
        { id: 'ex2', kind: 'extrude', label: 'Cut',
          extrude: { sketch: '$sk1', distance: 5, direction: 'normal', operation: 'cut' } },
      ],
    })
    expect(res(result, 'ex1').status).toBe('ok')
    expect(res(result, 'ex2').status).toBe('ok')
    expect(result.bodies).not.toHaveProperty('body_ex2')
    expect(result.bodies).toHaveProperty('body_ex1')
    const mesh = body(result, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshBbox(mesh, [0, 10], [0, 10], [5, 10])
  })

  it('cut extrude with no prior body succeeds without crash', () => {
    /** Cut extrude with no prior body must succeed. */
    const result = run({
      features: [
        rectSketchSk('sk1', 6, 6, '@builtin_plane_front'),
        extrudeSpec('sk1', 'ex1', { distance: 5, operation: 'cut' }),
      ],
    })
    expect(res(result, 'ex1').status).toBe('ok')
    expect(result.bodies).not.toHaveProperty('body_ex1')
  })

  // ── Disjoint body tests ──────────────────────────────────────────────────

  it('disjoint rects operation=new creates two bodies', () => {
    /** Two disjoint sketch profiles with operation=new produce two separate bodies. */
    const result = run(disjointTwoRectSpec('new'))
    expect(res(result, 'ex1').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_ex1')
    expect(result.bodies).toHaveProperty('body_ex1_1')
    expect(res(result, 'ex1').body_ids).toEqual(['body_ex1', 'body_ex1_1'])
    const m1 = body(result, 'body_ex1').mesh as Record<string, unknown> | undefined
    const m2 = body(result, 'body_ex1_1').mesh as Record<string, unknown> | undefined
    expect(m1).toBeDefined(); if (m1) assertMeshValid(m1)
    expect(m2).toBeDefined(); if (m2) assertMeshValid(m2)
  })

  it('disjoint rects add no base creates two bodies', () => {
    /** Two profiles with operation=add and no existing body produce two bodies. */
    const result = run(disjointTwoRectSpec('add'))
    expect(res(result, 'ex1').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_ex1')
    expect(result.bodies).toHaveProperty('body_ex1_1')
  })

  it('disjoint rects add with base fuses into base body', () => {
    /** Disjoint profiles with operation=add and an existing body fuse into that body. */
    const spec = disjointTwoRectSpec('add')
    const result = run({
      features: [
        rectSketchSk('sk0', 2, 2, '@builtin_plane_front'),
        extrudeSpec('sk0', 'ex0', { distance: 1, operation: 'new' }),
        ...spec.features,
      ],
    })
    expect(res(result, 'ex1').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_ex0')
    expect(result.bodies).not.toHaveProperty('body_ex1_1')  // fused into base body
  })

  it('single rect still one body', () => {
    /** Single rectangle extrude still produces exactly one body. */
    const result = run(fullRectExtrudeSpec(4, 4, 2))
    expect(res(result, 'ex1').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_ex1')
    expect(result.bodies).not.toHaveProperty('body_ex1_1')
    expect(res(result, 'ex1').body_ids).toEqual(['body_ex1'])
  })

  it('disjoint extrude has body_ids field', () => {
    /** body_ids field lists all split body IDs. */
    const result = run(disjointTwoRectSpec('new'))
    const bodyIds = res(result, 'ex1').body_ids as string[] | undefined
    expect(bodyIds).toBeDefined()
    expect(new Set(bodyIds)).toEqual(new Set(['body_ex1', 'body_ex1_1']))
  })

  it('two independent extrudes produce two bodies', () => {
    /** Two independent sketches extruded independently. */
    const result = run({
      features: [
        rectSketchSk('sk1', 10, 10, '@builtin_plane_front'),
        extrudeSpec('sk1', 'ex1', { distance: 5 }),
        rectSketchSk('sk2', 5, 5, '@builtin_plane_front'),
        extrudeSpec('sk2', 'ex2', { distance: 3, operation: 'new' }),
      ],
    })
    expect(result.bodies).toHaveProperty('body_ex1')
    expect(result.bodies).toHaveProperty('body_ex2')
    expect(Object.keys(result.bodies)).toHaveLength(2)
  })

  it('disjoint bodies have unique face queries', () => {
    /** Two-body extrude face queries must be unique per body. */
    const result = run(disjointTwoRectSpec('new'))
    expect(res(result, 'ex1').status).toBe('ok')
    const m1 = body(result, 'body_ex1').mesh as { face_queries?: string[] } | undefined
    const m2 = body(result, 'body_ex1_1').mesh as { face_queries?: string[] } | undefined
    expect(m1?.face_queries?.length).toBeGreaterThan(0)
    expect(m2?.face_queries?.length).toBeGreaterThan(0)
    const fq1 = new Set(m1?.face_queries ?? [])
    const fq2 = new Set(m2?.face_queries ?? [])
    for (const q of fq1) expect(fq2.has(q)).toBe(false)
  })

  it('disjoint bodies have unique edge queries', () => {
    /** Edge queries from two bodies of the same extrude must be disjoint. */
    const result = run(disjointTwoRectSpec('new'))
    expect(res(result, 'ex1').status).toBe('ok')
    const eq1 = new Set((body(result, 'body_ex1').edge_queries as string[]) ?? [])
    const eq2 = new Set((body(result, 'body_ex1_1').edge_queries as string[]) ?? [])
    expect(eq1.size).toBeGreaterThan(0)
    expect(eq2.size).toBeGreaterThan(0)
    for (const q of eq1) expect(eq2.has(q)).toBe(false)
  })

  it('disjoint bodies have unique vertex queries', () => {
    /** Vertex queries from two bodies of the same extrude must be disjoint. */
    const result = run(disjointTwoRectSpec('new'))
    expect(res(result, 'ex1').status).toBe('ok')
    const vq1 = new Set((body(result, 'body_ex1').vertex_queries as string[]) ?? [])
    const vq2 = new Set((body(result, 'body_ex1_1').vertex_queries as string[]) ?? [])
    expect(vq1.size).toBeGreaterThan(0)
    expect(vq2.size).toBeGreaterThan(0)
    for (const q of vq1) expect(vq2.has(q)).toBe(false)
  })

  // ── Disjoint pick body / face query resolve ──────────────────────────────

  it('disjoint pick_body by feature id returns first split body', () => {
    /** @ex1 resolves to the first split body. */
    const result = run(disjointTwoRectSpec('new'))
    expect(result.bodies).toHaveProperty('body_ex1')
    expect(result.bodies).toHaveProperty('body_ex1_1')
  })

  it('disjoint bodies face queries resolve to correct body', () => {
    /** Each face query must resolve to the body it belongs to. */
    const result = run(disjointTwoRectSpec('new'))
    expect(res(result, 'ex1').status).toBe('ok')
    const buildState = result._build_state
    const lastFid = buildState!.feature_order[buildState!.feature_order.length - 1]
    const checkpoint = buildState!.checkpoints[lastFid]
    const repo = repoFromSnapshot(checkpoint.repo_snapshot as Record<string, unknown>)
    for (const bid of ['body_ex1', 'body_ex1_1']) {
      const b = body(result, bid) as { mesh?: { face_queries?: string[] } }
      const faceQueries = b?.mesh?.face_queries ?? []
      for (const fq of faceQueries) {
        const r = repo.query(fq) as { body_id?: string } | null
        expect(r).toBeDefined()
        expect(r?.body_id).toBe(bid)
      }
    }
  })

  it('disjoint body face query usable in downstream feature', () => {
    /** A face query from the secondary body can be used as a plane without AmbiguousQueryError. */
    const r1 = run(disjointTwoRectSpec('new'))
    expect(res(r1, 'ex1').status).toBe('ok')

    const faceData = (body(r1, 'body_ex1_1').mesh as { face_data?: Array<{ surface_type?: string }> } | undefined)?.face_data ?? []
    const faceQueries = (body(r1, 'body_ex1_1').mesh as { face_queries?: string[] } | undefined)?.face_queries ?? []
    let flatQuery: string | undefined
    for (let i = 0; i < faceData.length; i++) {
      if (faceData[i].surface_type === 'flatface') { flatQuery = faceQueries[i]; break }
    }
    expect(flatQuery).toBeDefined()

    const sk2 = rectSketchSk('sk2', 2, 2, flatQuery!)
    const spec2 = { ...disjointTwoRectSpec('new'), features: [...disjointTwoRectSpec('new').features, sk2] }

    const r2 = run(spec2)
    const sk2Result = res(r2, 'sk2')
    expect(sk2Result.plane_transform).toBeDefined()
  })

  // ── Slash query extrude ──────────────────────────────────────────────────

  it('extrude from slash-style brep face query (@feature/face/N)', () => {
    /** Slash-style B-rep face IDs resolve as extrude profiles. */
    const result = run({
      features: [
        rectSketchSk('sk1', 10, 10, '@builtin_plane_front'),
        extrudeSpec('sk1', 'ex1', { distance: 5 }),
        { id: 'ex2', kind: 'extrude', sketch: '@ex1/face/0', distance: 3, direction: 'normal', operation: 'new' },
      ],
    })
    expect(res(result, 'ex2').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_ex2')
    const mesh2 = body(result, 'body_ex2').mesh as { vertices: number[][] } | undefined
    expect(mesh2).toBeDefined()
    if (mesh2) {
      const xs = mesh2.vertices.map((v) => v[0])
      const ys = mesh2.vertices.map((v) => v[1])
      const zs = mesh2.vertices.map((v) => v[2])
      const spans = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), Math.max(...zs) - Math.min(...zs)]
      expect(spans.some((s) => Math.abs(s - 3) < 0.25)).toBe(true)
    }
  })

  // ── Fillet + extrude chain (face query after fillet topology change) ──

  it('extrude from brep face after fillet', () => {
    /**
     * Extrude uses a face query from a body that was modified by a fillet. Regression: after
     * fillet changes body topology, face index ordering in face-loop extraction must match
     * solid_to_mesh.
     */
    const d = 5
    // Step 1: build extrude-only to find edge queries and a flat side face
    const r1 = run({
      features: [
        rectSketchSk('sk1', 10, 10, '@builtin_plane_front'),
        extrudeSpec('sk1', 'ex1', { distance: d }),
      ],
    })
    expect(res(r1, 'ex1').status).toBe('ok')

    // Find a flat side face (centroid z ~ d/2) and build a 3-tag query.
    const mesh1 = body(r1, 'body_ex1').mesh as {
      face_data?: Array<{ centroid: number[]; surface_type?: string }>
    } | undefined
    let bestQ: string | undefined
    if (mesh1?.face_data) {
      for (let idx = 0; idx < mesh1.face_data.length; idx++) {
        const fd = mesh1.face_data[idx]
        if (Math.abs(fd.centroid[2] - d / 2) < 0.1 && fd.surface_type === 'flatface') {
          bestQ = makeAncestryQuery([`@body_ex1/face${idx}`, '@ex1', '@body_ex1'], 'flatface')
          break
        }
      }
    }
    expect(bestQ).toBeDefined()

    // Step 2: full build with extrude + fillet + extrude from face.
    const eq = (body(r1, 'body_ex1').edge_queries as string[]) ?? []
    const spec2 = {
      features: [
        rectSketchSk('sk1', 10, 10, '@builtin_plane_front'),
        extrudeSpec('sk1', 'ex1', { distance: d }),
        { id: 'fil1', kind: 'fillet', edges: [eq[0], eq[1]], radius: 0.5 },
        { id: 'ex2', kind: 'extrude', sketch: bestQ!, distance: 3, direction: 'normal', operation: 'new' },
      ],
    }
    const r2 = run(spec2)
    expect(res(r2, 'ex2').status).toBe('ok')
    expect(r2.bodies).toHaveProperty('body_ex2')
    const m2 = body(r2, 'body_ex2').mesh as Record<string, unknown> | undefined
    expect(m2).toBeDefined()
    if (m2) assertMeshValid(m2)
  })

  // ── Math-expression distance (kernel/evalExpr) ───────────────────────────

  it('extrude distance as an expression string resolves before solve', () => {
    // "20/4" must evaluate to 5 so the prism reaches z=5, exactly like a
    // plain numeric distance of 5.
    const spec = { features: [rectSketchSk('sk1', 10, 8), extrudeSpec('sk1', 'ex1', {})] }
    ;(spec.features[1] as Record<string, unknown>).distance = '20/4'
    const result = run(spec)
    expect(res(result, 'ex1').status).toBe('ok')
    const mesh = body(result, 'body_ex1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshBbox(mesh, [0, 10], [0, 8], [0, 5])
  })

  it('adjacent subdivided regions fuse into one body', () => {
    /** Regression: segmented_surface_after_extrude. Four connected sketch regions
     *  extruded together must fuse into a single solid, not split into bodies. */
    const result = run(vennBisectSpec('add'))
    expect(res(result, 'ex1').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_ex1')
    expect(result.bodies).not.toHaveProperty('body_ex1_1')
    expect(Object.keys(result.bodies)).toHaveLength(1)
    const mesh = body(result, 'body_ex1').mesh as {
      face_data?: Array<{ centroid: number[]; surface_type?: string }>
    } | undefined
    const fd = mesh?.face_data ?? []
    const topFlats = fd.filter((f) => f.surface_type === 'flatface' && Math.abs(f.centroid[2] - 10) < 0.1)
    expect(topFlats).toHaveLength(1)
  })

  it('adjacent regions selected individually fuse into one body', () => {
    /** Regression: segmented_surface_after_extrude. The four connected regions
     *  selected one by one (the user's exact order) must still fuse into one
     *  solid -- the extrude must not be order-sensitive. */
    const sketch = vennBisectSpec().features[0]
    const refs = [
      '?7,7,9,4;@sk1/cR@sk1/lnsurface:1@sk1:flatface',
      '?7,7,9,4;@sk1/cL@sk1/cRsurface:3@sk1:flatface',
      '?7,7,9,4;@sk1/cL@sk1/lnsurface:0@sk1:flatface',
      '?7,7,9,4;@sk1/cL@sk1/cRsurface:2@sk1:flatface',
    ]
    const result = run({
      features: [sketch, { id: 'ex1', kind: 'extrude', sketch: refs, distance: 10, direction: 'normal', operation: 'add' }],
    })
    expect(res(result, 'ex1').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_ex1')
    expect(result.bodies).not.toHaveProperty('body_ex1_1')
    expect(Object.keys(result.bodies)).toHaveLength(1)
    // The swept top must be ONE planar face, not segmented per source region.
    const mesh = body(result, 'body_ex1').mesh as {
      face_data?: Array<{ centroid: number[]; surface_type?: string }>
    } | undefined
    const fd = mesh?.face_data ?? []
    const topFlats = fd.filter((f) => f.surface_type === 'flatface' && Math.abs(f.centroid[2] - 10) < 0.1)
    const botFlats = fd.filter((f) => f.surface_type === 'flatface' && Math.abs(f.centroid[2]) < 0.1)
    expect(topFlats).toHaveLength(1)
    expect(botFlats).toHaveLength(1)
  })

  it('invalid distance expression surfaces as a feature exception', () => {
    const spec = { features: [rectSketchSk('sk1', 10, 8), extrudeSpec('sk1', 'ex1', {})] }
    ;(spec.features[1] as Record<string, unknown>).distance = '2+/'
    const result = run(spec)
    expect(res(result, 'ex1').status).toBe('exception')
    expect(String(res(result, 'ex1').exception)).toContain('2+/')
  })

  // ── Editing handle descriptor ────────────────────────────────────────────

  function handleOf(result: BuildResponse, featureId: string): Record<string, unknown> {
    const h = res(result, featureId).handle as Record<string, unknown> | undefined
    expect(h).toBeDefined()
    return h!
  }

  function expectVecClose(v: unknown, expected: number[]): void {
    const arr = v as number[]
    expect(arr).toHaveLength(expected.length)
    for (let i = 0; i < expected.length; i++) expect(arr[i]).toBeCloseTo(expected[i], 4)
  }

  it('blind extrude emits a linear distance handle at the swept face centroid', () => {
    const result = run(fullRectExtrudeSpec(10, 10, 5))
    const h = handleOf(result, 'ex1')
    expect(h.kind).toBe('linear')
    expect(h.field).toBe('distance')
    expect(h.value).toBe(5)
    expect(h.unit_scale).toBe(1)
    expectVecClose(h.direction, [0, 0, 1])
    expectVecClose(h.anchor, [5, 5, 5])
  })

  it('reverse extrude handle points the other way', () => {
    const result = run(fullRectExtrudeSpec(10, 10, 5, 'reverse'))
    const h = handleOf(result, 'ex1')
    expectVecClose(h.direction, [0, 0, -1])
    expectVecClose(h.anchor, [5, 5, -5])
  })

  it('symmetric extrude handle grabs the half-distance face at half scale', () => {
    const result = run(fullRectExtrudeSpec(10, 10, 8, 'symmetric'))
    const h = handleOf(result, 'ex1')
    expect(h.unit_scale).toBe(0.5)
    expectVecClose(h.anchor, [5, 5, 4])
  })

  it('up_to extrude emits no distance handle', () => {
    const spec = {
      features: [
        rectSketchSk('sk1', 10, 10),
        { id: 'pl1', kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_front', offset: 7 } },
        { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 5, termination: 'up_to', up_to: '@pl1', operation: 'new' },
      ],
    }
    const result = run(spec)
    expect(res(result, 'ex1').status).toBe('ok')
    expect(res(result, 'ex1').handle).toBeUndefined()
  })

  // ── Extrude a body face that has a hole, added back onto itself ────────────

  // Reproduces bugreports/extrude_2_does_not_work: a first extrude of a peanut
  // profile (two overlapping circles) with a hole leaves a body whose top face
  // carries an inner loop. Extruding that face with the default `add` operation
  // fuses the new prism onto the same body across their shared coincident face.
  // The raw fuse is a valid solid, but the coplanar-merge clean step throws on
  // it; the feature must still succeed (fall back to the un-merged solid).
  const peanutWithHoleSketch = {
    id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
    entities: [
      { id: 'cL', kind: 'circle' }, { id: 'cR', kind: 'circle' },
      { id: 'ln', kind: 'line' }, { id: 'pTop', kind: 'point' }, { id: 'pBot', kind: 'point' },
      { id: 'cHole', kind: 'circle' },
    ],
    initial: {
      cL: [-6.614378452301025, 7.5, 10], cR: [6.614378452301025, 7.5, 10],
      ln: [0, 15, 0, 0], pTop: [0, 15], pBot: [0, 0],
      cHole: [-6.614378452301025, 7.5, 5.703681945800781],
    },
    constraints: [
      { id: 'eq', kind: 'equal_length', a: '$cR', b: '$cL' },
      { id: 'co1', kind: 'coincident', a: '$pTopxy', b: '$cL' },
      { id: 'co2', kind: 'coincident', a: '$pTopxy', b: '$cR' },
      { id: 'co3', kind: 'coincident', a: '$lnstart', b: '$pTopxy' },
      { id: 'co4', kind: 'coincident', a: '$pBotxy', b: '$cL' },
      { id: 'co5', kind: 'coincident', a: '$pBotxy', b: '$cR' },
      { id: 'co6', kind: 'coincident', a: '$lnend', b: '$pBotxy' },
      { id: 'vert', kind: 'vertical', target: '$ln' },
      { id: 'co7', kind: 'coincident', a: '@builtin_origin', b: '$pBotxy' },
      { id: 'len', kind: 'length', target: '$ln', value: 15 },
      { id: 'dia', kind: 'diameter', target: '$cR', value: 20 },
      { id: 'coHole', kind: 'coincident', a: '$cHolecenter', b: '$cLcenter' },
    ],
  }

  function sk1SurfaceQueries(): string[] {
    const r = run({ features: [peanutWithHoleSketch] })
    const state = r._build_state as { checkpoints: Record<string, { repo_snapshot: { elements: Record<string, unknown> } }> }
    const cp = Object.values(state.checkpoints)[0]
    const topo = cp?.repo_snapshot?.elements?.['_topo_sk1'] as { surfaces?: Array<{ query?: string }> } | undefined
    return (topo?.surfaces ?? []).map((s) => s.query ?? '')
  }

  function topFaceQuery(result: BuildResponse, bodyId: string): string {
    const mesh = body(result, bodyId).mesh as { face_data?: Array<{ normal: number[] }>; face_queries?: string[] } | undefined
    let q = ''
    mesh?.face_data?.forEach((fd, i) => { if (fd.normal[2] > 0.9) q = mesh.face_queries?.[i] ?? '' })
    return q
  }

  it('extrude of a body face with a hole, add operation, does not fail', () => {
    const surfs = sk1SurfaceQueries()
    // Extrude only the four ring surfaces (0..3), excluding the hole disk (4,5),
    // so the resulting body keeps a hole through it.
    const profile = surfs.slice(0, 4)
    const first = run({
      features: [
        peanutWithHoleSketch,
        { id: 'ex1', kind: 'extrude', sketch: profile, distance: 10, direction: 'normal' },
      ],
    })
    expect(res(first, 'ex1').status).toBe('ok')
    const topQuery = topFaceQuery(first, 'body_ex1')
    expect(topQuery).not.toBe('')

    const result = run({
      features: [
        peanutWithHoleSketch,
        { id: 'ex1', kind: 'extrude', sketch: profile, distance: 10, direction: 'normal' },
        { id: 'ex2', kind: 'extrude', sketch: topQuery, distance: 10, direction: 'normal' },  // default add
      ],
    })
    expect(res(result, 'ex2').status).toBe('ok')
    const mesh = body(result, 'body_ex1').mesh as { vertices: number[][]; face_data?: unknown[] } | undefined
    expect(mesh).toBeDefined()
    if (mesh) {
      const zs = mesh.vertices.map((v) => v[2])
      expect(Math.min(...zs)).toBeCloseTo(0, 5)
      expect(Math.max(...zs)).toBeCloseTo(20, 5)  // both extrudes fused into one 20-tall body
      // The hole survives: an inner cylindrical wall means faces beyond the bare
      // top/bottom/outer-wall set of a hole-less solid.
      expect((mesh.face_data ?? []).length).toBeGreaterThan(4)
    }
  })
})
