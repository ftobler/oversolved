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
import { parseAncestry } from '../../query'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import type { BuildState } from '../../types3d'

const oc = await loadOcc()
const solveBytes = loadSolver()

interface FaceInfo { face_queries?: string[]; face_edge_queries?: string[][] }
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
    const side = faceQueryAt(base.bodies, 'cls_xp')
    const stale = side.replace(uuidOf(side) ?? '@u|x', '@u|dead0000000000000000')
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
})
