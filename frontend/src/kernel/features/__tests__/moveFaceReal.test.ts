// @vitest-environment node
//
// Build-level move-face tests through the production builder (SharedHarness):
// the leaf's face resolution by construction UUID, the naming transfer, the
// in-place body update, partial/stale handling, list-order application and a
// downstream feature surviving an edit. Volumes are pinned by the phase-0
// occ/__tests__/moveFaceReal.test.ts; here the document path is the subject.
//
// Skips when OCC.js or the Rust solver is absent.
import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { parseAncestry, makeAncestryQuery, constructionUuidToken } from '../../query'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import type { BuildState } from '../../types3d'

const oc = await loadOcc()
const solveBytes = loadSolver()

interface FaceInfo {
  face_queries?: string[]
  face_edge_queries?: string[][]
  // Per-face normal + centroid, aligned with face_queries (tessellation payload).
  face_data?: { normal: number[]; centroid: number[] }[]
}
interface BodyView { mesh?: FaceInfo & { vertices?: number[][] }; edge_queries?: string[]; modified_by?: string[] }

/** The Construction UUID token of a query, or undefined. */
const uuidOf = (q: string): string | undefined => parseAncestry(q)[0].find((i) => i.startsWith('@u|'))

function rectSketch(sketchId: string, w: number, h: number) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane: '@builtin_plane_front',
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

/** A 10x10xd box: rect sketch + extrude along the front-normal. */
function boxSpec(d = 5): { features: Array<Record<string, unknown>> } {
  return { features: [
    rectSketch('sk1', 10, 10),
    { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: d, direction: 'normal', operation: 'new' },
  ]}
}

/** The face whose classifier is `cls` (the box top is `cls_zp`, a side `cls_xp`). */
function faceQueryAt(bodies: Record<string, unknown>, cls: string): string {
  const body = Object.values(bodies)[0] as BodyView
  const queries = body?.mesh?.face_queries ?? []
  const hit = queries.find((q) => q.includes(cls))
  if (hit === undefined) throw new Error(`no ${cls} face among: ${queries.join(' | ')}`)
  return hit
}

function bbox(body: BodyView): { min: number[]; max: number[] } {
  const verts = body.mesh?.vertices ?? []
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const v of verts) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], v[i]); max[i] = Math.max(max[i], v[i]) }
  return { min, max }
}

/** A U profile 30x10 with a 10x6 notch in the top: extruding it along the front
 *  normal gives two pillars joined by a 4-thick web. Moving the web floor down
 *  to the base cuts the web through and severs the pillars. */
