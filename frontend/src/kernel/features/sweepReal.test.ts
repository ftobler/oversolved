// @vitest-environment node
//
// Gated real-OCC feature-level sweep tests using the full build pipeline
// (OCC.js + Rust WASM sketch solver). Ports all sweep scenarios from
// test_sweep.py.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { DisposeScope } from '../occ/disposeScope'
import { HandleTable } from '../occ/handleTable'
import { solidToMesh } from '../occ/tessellation'
import { brepDiffNewFaceHashes, brepDiffNewEdgeHashes, brepDiffNewVertexHashes } from '../occ/brepDiffHash'
import { build, type BuildDeps, type BuildResponse } from '../builder'
import { initGlobalRepo } from '../query'
import { createFeatureSolver } from '../solverRegistry'
import { postRegister } from './postRegister'
import { setSketchSolver, resetSketchSolver } from './sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
const oc = await loadOcc()
const solveBytes = loadSolver()

function rectSketch(sketchId: string, w: number, h: number, plane = '@builtin_plane_front') {
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

function linePathSketch(sketchId: string, segments: number[], plane = '@builtin_plane_top') {
  // segments: flat array [x0,y0,x1,y1, x1,y1,x2,y2, ...]
  const entities: Array<{ id: string; kind: string }> = []
  const initial: Record<string, number[]> = {}
  const constraints: Array<Record<string, unknown>> = []
  let ci = 0
  for (let i = 0; i < segments.length - 3; i += 4) {
    const eid = 'e' + i
    entities.push({ id: eid, kind: 'line' })
    initial[eid] = [segments[i], segments[i + 1], segments[i + 2], segments[i + 3]]
    if (i > 0) {
      constraints.push({ id: 'cc' + (++ci), kind: 'coincident' as const,
        a: { entity: eid, point: 'start' }, b: { entity: 'e' + (i - 4), point: 'end' } })
    }
  }
  return { id: sketchId, kind: 'sketch' as const, label: 'Path', plane,
    entities, initial, constraints }
}

function arcPathSketch(sketchId: string, cx: number, cy: number, r: number, a0: number, a1: number, plane = '@builtin_plane_top') {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Path', plane,
    entities: [{ id: 'arc0', kind: 'arc' }],
    initial: { arc0: [cx, cy, r, a0, a1] },
    constraints: [],
  }
}

// A circle profile centred on the plane origin (so it sits ON the path start).
function circleSketch(sketchId: string, r: number, plane = '@builtin_plane_right') {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Profile', plane,
    entities: [{ id: 'c0', kind: 'circle' as const }],
    initial: { c0: [0, 0, r] },
    constraints: [],
  }
}

// The real corpus path (sketch 1): line -> tangent arc -> line on builtin_plane_top.
// `segs` chooses how many path entities to include (2 = line+arc, 3 = line+arc+line).
// The 3-segment spine is the case that used to fail; collectPathEdges' joint-snap is
// what makes it assemble. Geometry reproduces a real user's failing model.
const CORPUS_LN0 = [0, 0, -10, 0]                      // [x0,y0,x1,y1]
const CORPUS_ARC = [-10, -5, 5, 90, -211.456]          // [cx,cy,r,a0deg,a1deg]
const CORPUS_LN1 = [-14.265, -2.391, -19.484, -10.921]
function corpusPathSketch(sketchId: string, segs: 2 | 3, plane = '@builtin_plane_top') {
  const entities: Array<{ id: string; kind: string }> = [
    { id: 'ln0', kind: 'line' }, { id: 'arc0', kind: 'arc' },
  ]
  const initial: Record<string, number[]> = { ln0: CORPUS_LN0, arc0: CORPUS_ARC }
  const constraints: Array<Record<string, unknown>> = [
    { id: 'cc1', kind: 'coincident' as const,
      a: { entity: 'arc0', point: 'start' }, b: { entity: 'ln0', point: 'end' } },
  ]
  if (segs === 3) {
    entities.push({ id: 'ln1', kind: 'line' })
    initial.ln1 = CORPUS_LN1
    constraints.push({ id: 'cc2', kind: 'coincident' as const,
      a: { entity: 'ln1', point: 'start' }, b: { entity: 'arc0', point: 'end' } })
  }
  return { id: sketchId, kind: 'sketch' as const, label: 'Path', plane, entities, initial, constraints }
}

