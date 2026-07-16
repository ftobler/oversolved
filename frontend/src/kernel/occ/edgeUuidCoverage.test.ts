// @vitest-environment node
//
// Edge/face construction-UUID coverage + the "no duplicate query" regression
// lock (query-naming-by-construction.md, Stage 6.5).
//
// Stage 6 (f8074ea) dropped the per-edge/-face geom token on the premise that
// every pickable element carries a construction UUID. It does not for every
// class: single-face seam edges (a cylinder's lateral seam) got no UUID and fell
// back to createdBy+classifiers -- non-unique, so they collided in both the id
// buffer and the fillet/chamfer resolver. This file locks two things:
//   1. every edge of a named-face solid gets a UUID (incl. the seam edge), and
//   2. the full build pipeline emits NO duplicate edge_queries or face_queries
//      for the representative bodies (box, cylinder, filleted box, boolean cut).
// (2) is the guard that would have caught the original break at commit time.
//
// Skips when opencascade.js (or, for the build-level lock, the Rust solver) is
// absent, like the other real-OCC gates.
import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from './loadOcc'
import { DisposeScope } from './disposeScope'
import { makeBox, makeCylinder } from './primitives'
import { deriveEdgeNames } from './constructionLineage'
import { faceGh, edgeGh } from './lineageHash'
import type { OccShape } from './occTypes'
import { SharedHarness } from './sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import type { BuildResponse } from '../builder'

const oc = await loadOcc()
const solveBytes = loadSolver()

