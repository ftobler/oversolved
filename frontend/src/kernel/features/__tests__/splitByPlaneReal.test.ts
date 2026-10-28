// @vitest-environment node
//
// The split leaf through the production builder (SharedHarness): real OCC plus
// the Rust sketch solver, so every case is also gated by `assertOneSolidPerBody`.
// The plan's T3 list, grouped: the three keep modes, the cap naming, the
// keep-both lineage (one transfer over both halves), pick persistence, the
// fail-loud refusals, the two-pass multi-body rule, and the degenerate shapes
// (coplanar step, tangent cylinder, imported body, suppressed/rolled back).
//
// Skips when OCC.js or the sketch solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { DisposeScope } from '../../occ/disposeScope'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { parseAncestry } from '../../query'
import { volumeOf } from '../../occ/volume'
import { canonicalFaces } from '../../occ/bodyNames'
import { makeBoxAt, shapeBndBox } from '../../occ/primitives'
import { stepShapeToBytes } from '../../occ/stepIo'
import { mintFaceUuid, splitFacePath, splitPlaneFacePath } from '../../constructionName'
import { resolveBodyIds } from '../shared/bodyResolution'
import type { OccModule, OccShape } from '../../occ/occTypes'
import type { BuildResponse } from '../../builder'
import type { Body } from '../../types3d'

const oc = await loadOcc()
const solveBytes = loadSolver()

type Dict = Record<string, unknown>
interface FaceDatum {
  centroid: number[]
  normal: number[]
  area?: number
  surface_type?: string
}
interface FaceMesh {
  face_data?: FaceDatum[]
  face_queries?: string[]
}
interface BodyView {
  mesh?: FaceMesh
  edges?: { kind: string; start?: number[]; end?: number[] }[]
  edge_queries?: string[]
}

/** A rectangle sketch on a plane, fully constrained. */
function rectSketch(
  id: string,
  w: number,
  h: number,
  { x0 = 0, y0 = 0, plane = '@builtin_plane_front' }: { x0?: number; y0?: number; plane?: string } = {},
): Dict {
  const pts: [number, number][] = [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]]
  return polySketch(id, pts, plane)
}

/** A closed polygon sketch: one line per edge, coincident corners, H/V sides. */
function polySketch(id: string, points: [number, number][], plane = '@builtin_plane_front'): Dict {
  const n = points.length
  const entities: Dict[] = []
  const initial: Record<string, number[]> = {}
  const constraints: Dict[] = []
  for (let i = 0; i < n; i++) {
    const a = points[i]
    const b = points[(i + 1) % n]
    entities.push({ id: `l${i}`, kind: 'line' })
    initial[`l${i}`] = [a[0], a[1], b[0], b[1]]
    constraints.push({
      id: `c${i}`,
      kind: 'coincident',
      a: { entity: `l${i}`, point: 'end' },
      b: { entity: `l${(i + 1) % n}`, point: 'start' },
    })
    constraints.push({ id: `h${i}`, kind: a[1] === b[1] ? 'horizontal' : 'vertical', target: { entity: `l${i}` } })
  }
  return { id, kind: 'sketch', plane, entities, initial, constraints }
}

function extrude(id: string, sketch: string, distance: number, operation = 'new'): Dict {
  return { id, kind: 'extrude', extrude: { sketch, distance, direction: 'normal', operation } }
}

function planeOffset(id: string, plane: string, offset: number): Dict {
  return { id, kind: 'plane', definition: { mode: 'offset', plane, offset } }
}

function split(id: string, bodies: string[], plane: string, keep?: string): Dict {
  return { id, kind: 'split', split: { bodies, plane, ...(keep === undefined ? {} : { keep }) } }
}

/** The construction-UUID token (`@u|<uuid>`) of a query, if any. */
const uuidTokenOf = (q: string): string | undefined =>
  parseAncestry(q)[0].find((i) => i.startsWith('@u|'))?.slice('@u|'.length)

const capUuid = (featureId: string, side: 'above' | 'below'): string =>
  mintFaceUuid(splitPlaneFacePath(featureId, side))

const splitChildUuid = (parent: string, index: number): string => mintFaceUuid(splitFacePath(parent, index))