function sweepSpec(sweepId: string, profileId: string, pathId: string, opts: { operation?: string; mergeTarget?: string } = {}) {
  const spec: Record<string, unknown> = {
    id: sweepId, kind: 'sweep', label: 'Sweep',
    sweep: { sketch: ['$' + profileId], path: '$' + pathId, operation: opts.operation ?? 'new' },
  }
  if (opts.mergeTarget) spec.sweep = { ...spec.sweep as Record<string, unknown>, merge_target: opts.mergeTarget }
  return spec
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

describe.skipIf(!oc || !solveBytes)('sweep feature (real OCC + Rust solver)', () => {
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
                createdBy: body.created_by || '', bodyId: body.id,
                faceAncestry: body.face_ancestry ?? null, faceNames: body.face_names ?? null,
                profileQueries: body.profile_queries ?? [],
              })
              out[body.id] = { mesh, edges: [], edge_queries: [] }
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

  it('basic sweep produces a valid body with mesh', () => {
    /** A rectangle profile swept along a straight path produces a valid body. */
    const result = run({
      features: [
        rectSketch('prof', 2, 3, '@builtin_plane_front'),
        linePathSketch('pth', [0, 0, 0, 5]),
        sweepSpec('sw1', 'prof', 'pth'),
      ],
    })
    expect(res(result, 'sw1').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_sw1')
    const mesh = body(result, 'body_sw1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshValid(mesh)
  })

  it('straight sweep bbox is correct box dimensions', () => {
    /**
     * A 2x3 profile on the front plane swept 5 units along the Top-plane path (running along
     * world -z) produces a box spanning x[0,2] y[0,3] z[-5,0].
     */
    const result = run({
      features: [
        rectSketch('prof', 2, 3, '@builtin_plane_front'),
        linePathSketch('pth', [0, 0, 0, 5]),
        sweepSpec('sw1', 'prof', 'pth'),
      ],
    })
    expect(res(result, 'sw1').status).toBe('ok')
    const mesh = body(result, 'body_sw1').mesh as { vertices: number[][] } | undefined
    expect(mesh).toBeDefined()
    if (mesh) {
      const xs = mesh.vertices.map((v) => v[0])
      const ys = mesh.vertices.map((v) => v[1])
      const zs = mesh.vertices.map((v) => v[2])
      expect(Math.min(...xs)).toBeCloseTo(0, 0)
      expect(Math.max(...xs)).toBeCloseTo(2, 0)
      expect(Math.min(...ys)).toBeCloseTo(0, 0)
      expect(Math.max(...ys)).toBeCloseTo(3, 0)
      expect(Math.min(...zs)).toBeCloseTo(-5, 0)
      expect(Math.max(...zs)).toBeCloseTo(0, 0)
    }
  })

  it('polyline path sweeps without error', () => {
    /** An L-shaped two-segment path sweeps without error. */
    const result = run({
      features: [
        rectSketch('prof', 1, 1, '@builtin_plane_front'),
        linePathSketch('pth', [0, 0, 0, 4, 0, 4, 3, 4]),
        sweepSpec('sw1', 'prof', 'pth'),
      ],
    })
    expect(res(result, 'sw1').status).toBe('ok')
    const mesh = body(result, 'body_sw1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshValid(mesh)
  })

  it('arc path sweeps without error', () => {
    /**
     * A quarter-circle arc path (<=180 deg) sweeps without error. Profile on Right plane so its
     * normal lines up with the arc's starting tangent.
     */
    const result = run({
      features: [
        rectSketch('prof', 1, 1, '@builtin_plane_right'),
        arcPathSketch('pth', 0, 5, 5, -90, 0),
        sweepSpec('sw1', 'prof', 'pth'),
      ],
    })
    expect(res(result, 'sw1').status).toBe('ok')
    const mesh = body(result, 'body_sw1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshValid(mesh)
  })

  function bbox(mesh: { vertices: number[][] }): { min: number[]; max: number[] } {
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for (const v of mesh.vertices) for (let i = 0; i < 3; i++) {
      if (v[i] < min[i]) min[i] = v[i]
      if (v[i] > max[i]) max[i] = v[i]
    }
    return { min, max }
  }

  it('corpus path: 2 segments (line+arc) sweeps to a valid body', () => {
    const result = run({
      features: [
        circleSketch('prof', 1.7, '@builtin_plane_right'),
        corpusPathSketch('pth', 2),
        sweepSpec('sw1', 'prof', 'pth'),
      ],
    })
    const r = res(result, 'sw1')
    const mesh = body(result, 'body_sw1').mesh as { vertices: number[][] } | undefined
    expect(r.status).toBe('ok')
    expect(mesh).toBeDefined()
    if (mesh) assertMeshValid(mesh)
  })

  it('corpus path: 3 segments (line+arc+line) sweeps to the correct shape', () => {
    const result = run({
      features: [
        circleSketch('prof', 1.7, '@builtin_plane_right'),
        corpusPathSketch('pth', 3),
        sweepSpec('sw1', 'prof', 'pth'),
      ],
    })
    const r = res(result, 'sw1')
    const mesh = body(result, 'body_sw1').mesh as { vertices: number[][] } | undefined
    expect(r.status).toBe('ok')
    expect(mesh).toBeDefined()
    if (mesh) {
      assertMeshValid(mesh)
      const bb = bbox(mesh)
      // The third line ends at world x=-19.48, z=10.92. A correct sweep must
      // reach there; a broken/backward third segment or a collapsed wire would
      // not extend the body past the arc end (~x=-14, z=2.4).
      expect(bb.min[0]).toBeLessThan(-18)   // reaches x ~ -19.5
      expect(bb.max[2]).toBeGreaterThan(9)  // reaches z ~ +10.9
    }
  })

  it('cut sweep removes volume from existing body', () => {
    /** A cut sweep subtracts material from an existing body. */
    const result = run({
      features: [
        rectSketch('base', 6, 6, '@builtin_plane_front'),
        { id: 'ext0', kind: 'extrude', label: 'Base',
          extrude: { sketch: ['$base'], distance: -6, operation: 'new' } },
        rectSketch('prof', 2, 2, '@builtin_plane_front'),
        linePathSketch('pth', [0, 0, 0, 6]),
        sweepSpec('sw1', 'prof', 'pth', { operation: 'cut' }),
      ],
    })
    expect(res(result, 'sw1').status).toBe('ok')
    expect(res(result, 'sw1').operation).toBe('cut')
  })
})
