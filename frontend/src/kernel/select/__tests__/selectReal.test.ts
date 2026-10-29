// @vitest-environment node
//
// Real-kernel tests for the selector engine: build a box through solveLocally,
// select its edges by predicate, and prove the returned queries (a) are the
// exact strings the picking path registers, (b) drive a fillet to the same body
// the oracle 09-fillet-vertical-naming case describes, and (c) survive an
// upstream dimension edit. Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { makeFaceFromWire, makeLineEdge, makeWire } from '../../occ/primitives'
import { solidToEdges, solidToFaceEdgeQueries } from '../../occ/tessellation'
import type { OccModule, OccShape } from '../../occ/occTypes'
import { measureLocally, setSolveLocalsForTest, solveLocally } from '../../solveLocally'
import { setSketchSolver, resetSketchSolver } from '../../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { selectByPredicate, SelectorError } from '@/kernel/select'
import type { Selector } from '@/kernel/select'
import { resolveEdgeQueries } from '@/components/Geometry3D/bodyGeometry'
import { topoFallbackQuery } from '@/utils/query/selectionId'
import type { BodyResult } from '@/types/cad'

const oc = await loadOcc()
const solveBytes = loadSolver()

function rectSketch(sketchId: string, w: number, h: number, offsetX = 0, offsetY = 0, plane = '@builtin_plane_front') {
  const ox = offsetX
  const oy = offsetY
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane,
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

function extrude(id: string, distance: number, extra: Record<string, unknown> = {}) {
  return { id, kind: 'extrude', sketch: '$sk1', distance, direction: 'normal', operation: 'new', ...extra }
}

const PARALLEL_Z: Selector = { kind: 'edge', where: { parallel: [0, 0, 1] } }

async function bodiesOf(spec: Record<string, unknown>): Promise<Record<string, BodyResult>> {
  const response = await solveLocally(spec)
  if (!response) throw new Error('unreachable: skipIf guards the kernel')
  return response.bodies as Record<string, BodyResult>
}

function firstBody(bodies: Record<string, BodyResult>): BodyResult {
  const ids = Object.keys(bodies).sort()
  const body = bodies[ids[0]]
  if (!body) throw new Error('solve produced no body')
  return body
}

function faceCount(body: BodyResult): number {
  return body.mesh?.face_data?.length ?? 0
}

/** The producer's own seam list for a body, not the selector's check, so the
 *  expectation stays independent of the code it judges. */
function seamQueries(body: BodyResult): Set<string> {
  return new Set((body.mesh?.face_seam_queries ?? []).flat())
}

/** The queries of the edges that run along Z, the plate extrusion direction. */
function zLineQueries(body: BodyResult): string[] {
  return (body.edges ?? []).flatMap((edge, index) => {
    if (edge.kind !== 'line') return []
    const length = Math.hypot(edge.end[0] - edge.start[0], edge.end[1] - edge.start[1], edge.end[2] - edge.start[2])
    if (length === 0 || Math.abs(edge.end[2] - edge.start[2]) / length < 1 - 1e-6) return []
    const query = body.edge_queries?.[index] ?? ''
    return query ? [query] : []
  })
}

/** An open bent sheet: two planar faces sharing one edge. Its free boundary
 *  edges belong to one face each, exactly like a seam, so the count fallback
 *  would drop them; the producer's seam list keeps them selectable. */
function openBentSheet(occ: OccModule, scope: DisposeScope): OccShape {
  const occAny = occ as unknown as {
    TopoDS_Shell: new () => OccShape
    BRep_Builder: new () => {
      MakeShell(shell: OccShape): void
      Add(shell: OccShape, part: OccShape): void
      delete(): void
    }
  }
  const edge = (a: [number, number, number], b: [number, number, number]): OccShape =>
    scope.track(makeLineEdge(occ, scope, a, b))
  const shared = edge([-8, 0, 0], [-8, 0, 10])
  const faceA = scope.track(makeFaceFromWire(occ, scope, scope.track(makeWire(occ, scope, [
    shared,
    edge([-8, 0, 10], [-8, 10, 10]),
    edge([-8, 10, 10], [-8, 10, 0]),
    edge([-8, 10, 0], [-8, 0, 0]),
  ], { requireClosed: true }))))
  const faceB = scope.track(makeFaceFromWire(occ, scope, scope.track(makeWire(occ, scope, [
    shared,
    edge([-8, 0, 10], [-18, 0, 10]),
    edge([-18, 0, 10], [-18, 0, 0]),
    edge([-18, 0, 0], [-8, 0, 0]),
  ], { requireClosed: true }))))
  const shell = scope.track(new occAny.TopoDS_Shell())
  const builder = scope.track(new occAny.BRep_Builder())
  builder.MakeShell(shell)
  builder.Add(shell, faceA)
  builder.Add(shell, faceB)
  return shell
}

describe.skipIf(!oc || !solveBytes)('selectByPredicate (real OCC + Rust solver)', () => {
  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
    setSolveLocalsForTest(async () => oc)
  })
  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('selects the four vertical edges of a box and reports their length', async () => {
    const bodies = await bodiesOf({ id: 'sel-basic', features: [rectSketch('sk1', 10, 10), extrude('ex1', 6)] })
    const result = selectByPredicate(PARALLEL_Z, bodies)
    expect(result.queries).toHaveLength(4)
    for (const item of result.items) {
      expect(item.kind).toBe('edge')
      expect(item.geometry).toMatchObject({ kind: 'line', length: 6 })
    }
  })

  it('parallel on a filleted plate keeps straight Y edges and drops the fillet arcs', async () => {
    // A plate on Top extruded along +Y (Y is up), filleted on its four
    // Y-parallel corner edges. The fillet's top and bottom boundary arcs are
    // swept in XZ planes, so their circle axis is Y: the axis reading used to
    // return them for `parallel [0,1,0]`. The tangent reading must not.
    const base = {
      id: 'sel-fillet-parallel',
      features: [rectSketch('sk1', 40, 30, 0, 0, '@builtin_plane_top'), extrude('ex1', 10)],
    }
    const plate = await bodiesOf(base)
    const verticals = selectByPredicate({ kind: 'edge', where: { parallel: [0, 1, 0] } }, plate)
    expect(verticals.queries).toHaveLength(4)
    for (const item of verticals.items) expect(item.geometry).toMatchObject({ kind: 'line', length: 10 })

    const filleted = {
      id: base.id,
      features: [...base.features, { id: 'fi1', kind: 'fillet', fillet: { edges: verticals.queries, radius: 3 } }],
    }
    const bodies = await bodiesOf(filleted)
    const body = firstBody(bodies)
    // The regression case must exist on this body, or the assertion below is
    // vacuous: at least one arc whose underlying circle axis is Y.
    const yArcs = (body.edges ?? []).filter(
      (e): boolean => (e.kind === 'arc' || e.kind === 'circle') && Math.abs(e.axis[1]) > 1 - 1e-6,
    )
    expect(yArcs.length).toBeGreaterThan(0)

    const selected = selectByPredicate({ kind: 'edge', where: { parallel: [0, 1, 0] } }, bodies)
    // The four corners each split into two tangent seams, so the fillet leaves
    // more than four straight Y edges; every one of them is a line, though.
    expect(selected.queries.length).toBeGreaterThanOrEqual(4)
    for (const item of selected.items) expect(item.geometry.kind).toBe('line')
  })

  it('feeds the selected queries to a fillet and reproduces oracle 09-fillet-vertical-naming', async () => {
    const box = { id: 'sel-oracle', features: [rectSketch('sk1', 20, 10), extrude('ex1', 6)] }
    const queries = selectByPredicate(PARALLEL_Z, await bodiesOf(box)).queries
    expect(queries).toHaveLength(4)

    const filleted = {
      id: 'sel-oracle',
      features: [...box.features, { id: 'fi1', kind: 'fillet', fillet: { edges: queries, radius: 2 } }],
    }
    const measure = await measureLocally(filleted)
    expect(measure).not.toBeNull()
    expect(measure!.faces).toBe(10)
    expect(measure!.volume).toBeCloseTo(1179.398223686155, 6)
  })

  it('returns exactly the queries the picking path registers for the same named edges', async () => {
    const bodies = await bodiesOf({ id: 'sel-click', features: [rectSketch('sk1', 10, 10), extrude('ex1', 5)] })
    const body = firstBody(bodies)
    // All 12 box edges are named, so the picking path returns the kernel array
    // by identity and the selector's whole-edge list is that same list, in order.
    expect(resolveEdgeQueries(body.edges, body.edge_queries, body.id)).toBe(body.edge_queries)
    const selected = selectByPredicate({ kind: 'edge' }, bodies).queries
    expect(selected).toEqual(body.edge_queries)
    expect(selected).toHaveLength(12)
  })

  it('cannot name an edge the kernel left unnamed, where a click stores a topo fallback', async () => {
    const bodies = await bodiesOf({ id: 'sel-unnamed', features: [rectSketch('sk1', 10, 10), extrude('ex1', 5)] })
    const bodyId = Object.keys(bodies).sort()[0]
    const body = bodies[bodyId]
    // Poke the defensive-alignment gap: a short kernel query array. The picking
    // path pads the missing slot with a body/index topo fallback, while the
    // selector only ever returns kernel-named queries and so drops that edge.
    // The divergence is the documented limit of selector output under a click.
    const queries = [...(body.edge_queries ?? []).slice(0, -1), '']
    const registered = resolveEdgeQueries(body.edges, queries, bodyId)
    expect(registered).not.toBeNull()
    const fallback = topoFallbackQuery(bodyId, 'edge', queries.length - 1)
    expect(registered![registered!.length - 1]).toBe(fallback)

    const unnamed = { [bodyId]: { ...body, edge_queries: queries } }
    const selected = selectByPredicate({ kind: 'edge' }, unnamed).queries
    expect(selected).toHaveLength(11)
    expect(selected).not.toContain(fallback)
  })

  it('the selected queries survive an upstream extrude-distance edit', async () => {
    const base = [rectSketch('sk1', 20, 10), extrude('ex1', 6)]
    const r1 = await solveLocally({ id: 'sel-edit', features: base })
    expect(r1).not.toBeNull()
    const queries = selectByPredicate(PARALLEL_Z, r1!.bodies as Record<string, BodyResult>).queries

    const filletFeature = { id: 'fi1', kind: 'fillet', fillet: { edges: queries, radius: 2 } }
    const r2 = await solveLocally({ id: 'sel-edit', features: [...base, filletFeature] })
    expect(r2).not.toBeNull()
    expect(faceCount(firstBody(r2!.bodies as Record<string, BodyResult>))).toBe(10)

    // Edit the extrude distance 6 -> 10 against the previous build; the stored
    // fillet queries must still resolve to the same edges.
    const taller = [rectSketch('sk1', 20, 10), extrude('ex1', 10), filletFeature]
    const r3 = await solveLocally({ id: 'sel-edit', features: taller }, { prevState: r2!._build_state })
    expect(r3).not.toBeNull()
    expect((r3!.result.fi1 as { status: string }).status).toBe('ok')
    expect(faceCount(firstBody(r3!.bodies as Record<string, BodyResult>))).toBe(10)

    const measure = await measureLocally({ id: 'sel-edit-measure', features: taller })
    expect(measure!.faces).toBe(10)
    expect(measure!.volume).toBeCloseTo(1965.6637061435918, 6)
  })

  it('created_by narrows to the edges a feature made', async () => {    const bodies = await bodiesOf({
      id: 'sel-created-by',
      features: [
        rectSketch('sk1', 20, 20), extrude('ex1', 10),
        rectSketch('sk2', 6, 6, 7, 7),
        // The bump protrudes past the base top, so the fuse creates new edges
        // attributed to ex2 (a fully contained tool would add none).
        { id: 'ex2', kind: 'extrude', sketch: '$sk2', distance: 15, direction: 'normal', operation: 'add', merge_target: 'body_ex1' },
      ],
    })
    const madeByEx2 = selectByPredicate({ kind: 'edge', where: { created_by: 'ex2' } }, bodies)
    expect(madeByEx2.queries.length).toBeGreaterThan(0)
    for (const item of madeByEx2.items) expect(item.query).toContain('@ex2')
    // The base feature still owns the edges it made; the two sets partition.
    const madeByEx1 = selectByPredicate({ kind: 'edge', where: { created_by: 'ex1' } }, bodies)
    expect(madeByEx1.queries.length).toBeGreaterThan(0)
    for (const item of madeByEx1.items) expect(item.query).toContain('@ex1')
  })

  // A joined extrude's faces belong to the extrude that added them, and a later
  // fillet does not move them back onto the body's creator (join-cap-lineage).
  it('created_by keeps a joined boss after a downstream fillet', async () => {
    const plate = [rectSketch('sk1', 15, 15, -7.5, -7.5), extrude('ex1', 2)]
    const doc = (extra: Array<Record<string, unknown>>) => ({
      id: 'sel-join-created-by',
      features: [
        ...plate,
        { id: 'pl2', kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_front', offset: 2 } },
        {
          id: 'sk2', kind: 'sketch', label: 'Boss', plane: '@pl2',
          entities: [{ id: 'boss', kind: 'circle' }], initial: { boss: [0, 0, 4] }, constraints: [],
        },
        { id: 'ex2', kind: 'extrude', extrude: { sketch: '@sk2', distance: 10, direction: 'normal', operation: 'add' } },
        ...extra,
      ],
    })
    const base = await bodiesOf(doc([]))
    const added = selectByPredicate({ kind: 'face', where: { created_by: 'ex2' } }, base)
    expect(added.queries, 'the boss top and its wall').toHaveLength(2)

    // The junction edge, found by geometry test-side only to feed the fillet.
    const body = firstBody(base)
    const junction = (body.edge_queries ?? []).find((_q, i) => {
      const edge = body.edges?.[i]
      return edge?.kind === 'circle' && Math.abs((edge.center?.[2] ?? -1) - 2) < 1e-6
    })
    expect(junction, 'the boss/plate junction edge').toBeTruthy()

    const filleted = await bodiesOf(doc([{ id: 'fi1', kind: 'fillet', fillet: { edges: [junction], radius: 0.5 } }]))
    const kept = selectByPredicate({ kind: 'face', where: { created_by: 'ex2' } }, filleted)
    expect(kept.queries, 'still the boss top and its wall').toHaveLength(2)
    for (const item of kept.items) {
      expect(item.query).toContain('@ex2')
      expect(item.query).toContain('@sk2/boss')
      expect(item.query).not.toContain('@sk1/')
    }
    const types = kept.items.map((item) => (item.geometry as { surface_type: string }).surface_type).sort()
    expect(types).toEqual(['cylinderface', 'flatface'])
  })

  it('picks a corner edge by the midpoint of its curve', async () => {
    const bodies = await bodiesOf({ id: 'sel-center', features: [rectSketch('sk1', 10, 10), extrude('ex1', 6)] })
    const selected = selectByPredicate({ kind: 'edge', where: { center: { point: [0, 0, 3] } } }, bodies)
    expect(selected.queries).toHaveLength(1)
    const geometry = selected.items[0].geometry as { kind: string; start: number[]; end: number[] }
    expect(geometry.kind).toBe('line')
    expect([geometry.start, geometry.end]).toContainEqual([0, 0, 0])
    expect([geometry.start, geometry.end]).toContainEqual([0, 0, 6])
  })

  it('picks a curved edge by its conic centre', async () => {
    const bodies = await bodiesOf({
      id: 'sel-center-circle',
      features: [
        rectSketch('sk1', 20, 10),
        extrude('ex1', 10),
        {
          id: 'sk2', kind: 'sketch', plane: '@builtin_plane_front',
          entities: [{ id: 'p', kind: 'point' }], initial: { p: [10, 5] }, constraints: [],
        },
        { id: 'ho1', kind: 'hole', hole: { sketch: '@sk2', diameter: 4, depth_mode: 'through_all', target: 'body_ex1' } },
      ],
    })
    const selected = selectByPredicate({ kind: 'edge', where: { center: { point: [10, 5, 0] } } }, bodies)
    expect(selected.queries).toHaveLength(1)
    expect(selected.items[0].geometry).toMatchObject({ kind: 'circle', center: [10, 5, 0], radius: 2 })
  })

  it('finds the short connecting edge of two intersecting chamfers by its centre', async () => {
    const base = [rectSketch('sk1', 20, 10), extrude('ex1', 6)]
    const baseBodies = await bodiesOf({ id: 'sel-chamfer', features: base })
    // Two edges that meet at the corner (0,0,6): the front-left vertical and
    // the front-top edge along X.
    const vertical = selectByPredicate({
      kind: 'edge',
      where: { and: [
        { parallel: [0, 0, 1] },
        { extreme: { axis: [1, 0, 0], side: 'min' } },
        { extreme: { axis: [0, 1, 0], side: 'min' } },
      ] },
    }, baseBodies)
    const top = selectByPredicate({
      kind: 'edge',
      where: { and: [
        { parallel: [1, 0, 0] },
        { extreme: { axis: [0, 0, 1], side: 'max' } },
        { extreme: { axis: [0, 1, 0], side: 'min' } },
      ] },
    }, baseBodies)
    expect(vertical.queries).toHaveLength(1)
    expect(top.queries).toHaveLength(1)

    const chamfered = await bodiesOf({
      id: 'sel-chamfer',
      features: [
        ...base,
        {
          id: 'ch1', kind: 'chamfer',
          chamfer: { edges: [...vertical.queries, ...top.queries], distance: 2 },
        },
      ],
    })
    // The two chamfer planes meet on the short edge (2,0,4)-(0,2,6); a 1 mm
    // radius around its midpoint excludes every other edge's representative
    // point (the nearest is 2.4 mm away).
    const selected = selectByPredicate({ kind: 'edge', where: { center: { point: [1, 1, 5], radius: 1 } } }, chamfered)
    expect(selected.queries).toHaveLength(1)
    const geometry = selected.items[0].geometry as { kind: string; start: number[]; end: number[]; length: number }
    expect(geometry.kind).toBe('line')
    expect(geometry.length).toBeCloseTo(Math.sqrt(12), 6)
    // The solve leaves f64 noise on the endpoints, so compare within a micron.
    const ends = [geometry.start, geometry.end]
    const hasPoint = (p: number[]): boolean =>
      ends.some(end => end.every((value, i) => Math.abs(value - p[i]) < 1e-6))
    expect(hasPoint([2, 0, 4])).toBe(true)
    expect(hasPoint([0, 2, 6])).toBe(true)
  })

  it('an open bent sheet keeps its free edges in parallel', () => {
    const scope = new DisposeScope()
    try {
      const table = new HandleTable()
      const handle = table.register(openBentSheet(oc!, scope), 'bend1')
      const edges = solidToEdges(oc!, table, handle, { createdBy: 'bend1', bodyId: 'body_bend' })
      const faceData = solidToFaceEdgeQueries(oc!, table, handle, edges.edge_queries)
      // An open shell has no seam: every face meets each of its edges once.
      expect(faceData.face_seam_queries.flat()).toEqual([])
      const body: BodyResult = {
        id: 'body_bend',
        created_by: 'bend1',
        modified_by: [],
        edges: edges.edges,
        edge_queries: edges.edge_queries,
        mesh: {
          vertices: [],
          faces: [],
          face_edge_queries: faceData.face_edge_queries,
          face_seam_queries: faceData.face_seam_queries,
        },
      }
      const selected = selectByPredicate({ kind: 'edge', where: { parallel: [0, 1, 0] } }, { body_bend: body })
      // The two Y edges of the first face are free (one face each). The old
      // count rule called them seams and returned none.
      expect(selected.queries).toHaveLength(2)
    } finally {
      scope.dispose()
    }
  })

  it('parallel drops the bore seam of a plate with a through hole', async () => {
    const bodies = await bodiesOf({
      id: 'sel-seam',
      features: [
        rectSketch('sk1', 20, 10),
        extrude('ex1', 10),
        {
          id: 'sk2', kind: 'sketch', plane: '@builtin_plane_front',
          entities: [{ id: 'p', kind: 'point' }], initial: { p: [10, 5] }, constraints: [],
        },
        { id: 'ho1', kind: 'hole', hole: { sketch: '@sk2', diameter: 4, depth_mode: 'through_all', target: 'body_ex1' } },
      ],
    })
    const body = firstBody(bodies)
    const seams = seamQueries(body)
    expect(seams.size, 'the bore lateral seam').toBe(1)
    // Today's unfiltered reading: the four plate corners plus the seam.
    const alongZ = zLineQueries(body)
    expect(alongZ).toHaveLength(5)
    expect(alongZ).toEqual(expect.arrayContaining([...seams]))

    const selected = selectByPredicate({ kind: 'edge', where: { parallel: [0, 0, 1] } }, bodies)
    expect(selected.queries).toHaveLength(4)
    for (const query of selected.queries) expect(seams.has(query)).toBe(false)
  })

  it('a bare cylinder is now a clean empty parallel match', async () => {
    const bodies = await bodiesOf({
      id: 'sel-cylinder',
      features: [
        {
          id: 'sk1', kind: 'sketch', plane: '@builtin_plane_top',
          entities: [{ id: 'c1', kind: 'circle' }], initial: { c1: [0, 15, 5] }, constraints: [],
        },
        { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'normal', operation: 'new' },
      ],
    })
    // The seam is the only Y-parallel line, so the old reading matched one edge.
    const body = firstBody(bodies)
    const yLines = (body.edges ?? []).filter((edge) => {
      if (edge.kind !== 'line') return false
      const length = Math.hypot(edge.end[0] - edge.start[0], edge.end[1] - edge.start[1], edge.end[2] - edge.start[2])
      return length > 0 && Math.abs(edge.end[1] - edge.start[1]) / length > 1 - 1e-6
    })
    expect(yLines).toHaveLength(1)
    expect(seamQueries(body).size).toBe(1)

    expect(() => selectByPredicate({ kind: 'edge', where: { parallel: [0, 1, 0] } }, bodies))
      .toThrow(SelectorError)
    try {
      selectByPredicate({ kind: 'edge', where: { parallel: [0, 1, 0] } }, bodies)
    } catch (e) {
      expect((e as Error).message).toContain('parallel [0, 1, 0] matched 0')
    }

    // The seam also runs perpendicular to X, so the other direction test had a
    // seam-only match before and is now empty too.
    expect(() => selectByPredicate({ kind: 'edge', where: { perpendicular: [1, 0, 0] } }, bodies))
      .toThrow(SelectorError)
    try {
      selectByPredicate({ kind: 'edge', where: { perpendicular: [1, 0, 0] } }, bodies)
    } catch (e) {
      expect((e as Error).message).toContain('perpendicular [1, 0, 0] matched 0')
    }
  })
})