function uProfileSketch(sketchId: string) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'U profile', plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'topRight', kind: 'line' as const }, { id: 'innerRight', kind: 'line' as const },
      { id: 'web', kind: 'line' as const }, { id: 'innerLeft', kind: 'line' as const },
      { id: 'topLeft', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: {
      bottom: [0, 0, 30, 0], right: [30, 0, 30, 10],
      topRight: [30, 10, 20, 10], innerRight: [20, 10, 20, 4],
      web: [20, 4, 10, 4], innerLeft: [10, 4, 10, 10],
      topLeft: [10, 10, 0, 10], left: [0, 10, 0, 0],
    },
    constraints: [
      { id: 'co1', kind: 'coincident' as const, a: { entity: 'bottom', point: 'end' as const }, b: { entity: 'right', point: 'start' as const } },
      { id: 'co2', kind: 'coincident' as const, a: { entity: 'right', point: 'end' as const }, b: { entity: 'topRight', point: 'start' as const } },
      { id: 'co3', kind: 'coincident' as const, a: { entity: 'topRight', point: 'end' as const }, b: { entity: 'innerRight', point: 'start' as const } },
      { id: 'co4', kind: 'coincident' as const, a: { entity: 'innerRight', point: 'end' as const }, b: { entity: 'web', point: 'start' as const } },
      { id: 'co5', kind: 'coincident' as const, a: { entity: 'web', point: 'end' as const }, b: { entity: 'innerLeft', point: 'start' as const } },
      { id: 'co6', kind: 'coincident' as const, a: { entity: 'innerLeft', point: 'end' as const }, b: { entity: 'topLeft', point: 'start' as const } },
      { id: 'co7', kind: 'coincident' as const, a: { entity: 'topLeft', point: 'end' as const }, b: { entity: 'left', point: 'start' as const } },
      { id: 'co8', kind: 'coincident' as const, a: { entity: 'left', point: 'end' as const }, b: { entity: 'bottom', point: 'start' as const } },
      { id: 'h1', kind: 'horizontal' as const, target: { entity: 'bottom' } },
      { id: 'h2', kind: 'horizontal' as const, target: { entity: 'topRight' } },
      { id: 'h3', kind: 'horizontal' as const, target: { entity: 'web' } },
      { id: 'h4', kind: 'horizontal' as const, target: { entity: 'topLeft' } },
      { id: 'v1', kind: 'vertical' as const, target: { entity: 'right' } },
      { id: 'v2', kind: 'vertical' as const, target: { entity: 'innerRight' } },
      { id: 'v3', kind: 'vertical' as const, target: { entity: 'innerLeft' } },
      { id: 'v4', kind: 'vertical' as const, target: { entity: 'left' } },
      { id: 'l1', kind: 'length' as const, target: { entity: 'bottom' }, value: 30 },
      { id: 'l2', kind: 'length' as const, target: { entity: 'right' }, value: 10 },
      { id: 'l3', kind: 'length' as const, target: { entity: 'topRight' }, value: 10 },
      { id: 'l4', kind: 'length' as const, target: { entity: 'innerRight' }, value: 6 },
      { id: 'l5', kind: 'length' as const, target: { entity: 'web' }, value: 10 },
      { id: 'l6', kind: 'length' as const, target: { entity: 'innerLeft' }, value: 6 },
      { id: 'l7', kind: 'length' as const, target: { entity: 'topLeft' }, value: 10 },
      { id: 'l8', kind: 'length' as const, target: { entity: 'left' }, value: 10 },
    ],
  }
}

/** The one face query whose tessellated normal + centroid satisfy `match`. */
function faceQueryWhere(bodies: Record<string, unknown>, match: (normal: number[], centroid: number[]) => boolean): string {
  const body = Object.values(bodies)[0] as BodyView
  const queries = body?.mesh?.face_queries ?? []
  const data = body?.mesh?.face_data ?? []
  for (let i = 0; i < queries.length; i++) {
    const d = data[i]
    if (d && match(d.normal, d.centroid)) return queries[i]
  }
  throw new Error(`no face matched among ${queries.length} faces`)
}

/** A trapezoid profile [0,r1] at the base up to [0,r2] at height h: revolved
 *  around its axis-side edge it makes a cone frustum (apex above r2). */
function trapezoidSketch(sketchId: string, r1: number, r2: number, h: number) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Trapezoid', plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'slant', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'axis', kind: 'line' as const },
    ],
    initial: {
      bottom: [0, 0, r1, 0], slant: [r1, 0, r2, h],
      top: [r2, h, 0, h], axis: [0, h, 0, 0],
    },
    constraints: [
      { id: 'c1', kind: 'coincident' as const, a: { entity: 'bottom', point: 'end' as const }, b: { entity: 'slant', point: 'start' as const } },
      { id: 'c2', kind: 'coincident' as const, a: { entity: 'slant', point: 'end' as const }, b: { entity: 'top', point: 'start' as const } },
      { id: 'c3', kind: 'coincident' as const, a: { entity: 'top', point: 'end' as const }, b: { entity: 'axis', point: 'start' as const } },
      { id: 'c4', kind: 'coincident' as const, a: { entity: 'axis', point: 'end' as const }, b: { entity: 'bottom', point: 'start' as const } },
      { id: 'c5', kind: 'horizontal' as const, target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal' as const, target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical' as const, target: { entity: 'axis' } },
      { id: 'c8', kind: 'length' as const, target: { entity: 'bottom' }, value: r1 },
      { id: 'c9', kind: 'length' as const, target: { entity: 'top' }, value: r2 },
      { id: 'c10', kind: 'length' as const, target: { entity: 'axis' }, value: h },
    ],
  }
}