describe.skipIf(!oc || !solveBytes)('solveSplit through the builder (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)
  const occ = oc as OccModule

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  const meshOf = (r: BuildResponse, bodyId: string): FaceMesh => (h.body(r, bodyId).mesh ?? {}) as FaceMesh
  const viewOf = (r: BuildResponse, bodyId: string): BodyView => h.body(r, bodyId) as BodyView

  function snapshot(r: BuildResponse, featureId: string): Record<string, Body> {
    const ckp = r._build_state!.checkpoints[featureId]
    return ckp.body_store_snapshot as Record<string, Body>
  }
  function shapeOf(r: BuildResponse, featureId: string, bodyId: string): OccShape {
    return h.table.get<OccShape>(snapshot(r, featureId)[bodyId].shape!)
  }
  function volumeAt(r: BuildResponse, featureId: string, bodyId: string): number {
    const scope = new DisposeScope()
    try { return volumeOf(occ, scope, shapeOf(r, featureId, bodyId)) } finally { scope.dispose() }
  }
  function bboxAt(r: BuildResponse, featureId: string, bodyId: string) {
    const scope = new DisposeScope()
    try { return shapeBndBox(occ, scope, shapeOf(r, featureId, bodyId)) } finally { scope.dispose() }
  }
  function faceCountAt(r: BuildResponse, featureId: string, bodyId: string): number {
    const scope = new DisposeScope()
    try { return canonicalFaces(occ, scope, shapeOf(r, featureId, bodyId)).length } finally { scope.dispose() }
  }
  // Every UUID in the store, asserting no live face claims one twice.
  function expectUniqueFaceUuids(r: BuildResponse, featureId: string): void {
    const seen = new Set<string>()
    for (const [id, body] of Object.entries(snapshot(r, featureId))) {
      for (const uuid of body.face_uuids ?? []) {
        if (uuid === null) continue
        expect(seen.has(uuid), `UUID ${uuid} claimed twice, second on ${id}`).toBe(false)
        seen.add(uuid)
      }
    }
  }

  // The index of the flat face whose centroid is nearest `at`.
  function flatFaceIndex(mesh: FaceMesh, at: [number, number, number], tol = 1e-6): number {
    let best = -1
    let bestDist = Infinity
    mesh.face_data?.forEach((fd, i) => {
      if (fd.surface_type !== 'flatface') return
      const d = Math.hypot(fd.centroid[0] - at[0], fd.centroid[1] - at[1], fd.centroid[2] - at[2])
      if (d < bestDist) { bestDist = d; best = i }
    })
    expect(bestDist, `a flat face near ${JSON.stringify(at)}`).toBeLessThan(tol)
    return best
  }
  function faceQueryAt(r: BuildResponse, bodyId: string, at: [number, number, number], tol = 1e-6): string {
    const mesh = meshOf(r, bodyId)
    return mesh.face_queries?.[flatFaceIndex(mesh, at, tol)] ?? ''
  }
  function uuidAt(r: BuildResponse, bodyId: string, at: [number, number, number]): string | undefined {
    return uuidTokenOf(faceQueryAt(r, bodyId, at))
  }
  // The UUIDs of every live face in `bodyId`.
  function liveFaceUuids(r: BuildResponse, bodyId: string): string[] {
    return (meshOf(r, bodyId).face_queries ?? []).map(uuidTokenOf).filter((u): u is string => u !== undefined)
  }

  // ─── fixtures ───

  const blockSpec = (splitFeature?: Dict): { features: Dict[] } => ({
    features: [
      rectSketch('sk1', 10, 10),
      extrude('ex1', '$sk1', 10),
      planeOffset('pl1', '@builtin_plane_top', 5),
      ...(splitFeature === undefined ? [] : [splitFeature]),
    ],
  })

  const holedSpec = (splitFeature?: Dict): { features: Dict[] } => ({
    features: [
      rectSketch('sk1', 10, 10),
      extrude('ex1', '$sk1', 10),
      {
        id: 'skh', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [{ id: 'p1', kind: 'point' }], initial: { p1: [5, 5] },
      },
      {
        id: 'h1', kind: 'hole',
        hole: { sketch: '$skh', diameter: 5, depth_mode: 'through_all', direction: 'normal', target: '@body_ex1' },
      },
      planeOffset('pl1', '@builtin_plane_top', 5),
      ...(splitFeature === undefined ? [] : [splitFeature]),
    ],
  })

  it('keeps the above half on the body id and leaves the below side gone', () => {
    const base = h.run(blockSpec())
    const r = h.run(blockSpec(split('sp1', ['@ex1'], '@pl1', 'above')))
    expect(h.res(r, 'sp1').status).toBe('ok')
    expect(h.res(r, 'sp1').body_ids).toEqual(['body_ex1'])
    expect(volumeAt(r, 'sp1', 'body_ex1')).toBeCloseTo(500, 6)
    expect(bboxAt(r, 'sp1', 'body_ex1').min[1]).toBeCloseTo(5, 6)
    expect(snapshot(r, 'sp1').body_ex1.modified_by).toEqual(['sp1'])
    expectUniqueFaceUuids(r, 'sp1')
    // The kept half carries the pre-split UUIDs of every face it still has.
    const before = new Set(liveFaceUuids(base, 'body_ex1'))
    const after = new Set(liveFaceUuids(r, 'body_ex1'))
    for (const uuid of after) {
      if (uuid === capUuid('sp1', 'above')) continue
      expect(before.has(uuid), `face ${uuid} was not a pre-split face`).toBe(true)
    }
  })

  it('keeps the below half', () => {
    const r = h.run(blockSpec(split('sp1', ['@ex1'], '@pl1', 'below')))
    expect(h.res(r, 'sp1').status).toBe('ok')
    expect(volumeAt(r, 'sp1', 'body_ex1')).toBeCloseTo(500, 6)
    expect(bboxAt(r, 'sp1', 'body_ex1').max[1]).toBeCloseTo(5, 6)
    expect(liveFaceUuids(r, 'body_ex1')).toContain(capUuid('sp1', 'below'))
    expectUniqueFaceUuids(r, 'sp1')
  })

  it('keeps both halves as body_ex1 (above) and body_ex1_1 (below)', () => {
    const r = h.run(blockSpec(split('sp1', ['@ex1'], '@pl1', 'both')))
    expect(h.res(r, 'sp1').status).toBe('ok')
    expect(h.res(r, 'sp1').body_ids).toEqual(['body_ex1', 'body_ex1_1'])
    const store = snapshot(r, 'sp1')
    expect(Object.keys(store).sort()).toEqual(['body_ex1', 'body_ex1_1'])
    expect(store.body_ex1.created_by).toBe('ex1')
    expect(store.body_ex1_1.created_by).toBe('ex1')
    expect(bboxAt(r, 'sp1', 'body_ex1').min[1]).toBeCloseTo(5, 6)
    expect(bboxAt(r, 'sp1', 'body_ex1_1').max[1]).toBeCloseTo(5, 6)
    const total = volumeAt(r, 'sp1', 'body_ex1') + volumeAt(r, 'sp1', 'body_ex1_1')
    expect(total).toBeCloseTo(1000, 6)
    // A feature ref still names both halves.
    expect(resolveBodyIds('@ex1', store).sort()).toEqual(['body_ex1', 'body_ex1_1'])
    expectUniqueFaceUuids(r, 'sp1')
  })

  it('keeps the holed block above, with the two cap strips named off one base face', () => {
    const r = h.run(holedSpec(split('sp1', ['@ex1'], '@pl1', 'above')))
    expect(h.res(r, 'sp1').status).toBe('ok')
    const expected = 500 - (Math.PI * 2.5 * 2.5 * 10) / 2
    expect(volumeAt(r, 'sp1', 'body_ex1')).toBeCloseTo(expected, 5)

    // The bore removes a band across the whole cap, so it is two strips.
    const mesh = meshOf(r, 'body_ex1')
    const capIndexes: number[] = []
    mesh.face_data?.forEach((fd, i) => {
      if (fd.surface_type !== 'flatface') return
      if (Math.abs(fd.centroid[1] - 5) > 1e-6) return
      capIndexes.push(i)
    })
    expect(capIndexes).toHaveLength(2)
    const capUuids = capIndexes.map((i) => uuidTokenOf(mesh.face_queries?.[i] ?? '')).sort()
    const parent = capUuid('sp1', 'above')
    expect(capUuids).toEqual([splitChildUuid(parent, 0), splitChildUuid(parent, 1)].sort())
    expectUniqueFaceUuids(r, 'sp1')
  })

  it('keep both: the outer faces keep their UUIDs, the crossing face splits per half', () => {
    const base = h.run(blockSpec())
    const topBefore = uuidAt(base, 'body_ex1', [5, 10, 5])
    const bottomBefore = uuidAt(base, 'body_ex1', [5, 0, 5])
    const sideBefore = uuidAt(base, 'body_ex1', [0, 5, 5])
    expect(topBefore && bottomBefore && sideBefore).toBeTruthy()

    const r = h.run(blockSpec(split('sp1', ['@ex1'], '@pl1', 'both')))
    expect(h.res(r, 'sp1').status).toBe('ok')
    // The top face is wholly above, the bottom wholly below.
    expect(liveFaceUuids(r, 'body_ex1')).toContain(topBefore)
    expect(liveFaceUuids(r, 'body_ex1_1')).toContain(bottomBefore)
    // The side face is crossed: one child per half, and never the parent twice.
    const sideChildren = [
      splitChildUuid(sideBefore as string, 0),
      splitChildUuid(sideBefore as string, 1),
    ].sort()
    const aboveSide = liveFaceUuids(r, 'body_ex1').filter((u) => sideChildren.includes(u))
    const belowSide = liveFaceUuids(r, 'body_ex1_1').filter((u) => sideChildren.includes(u))
    expect(aboveSide).toHaveLength(1)
    expect(belowSide).toHaveLength(1)
    expect(aboveSide[0]).not.toBe(belowSide[0])
    expect(liveFaceUuids(r, 'body_ex1')).not.toContain(sideBefore)
    expect(liveFaceUuids(r, 'body_ex1_1')).not.toContain(sideBefore)
    // Each half's cap carries its own side path.
    expect(liveFaceUuids(r, 'body_ex1')).toContain(capUuid('sp1', 'above'))
    expect(liveFaceUuids(r, 'body_ex1_1')).toContain(capUuid('sp1', 'below'))
    expectUniqueFaceUuids(r, 'sp1')
  })

  it('pick persistence: face and edge picks survive the split and a plane offset edit', () => {
    const base = h.run(blockSpec())
    const topFace = faceQueryAt(base, 'body_ex1', [5, 10, 5])
    const topEdge = (() => {
      const view = viewOf(base, 'body_ex1')
      const at = (view.edges ?? []).findIndex((e) => {
        if (e.kind !== 'line' || e.start === undefined || e.end === undefined) return false
        return Math.abs(e.start[1] - 10) < 1e-6 && Math.abs(e.end[1] - 10) < 1e-6
      })
      expect(at).toBeGreaterThanOrEqual(0)
      return view.edge_queries?.[at] ?? ''
    })()
    expect(topFace).not.toBe('')
    expect(topEdge).not.toBe('')

    const first = h.run(blockSpec(split('sp1', ['@ex1'], '@pl1', 'above')))
    expect(h.res(first, 'sp1').status).toBe('ok')
    const capQuery = faceQueryAt(first, 'body_ex1', [5, 5, 5])
    const cap = uuidTokenOf(capQuery)
    expect(cap).toBe(capUuid('sp1', 'above'))
    expect(liveFaceUuids(first, 'body_ex1')).toContain(uuidTokenOf(topFace))
    expect((viewOf(first, 'body_ex1').edge_queries ?? []).map(uuidTokenOf)).toContain(uuidTokenOf(topEdge))

    // Move the plane up one mm: the cap's UUID is offset-independent.
    const moved = blockSpec(split('sp1', ['@ex1'], '@pl1', 'above'))
    moved.features[2] = planeOffset('pl1', '@builtin_plane_top', 6)
    const second = h.run(moved, { prevState: first._build_state })
    expect(h.res(second, 'sp1').status).toBe('ok')
    expect(volumeAt(second, 'sp1', 'body_ex1')).toBeCloseTo(400, 6)
    expect(uuidAt(second, 'body_ex1', [5, 6, 5])).toBe(cap)
    expect(liveFaceUuids(second, 'body_ex1')).toContain(uuidTokenOf(topFace))
    expect((viewOf(second, 'body_ex1').edge_queries ?? []).map(uuidTokenOf)).toContain(uuidTokenOf(topEdge))
  })

  it('a dropped-side pick loses its UUID instead of being re-targeted', () => {
    const base = h.run(blockSpec())
    const bottomBefore = uuidAt(base, 'body_ex1', [5, 0, 5]) as string
    const r = h.run(blockSpec(split('sp1', ['@ex1'], '@pl1', 'above')))
    expect(h.res(r, 'sp1').status).toBe('ok')
    const live = new Set(liveFaceUuids(r, 'body_ex1'))
    expect(live.has(bottomBefore)).toBe(false)
  })

  it('a disconnecting half yields one body per arm, with stable ids', () => {
    const u = polySketch('sk1', [
      [0, 0], [10, 0], [10, 6], [8, 6], [8, 2], [2, 2], [2, 6], [0, 6],
    ])
    const spec = (): { features: Dict[] } => ({
      features: [
        u,
        extrude('ex1', '$sk1', 10),
        planeOffset('pl1', '@builtin_plane_top', 2),
        split('sp1', ['@ex1'], '@pl1', 'above'),
      ],
    })
    const r = h.run(spec())
    expect(h.res(r, 'sp1').status).toBe('ok')
    expect(h.res(r, 'sp1').body_ids).toEqual(['body_ex1', 'body_ex1_1'])
    expect(volumeAt(r, 'sp1', 'body_ex1')).toBeCloseTo(80, 5)
    expect(volumeAt(r, 'sp1', 'body_ex1_1')).toBeCloseTo(80, 5)
    expectUniqueFaceUuids(r, 'sp1')

    // The same arms land on the same ids on a fresh rebuild.
    const again = h.run(spec())
    for (const id of ['body_ex1', 'body_ex1_1']) {
      expect(volumeAt(again, 'sp1', id)).toBeCloseTo(volumeAt(r, 'sp1', id), 6)
      expect(bboxAt(again, 'sp1', id).centre[0]).toBeCloseTo(bboxAt(r, 'sp1', id).centre[0], 6)
    }
  })

  it('fails loud when the plane misses the body, leaving it untouched', () => {
    // The plane is below the whole body, so keeping above would keep all of it.
    const spec = blockSpec(split('sp1', ['@ex1'], '@pl1', 'above'))
    spec.features[2] = planeOffset('pl1', '@builtin_plane_top', -5)
    const r = h.run(spec)
    expect(h.res(r, 'sp1').status).toBe('exception')
    expect(String(h.res(r, 'sp1').exception)).toContain("split: the plane does not cross body 'body_ex1'")
    // The body is still there, whole.
    expect(Object.keys(snapshot(r, 'sp1')).sort()).toEqual(['body_ex1'])
    expect(volumeAt(r, 'sp1', 'body_ex1')).toBeCloseTo(1000, 6)
  })

  it('fails loud when the kept side is empty, naming the side', () => {
    const spec = blockSpec(split('sp1', ['@ex1'], '@pl1', 'above'))
    spec.features[2] = planeOffset('pl1', '@builtin_plane_top', 20)
    const r = h.run(spec)
    expect(h.res(r, 'sp1').status).toBe('exception')
    expect(String(h.res(r, 'sp1').exception)).toContain("nothing of body 'body_ex1' lies above the plane")
    expect(Object.keys(snapshot(r, 'sp1')).sort()).toEqual(['body_ex1'])
    expect(volumeAt(r, 'sp1', 'body_ex1')).toBeCloseTo(1000, 6)
  })

  it('takes a face pick as the plane, above being the face outward side', () => {
    const spec = (): { features: Dict[] } => ({
      features: [
        rectSketch('sk1', 10, 10),
        extrude('ex1', '$sk1', 10),
        // A second block spanning y -5..5; its TOP face normal is +Y.
        rectSketch('sk2', 10, 10, { x0: 20, y0: -5 }),
        extrude('ex2', '$sk2', 10),
      ],
    })
    const base = h.run(spec())
    const planeFace = faceQueryAt(base, 'body_ex2', [25, 5, 5])
    expect(planeFace).not.toBe('')
    const withSplit = spec()
    withSplit.features.push(split('sp1', ['@ex1'], planeFace, 'above'))
    const r = h.run(withSplit)
    expect(h.res(r, 'sp1').status).toBe('ok')
    expect(volumeAt(r, 'sp1', 'body_ex1')).toBeCloseTo(500, 6)
    expect(bboxAt(r, 'sp1', 'body_ex1').min[1]).toBeCloseTo(5, 6)
  })

  it('two bodies: a failure on the second leaves the first untouched', () => {
    const spec = (): { features: Dict[] } => ({
      features: [
        rectSketch('sk1', 10, 10),
        extrude('ex1', '$sk1', 10),
        rectSketch('sk2', 10, 10, { y0: 20 }),
        extrude('ex2', '$sk2', 10),
        planeOffset('pl1', '@builtin_plane_top', 5),
        split('sp1', ['@ex1', '@ex2'], '@pl1', 'above'),
      ],
    })
    const r = h.run(spec())
    expect(h.res(r, 'sp1').status).toBe('exception')
    expect(String(h.res(r, 'sp1').exception)).toContain("body 'body_ex2'")
    const store = snapshot(r, 'sp1')
    expect(Object.keys(store).sort()).toEqual(['body_ex1', 'body_ex2'])
    expect(volumeAt(r, 'sp1', 'body_ex1')).toBeCloseTo(1000, 6)
    expect(volumeAt(r, 'sp1', 'body_ex2')).toBeCloseTo(1000, 6)
    expect(store.body_ex1.modified_by).toEqual([])
  })

  it('splits a stepped body exactly at its step, keeping the step face', () => {
    const base = h.run({
      features: [
        polySketch('sk1', [[0, 0], [10, 0], [10, 3], [4, 3], [4, 8], [0, 8]]),
        extrude('ex1', '$sk1', 10),
      ],
    })
    const stepBefore = uuidAt(base, 'body_ex1', [7, 3, 5])
    expect(stepBefore).toBeTruthy()

    const r = h.run({
      features: [
        polySketch('sk1', [[0, 0], [10, 0], [10, 3], [4, 3], [4, 8], [0, 8]]),
        extrude('ex1', '$sk1', 10),
        planeOffset('pl1', '@builtin_plane_top', 3),
        split('sp1', ['@ex1'], '@pl1', 'both'),
      ],
    })
    expect(h.res(r, 'sp1').status).toBe('ok')
    const above = volumeAt(r, 'sp1', 'body_ex1')
    const below = volumeAt(r, 'sp1', 'body_ex1_1')
    expect(above + below).toBeCloseTo(500, 6)
    expect(above).toBeCloseTo(200, 6)
    expect(below).toBeCloseTo(300, 6)
    // The step face is on the below half and keeps its UUID, whether the clean
    // merged the cap into it or not.
    expect(liveFaceUuids(r, 'body_ex1_1')).toContain(stepBefore)
    expect(faceCountAt(r, 'sp1', 'body_ex1')).toBe(6)
    expectUniqueFaceUuids(r, 'sp1')
  })

  it('a tangent plane never reports ok', () => {
    const spec: { features: Dict[] } = {
      features: [
        { id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front', entities: [{ id: 'c1', kind: 'circle' }], initial: { c1: [0, 0, 5] } },
        extrude('ex1', '$sk1', 10),
        planeOffset('pl1', '@builtin_plane_right', 5),
        split('sp1', ['@ex1'], '@pl1', 'both'),
      ],
    }
    const r = h.run(spec)
    const res = h.res(r, 'sp1')
    expect(res.status).toBe('exception')
    const message = String(res.exception)
    expect(
      message.includes('does not cross') || message.includes('unsound result'),
      `tangent split must refuse, got: ${message}`,
    ).toBe(true)
    expect(Object.keys(snapshot(r, 'sp1')).sort()).toEqual(['body_ex1'])
    expect(volumeAt(r, 'sp1', 'body_ex1')).toBeCloseTo(Math.PI * 25 * 10, 4)
  })

  it('splits an imported STEP body with the face merge off', () => {
    const scope = new DisposeScope()
    let bytes: Uint8Array
    try {
      bytes = stepShapeToBytes(occ, scope, makeBoxAt(occ, scope, [0, 0, 0], 10, 10, 10))
    } finally {
      scope.dispose()
    }
    const r = h.run({
      features: [
        { id: 'im1', kind: 'import_step', file_id: 'f1' },
        planeOffset('pl1', '@builtin_plane_top', 5),
        split('sp1', ['@im1'], '@pl1', 'above'),
      ],
    }, { files: new Map([['f1', bytes]]) })
    expect(h.res(r, 'sp1').status).toBe('ok')
    expect(volumeAt(r, 'sp1', 'body_im1')).toBeCloseTo(500, 6)
    expect(snapshot(r, 'sp1').body_im1.imported).toBe(true)
  })

  it('a suppressed split and a rollback above it leave the body unchanged', () => {
    const suppressed = blockSpec({ ...split('sp1', ['@ex1'], '@pl1', 'above'), suppressed: true })
    const r = h.run(suppressed)
    expect(Object.keys(snapshot(r, 'sp1')).sort()).toEqual(['body_ex1'])
    expect(volumeAt(r, 'sp1', 'body_ex1')).toBeCloseTo(1000, 6)

    const rolled = h.run(blockSpec(split('sp1', ['@ex1'], '@pl1', 'above')), { rollbackPosition: 3 })
    expect(h.res(rolled, 'sp1').status).toBeUndefined()
    expect(Object.keys(snapshot(rolled, 'pl1')).sort()).toEqual(['body_ex1'])
    expect(volumeAt(rolled, 'pl1', 'body_ex1')).toBeCloseTo(1000, 6)
  })
})