function nameAllFaces(scope: DisposeScope, shape: OccShape) {
  const E = oc!.TopAbs_ShapeEnum
  const faceNames: Record<string, string> = {}
  const faceAncestry: Record<string, string[]> = {}
  const exp = scope.track(new oc!.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  let i = 0
  for (; exp.More(); exp.Next()) {
    const face = scope.track(oc!.TopoDS.Face_1(exp.Current()))
    const gh = faceGh(oc!, scope, face)
    if (!(gh in faceNames)) { faceNames[gh] = `u_face${i++}`; faceAncestry[faceNames[gh]] = [`@anc${i}`] }
  }
  return { faceNames, faceAncestry }
}

function edgeGhs(scope: DisposeScope, shape: OccShape): string[] {
  const E = oc!.TopAbs_ShapeEnum
  const ghs = new Set<string>()
  const exp = scope.track(new oc!.TopExp_Explorer_2(shape, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) {
    const gh = edgeGh(oc!, scope, scope.track(oc!.TopoDS.Edge_1(exp.Current())))
    if (gh) ghs.add(gh)
  }
  return [...ghs]
}

describe.skipIf(!oc)('edge UUID coverage', () => {
  it('box: every edge gets a UUID', () => {
    const scope = new DisposeScope()
    try {
      const box = makeBox(oc!, scope, 10, 10, 10)
      const { faceNames, faceAncestry } = nameAllFaces(scope, box)
      const { edgeNames } = deriveEdgeNames(oc!, scope, box, faceNames, faceAncestry)
      for (const g of edgeGhs(scope, box)) expect(edgeNames[g]).toBeDefined()
    } finally { scope.dispose() }
  })

  it('cylinder: the single-face seam edge gets a UUID too', () => {
    const scope = new DisposeScope()
    try {
      const cyl = makeCylinder(oc!, scope, [0, 0, 0], [0, 0, 1], 5, 10)
      const { faceNames, faceAncestry } = nameAllFaces(scope, cyl)
      const { edgeNames, edgeAncestry } = deriveEdgeNames(oc!, scope, cyl, faceNames, faceAncestry)
      const ghs = edgeGhs(scope, cyl)
      expect(ghs.length).toBeGreaterThan(0)
      for (const g of ghs) {
        expect(edgeNames[g]).toBeDefined()
        // ancestry present so a stale UUID still resolves via the ancestral tier
        expect(edgeAncestry[edgeNames[g]]).toBeDefined()
      }
      // seam edge uses the seam derivation (e_ prefix, single-face path)
      expect(Object.values(edgeNames).every(u => u.startsWith('e_'))).toBe(true)
    } finally { scope.dispose() }
  })

  it('deterministic: two builds of the same cylinder mint identical edge UUIDs', () => {
    const s1 = new DisposeScope(); const s2 = new DisposeScope()
    try {
      const c1 = makeCylinder(oc!, s1, [0, 0, 0], [0, 0, 1], 5, 10)
      const c2 = makeCylinder(oc!, s2, [0, 0, 0], [0, 0, 1], 5, 10)
      const n1 = nameAllFaces(s1, c1)
      const n2 = nameAllFaces(s2, c2)
      const e1 = deriveEdgeNames(oc!, s1, c1, n1.faceNames, n1.faceAncestry).edgeNames
      const e2 = deriveEdgeNames(oc!, s2, c2, n2.faceNames, n2.faceAncestry).edgeNames
      expect(new Set(Object.values(e1))).toEqual(new Set(Object.values(e2)))
    } finally { s1.dispose(); s2.dispose() }
  })
})

// ─── build-level no-duplicate-query regression lock ───

/** A rectangle sketch (four constrained lines) at an optional in-plane offset. */
function rectSketch(sketchId: string, w: number, h: number, opts?: { offsetX?: number; offsetY?: number }) {
  const ox = opts?.offsetX ?? 0
  const oy = opts?.offsetY ?? 0
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: {
      bottom: [ox, oy, ox + w, oy], right: [ox + w, oy, ox + w, oy + h],
      top: [ox + w, oy + h, ox, oy + h], left: [ox, oy + h, ox, oy],
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

/** A single-circle sketch centered at the origin with a diameter constraint. */
function circleSketch(sketchId: string, diameter: number) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Circle', plane: '@builtin_plane_front',
    entities: [{ id: 'c1', kind: 'circle' as const }],
    initial: { c1: [0, 0, diameter / 2] },
    constraints: [
      { id: 'co1', kind: 'coincident' as const, a: `$${sketchId}c1center`, b: '@builtin_origin' },
      { id: 'd1', kind: 'diameter' as const, target: `$${sketchId}c1`, value: diameter },
    ],
  }
}

/** Duplicate entries in a query list (the exact non-uniqueness the lock guards). */
function duplicates(queries: string[]): string[] {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const q of queries) {
    if (seen.has(q)) dup.add(q)
    seen.add(q)
  }
  return [...dup]
}

function faceQueriesOf(h: SharedHarness, r: BuildResponse, bodyId: string): string[] {
  const mesh = h.body(r, bodyId).mesh as { face_queries?: string[] } | undefined
  return mesh?.face_queries ?? []
}

function edgeQueriesOf(h: SharedHarness, r: BuildResponse, bodyId: string): string[] {
  return (h.body(r, bodyId).edge_queries as string[]) ?? []
}

describe.skipIf(!oc || !solveBytes)('no-duplicate-query regression lock (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) }
  })

  /** Build the spec, then assert the body's face and edge queries are unique. */
  function expectUniqueQueries(spec: { features: Array<Record<string, unknown>> }, bodyId: string) {
    const r = h.run(spec)
    const faces = faceQueriesOf(h, r, bodyId)
    const edges = edgeQueriesOf(h, r, bodyId)
    expect(faces.length).toBeGreaterThan(0)
    expect(edges.length).toBeGreaterThan(0)
    expect(duplicates(faces)).toEqual([])
    expect(duplicates(edges)).toEqual([])
  }

  it('box: no duplicate face or edge queries', () => {
    expectUniqueQueries({ features: [
      rectSketch('sk1', 10, 10),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 5, direction: 'normal', operation: 'new' },
    ] }, 'body_ex1')
  })

  it('cylinder: the seam edge no longer collides (no duplicate queries)', () => {
    expectUniqueQueries({ features: [
      circleSketch('sk1', 10),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 8, direction: 'normal', operation: 'new' },
    ] }, 'body_ex1')
  })

  it('filleted box: no duplicate face or edge queries', () => {
    const base = { features: [
      rectSketch('sk1', 10, 10),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 5, direction: 'normal', operation: 'new' },
    ] }
    const eq = edgeQueriesOf(h, h.run(base), 'body_ex1')
    expect(eq.length).toBeGreaterThan(0)
    expectUniqueQueries({ features: [
      ...base.features,
      { id: 'fillet1', kind: 'fillet', edges: [eq[0]], radius: 1 },
    ] }, 'body_ex1')
  })

  it('boolean cut (target minus tool): no duplicate face or edge queries', () => {
    expectUniqueQueries({ features: [
      rectSketch('sk1', 10, 10),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'normal', operation: 'add' },
      rectSketch('sk2', 4, 4, { offsetX: 3, offsetY: 3 }),
      { id: 'ex2', kind: 'extrude', sketch: '$sk2', distance: 12, direction: 'normal', operation: 'cut' },
    ] }, 'body_ex1')
  })
})