describe.skipIf(!oc || !solveBytes)('move-face build-level (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  it('moves the box top +5 and -3 through a full build', () => {
    const base = h.run(boxSpec())
    const top = faceQueryAt(base.bodies, 'cls_zp')
    {
      const r = h.run({ features: [...boxSpec().features, { id: 'mf1', kind: 'move_face', move_face: { faces: [top], distance: 5 } }] })
      expect(h.res(r, 'mf1').status).toBe('ok')
      expect(bbox(h.body(r, 'body_ex1')).max[2]).toBeCloseTo(10, 6)
    }
    {
      const r = h.run({ features: [...boxSpec().features, { id: 'mf1', kind: 'move_face', move_face: { faces: [top], distance: -3 } }] })
      expect(h.res(r, 'mf1').status).toBe('ok')
      expect(bbox(h.body(r, 'body_ex1')).max[2]).toBeCloseTo(2, 6)
    }
  })

  it('exactly one live face claims the moved face UUID, and it resolves by query', () => {
    const base = h.run(boxSpec())
    const top = faceQueryAt(base.bodies, 'cls_zp')
    const uuid = uuidOf(top)
    expect(uuid).toBeDefined()
    const r = h.run({ features: [...boxSpec().features, { id: 'mf1', kind: 'move_face', move_face: { faces: [top], distance: 5 } }] })
    expect(h.res(r, 'mf1').status).toBe('ok')
    const queries = (h.body(r, 'body_ex1') as BodyView).mesh?.face_queries ?? []
    expect(queries.filter((q) => uuidOf(q) === uuid)).toHaveLength(1)
    // A second move on the same (now moved) face resolves through the same UUID.
    const r2 = h.run({ features: [
      ...boxSpec().features,
      { id: 'mf1', kind: 'move_face', move_face: { faces: [top], distance: 5 } },
      { id: 'mf2', kind: 'move_face', move_face: { faces: [top], distance: 2 } },
    ] })
    expect(h.res(r2, 'mf2').status).toBe('ok')
    expect(bbox(h.body(r2, 'body_ex1')).max[2]).toBeCloseTo(12, 6)
  })

  it('distance 0 is the identity: ok, shape unchanged, no modified_by', () => {
    const base = h.run(boxSpec())
    const top = faceQueryAt(base.bodies, 'cls_zp')
    const before = bbox(h.body(base, 'body_ex1'))
    const r = h.run({ features: [...boxSpec().features, { id: 'mf1', kind: 'move_face', move_face: { faces: [top], distance: 0 } }] })
    expect(h.res(r, 'mf1').status).toBe('ok')
    expect(bbox(h.body(r, 'body_ex1')).max[2]).toBeCloseTo(before.max[2], 9)
    expect((h.body(r, 'body_ex1') as BodyView).modified_by ?? []).toEqual([])
  })

  it('top and one side +5 give the same face UUID set in both list orders', () => {
    const base = h.run(boxSpec())
    const top = faceQueryAt(base.bodies, 'cls_zp')
    const side = faceQueryAt(base.bodies, 'cls_xp')
    const run = (faces: string[]): Set<string> => {
      const r = h.run({ features: [...boxSpec().features, { id: 'mf1', kind: 'move_face', move_face: { faces, distance: 5 } }] })
      expect(h.res(r, 'mf1').status).toBe('ok')
      expect(bbox(h.body(r, 'body_ex1')).max[2]).toBeCloseTo(10, 6)
      expect(bbox(h.body(r, 'body_ex1')).max[0]).toBeCloseTo(15, 6)
      const queries = (h.body(r, 'body_ex1') as BodyView).mesh?.face_queries ?? []
      return new Set(queries.map(uuidOf).filter((u): u is string => u !== undefined))
    }
    const a = run([top, side])
    const b = run([side, top])
    expect([...a].sort()).toEqual([...b].sort())
  })

  it('a stale pick is partial with unresolved_faces; all stale is an exception', () => {
    const base = h.run(boxSpec())
    const top = faceQueryAt(base.bodies, 'cls_zp')
    // A uuid-only query: no ancestry to recover from, so it can never resolve.
    const stale = makeAncestryQuery([constructionUuidToken('dead0000000000000000')], 'flatface')
    {
      const r = h.run({ features: [...boxSpec().features, { id: 'mf1', kind: 'move_face', move_face: { faces: [top, stale], distance: 5 } }] })
      expect(h.res(r, 'mf1').status).toBe('partial')
      expect(h.res(r, 'mf1').unresolved_faces).toEqual([stale])
      expect(bbox(h.body(r, 'body_ex1')).max[2]).toBeCloseTo(10, 6)
    }
    {
      const r = h.run({ features: [...boxSpec().features, { id: 'mf1', kind: 'move_face', move_face: { faces: [stale], distance: 5 } }] })
      expect(h.res(r, 'mf1').status).toBe('exception')
    }
  })

  it('a later pick consumed by an earlier move is failed, not unresolved', () => {
    const base = h.run(boxSpec())
    const top = faceQueryAt(base.bodies, 'cls_zp')
    const beforeUuids = new Set(((h.body(base, 'body_ex1') as BodyView).mesh?.face_queries ?? []).map(uuidOf))
    const topEdges = ((h.body(base, 'body_ex1') as BodyView).edge_queries ?? []).filter((q) => q.includes('cls_zp'))
    expect(topEdges.length).toBeGreaterThanOrEqual(4)
    const chamferSpec = {
      features: [...boxSpec().features, { id: 'ch1', kind: 'chamfer', edges: topEdges.slice(0, 4), distance: 1 }],
    }
    const rc = h.run(chamferSpec)
    expect(h.res(rc, 'ch1').status).toBe('ok')
    // A chamfer face is one the chamfer introduced: its UUID is not in the box.
    const chamferFace = ((h.body(rc, 'body_ex1') as BodyView).mesh?.face_queries ?? []).find((q) => {
      const u = uuidOf(q)
      return u !== undefined && !beforeUuids.has(u)
    })
    expect(chamferFace).toBeDefined()
    // Move the top inward past the chamfer layer: the chamfers vanish, so the
    // later pick is consumed -- failed (geometry is the fix), not unresolved.
    const spec = {
      features: [...chamferSpec.features, { id: 'mf1', kind: 'move_face', move_face: { faces: [top, chamferFace], distance: -3 } }],
    }
    const r = h.run(spec)
    expect(h.res(r, 'mf1').status).toBe('partial')
    expect(h.res(r, 'mf1').failed_faces).toEqual([chamferFace])
    expect(((h.res(r, 'mf1').unresolved_faces as string[] | undefined) ?? [])).toEqual([])
  })

  it('a downstream fillet on the moved cap survives a distance edit', () => {
    const base = h.run(boxSpec())
    const top = faceQueryAt(base.bodies, 'cls_zp')
    const withMove = (d: number): { features: Array<Record<string, unknown>> } => ({
      features: [...boxSpec().features, { id: 'mf1', kind: 'move_face', move_face: { faces: [top], distance: d } }],
    })
    const r1 = h.run(withMove(5))
    expect(h.res(r1, 'mf1').status).toBe('ok')
    // A cap edge: an edge whose representative point sits on the moved z=10
    // plane, i.e. carries the +z classifier.
    const edges = (h.body(r1, 'body_ex1') as BodyView).edge_queries ?? []
    const edge = edges.find((q) => q.includes('cls_zp'))
    expect(edge).toBeDefined()

    const spec = withMove(5)
    spec.features.push({ id: 'fil1', kind: 'fillet', edges: [edge], radius: 0.5 })
    const r2 = h.run(spec)
    expect(h.res(r2, 'fil1').status).toBe('ok')

    // Edit the move distance 5 -> 8 and rebuild incrementally from the move.
    const spec8 = withMove(8)
    spec8.features.push({ id: 'fil1', kind: 'fillet', edges: [edge], radius: 0.5 })
    const r3 = h.run(spec8, { prevState: r2._build_state as BuildState })
    expect(h.res(r3, 'fil1').status).toBe('ok')
    expect(bbox(h.body(r3, 'body_ex1')).max[2]).toBeCloseTo(13, 6)
  })

  it('an inward move that removes the whole body is an exception', () => {
    const base = h.run(boxSpec())
    const top = faceQueryAt(base.bodies, 'cls_zp')
    const r = h.run({ features: [...boxSpec().features, { id: 'mf1', kind: 'move_face', move_face: { faces: [top], distance: -20 } }] })
    expect(h.res(r, 'mf1').status).toBe('exception')
    expect(String(h.res(r, 'mf1').exception ?? '')).toContain('whole body')
  })

  it('full and incremental builds agree on the moved body face UUIDs', () => {
    const base = h.run(boxSpec())
    const top = faceQueryAt(base.bodies, 'cls_zp')
    const spec = { features: [...boxSpec().features, { id: 'mf1', kind: 'move_face', move_face: { faces: [top], distance: 5 } }] }
    const full = h.run(spec)
    // Rebuild incrementally on the un-moved base: the move is the only feature
    // to re-solve, so the front face UUID set must match the full build.
    const inc = h.run(spec, { prevState: base._build_state as BuildState })
    const uuids = (r: ReturnType<typeof h.run>): string[] =>
      ((h.body(r, 'body_ex1') as BodyView).mesh?.face_queries ?? []).map(uuidOf).filter((u): u is string => u !== undefined).sort()
    expect(uuids(inc)).toEqual(uuids(full))
  })

  it('an inward move that severs the body yields two bodies via resplitBody', () => {
    // The U profile's web floor (y=4) moved down to y=0 removes the web between
    // the pillars; they were joined only there, so the body must resplit into
    // two pillars seated under distinct sibling ids.
    const spec = {
      features: [
        uProfileSketch('sk1'),
        { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'normal', operation: 'new' },
      ],
    }
    const base = h.run(spec)
    expect(h.res(base, 'ex1').status).toBe('ok')
    const web = faceQueryWhere(base.bodies, (n, c) => Math.abs(n[1] - 1) < 1e-6 && Math.abs(c[1] - 4) < 1e-6)
    const r = h.run({ features: [...spec.features, { id: 'mf1', kind: 'move_face', move_face: { faces: [web], distance: -4 } }] })
    expect(h.res(r, 'mf1').status).toBe('ok')
    const ids = (h.res(r, 'mf1').body_ids as string[]) ?? []
    expect(ids).toHaveLength(2)
    // Ordered by centroid in the parent frame: the left pillar keeps the base id.
    expect(bbox(h.body(r, ids[0])).max[0]).toBeCloseTo(10, 6)
    expect(bbox(h.body(r, ids[1])).min[0]).toBeCloseTo(20, 6)
  })

  it('a top moved past the apex drops the top edge, so a downstream chamfer goes red', () => {
    // A frustum (r10 at y=0 to r5 at y=10) revolved about +Y; its apex is at
    // y=20. Moving the top +15 past the apex leaves a full cone whose top face
    // and top circle edge are gone. A downstream chamfer naming those two edges
    // must report the missing one unresolved and chamfer only the survivor,
    // never re-bind the vanished edge to another.
    const axis = {
      id: 'skax', kind: 'sketch' as const, label: 'Axis', plane: '@builtin_plane_front',
      entities: [{ id: 'ax', kind: 'line' as const }],
      initial: { ax: [0, 0, 0, 1] },
      constraints: [],
    }
    const baseFeatures = [
      axis,
      trapezoidSketch('skf', 10, 5, 10),
      { id: 'rev1', kind: 'revolve', sketch: '$skf', angle: 360, axis: '@skax/ax' },
    ]
    const base = h.run({ features: baseFeatures })
    expect(h.res(base, 'rev1').status).toBe('ok')
    const top = faceQueryWhere(base.bodies, (n, c) => Math.abs(n[1] - 1) < 1e-6 && Math.abs(c[1] - 10) < 1e-6)
    const edges = ((h.body(base, 'body_rev1') as BodyView).edge_queries ?? [])
    const topEdge = edges.find((q) => q.includes('cls_yp'))
    const botEdge = edges.find((q) => q.includes('cls_yn'))
    expect(topEdge).toBeDefined()
    expect(botEdge).toBeDefined()

    const spec = { features: [
      ...baseFeatures,
      { id: 'mf1', kind: 'move_face', move_face: { faces: [top], distance: 15 } },
      { id: 'ch1', kind: 'chamfer', edges: [topEdge, botEdge], distance: 0.5 },
    ] }
    const r = h.run(spec)
    expect(h.res(r, 'mf1').status).toBe('ok')
    // Past the apex: the cone reaches y=20, its top face is gone.
    expect(bbox(h.body(r, 'body_rev1')).max[1]).toBeCloseTo(20, 3)
    expect(h.res(r, 'ch1').status).toBe('partial')
    expect(h.res(r, 'ch1').unresolved_edges).toEqual([topEdge])
    expect((h.res(r, 'ch1').failed_edges as string[] | undefined) ?? []).toEqual([])
  })
})
