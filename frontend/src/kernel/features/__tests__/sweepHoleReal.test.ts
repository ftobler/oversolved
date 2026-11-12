// @vitest-environment node
//
// Real-OCC tests for a one-profile sweep of a profile with holes. The profile is
// an annulus (or a plate with two bores), the path a straight line or a
// line/tangent-arc/line bend. The sweep must carry each hole, so the body is a
// tube instead of the filled solid it used to be, and the bore wall must keep
// the hole entity's construction identity across a path edit.
//
// Seeded repositories (profile topology + path topology) keep every case
// OCC-only: the geometry is exactly what the sketch area builder publishes, so
// the tests do not depend on the Rust solver.
//
// Skips when opencascade.js is absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { Repository } from '../../query'
import { solveSweep } from '../sweep'
import { solveFillet } from '../filletChamfer'
import { volumeOf } from '../../occ/volume'
import { countSolids, countSubShapes } from '../../occ/booleans'
import { faceSurfaceType, type SurfaceType } from '../../occ/primitives'
import { solidToEdges } from '../../occ/tessellation'
import { deriveEdgeUuid } from '../../constructionName'
import type { Body } from '../../types3d'
import type { OccShape } from '../../occ/occTypes'
import type { PlaneLike } from '../shared/planes'
import type { LoopEdge } from '../../profileLoops'

const oc = await loadOcc()

type Dict = Record<string, unknown>
type Resources = { scope: DisposeScope; table: HandleTable }
type Build = {
  status?: string
  store: Record<string, Body>
  body?: Body
  shape?: OccShape
  volume?: number
  faces?: number
  solids?: number
  surfaceTypes?: SurfaceType[]
  error?: string
}

// The builtin Top plane: sketch (u, v) -> world (u, 0, -v). Its normal is +Y.
const TOP: PlaneLike = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 0, -1], normal: [0, 1, 0] }
// The builtin Front plane: sketch (u, v) -> world (u, v, 0). Its normal is +Z.
const FRONT: PlaneLike = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }

/** A whole circle as one full-turn arc loop, the shape the area builder emits
 *  for a circle boundary. */
function circleLoop(id: string, r: number, cx = 0, cy = 0): LoopEdge[] {
  return [{
    id, kind: 'arc', center: [cx, cy], radius: r,
    start: [cx + r, cy], end: [cx + r, cy],
    angle_start_deg: 0, angle_end_deg: 360, ccw: true,
  } as unknown as LoopEdge]
}

/** A straight path on the path plane, `length` long along its local v. */
function straightPath(length: number, start = 0): Dict[] {
  return [{ entity_id: 'spine', edge_index: 0, kind: 'line', start: [0, start], end: [0, start + length] }]
}

/** line 3 / tangent arc r (90 degrees) / line 3, the bend every hole-carry case
 *  is measured on. */
function bentPath(r: number): Dict[] {
  return [
    { entity_id: 'l0', edge_index: 0, kind: 'line', start: [0, 0], end: [0, 3] },
    {
      entity_id: 'a0', edge_index: 1, kind: 'arc', center: [r, 3], radius: r,
      start: [0, 3], end: [r, 3 + r], angle_start_deg: 180, angle_end_deg: 90, ccw: false,
    },
    { entity_id: 'l1', edge_index: 2, kind: 'line', start: [r, 3 + r], end: [r + 3, 3 + r] },
  ]
}

function seedRepo(loops: LoopEdge[][], pathEdges: Dict[]): Repository {
  const repo = new Repository()
  repo.register('_pt_prof', TOP)
  repo.register('_topo_prof', { surfaces: [{ boundary: loops[0], holes: loops.slice(1) }] })
  repo.register('_pt_path', FRONT)
  repo.register('_topo_path', { edges: pathEdges })
  return repo
}

/**
 * Run one whole-sketch sweep through solveSweep and read the body before the
 * resources drain. Without `resources` the helper owns a scope and table and
 * disposes them; a caller that wants the table (the lineage test) passes its own.
 */
function sweepProfile(
  loops: LoopEdge[][],
  pathEdges: Dict[],
  sweep: Dict = {},
  resources?: Resources,
): Build {
  const scope = resources?.scope ?? new DisposeScope()
  const table = resources?.table ?? new HandleTable()
  const own = resources === undefined
  const store: Record<string, Body> = {}
  try {
    try {
      const result = solveSweep(oc!, scope, table, {
        id: 'sw1', kind: 'sweep',
        sweep: { sketch: ['$prof'], path: '$path', operation: 'new', ...sweep },
      }, seedRepo(loops, pathEdges), store)
      const body = store['body_sw1']
      if (body?.shape == null) return { status: result.status, store }
      const shape = table.get<OccShape>(body.shape)
      const E = oc!.TopAbs_ShapeEnum
      const surfaceTypes: SurfaceType[] = []
      const exp = scope.track(new oc!.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
      for (; exp.More(); exp.Next()) {
        surfaceTypes.push(faceSurfaceType(oc!, scope, scope.track(oc!.TopoDS.Face_1(exp.Current()))))
      }
      return {
        status: result.status,
        store,
        body,
        shape,
        volume: volumeOf(oc!, scope, shape),
        faces: countSubShapes(oc!, scope, shape, E.TopAbs_FACE),
        solids: countSolids(oc!, scope, shape),
        surfaceTypes,
      }
    } catch (exc) {
      return { error: (exc as Error).message, store }
    }
  } finally {
    if (own) {
      table.disposeAll()
      scope.dispose()
    }
  }
}

/** The UUIDs whose ancestry token list names `token`. */
function uuidsWithToken(map: Record<string, string[]> | undefined, token: string): string[] {
  return Object.entries(map ?? {})
    .filter(([, tokens]) => tokens.includes(token))
    .map(([uuid]) => uuid)
}

describe.skipIf(!oc)('sweep of a profile with holes (real OCC)', () => {
  it('carries a concentric hole through a straight sweep as a tube', () => {
    // Annulus r2/r1.5 on Top at y=0, path a 10 long +Y line starting 0.5 above
    // the plane (off-plane start, the placement rule accepts it).
    const built = sweepProfile(
      [circleLoop('outer', 2), circleLoop('inner', 1.5)],
      straightPath(10, 0.5),
    )
    expect(built.error).toBeUndefined()
    expect(built.status).toBe('ok')
    const expected = Math.PI * (4 - 2.25) * 10
    expect(Math.abs(built.volume! - expected)).toBeLessThan(expected * 1e-6)
    // One body, and the tube's four faces: outer wall, bore wall, two annular
    // caps. A solid body (the pre-fix result) would have three.
    expect(built.solids).toBe(1)
    expect(built.faces).toBe(4)
    expect(Object.keys(built.store)).toEqual(['body_sw1'])
  })

  it('carries the hole around a bent path, mitres included', () => {
    // The annulus is offset along the bend axis so the path crosses its wall
    // (a centred annulus would put the crossing in the bore, which the placement
    // rule refuses until the bore-crossing plan lands). Pappus: a rigid transport
    // along the path gives area x path length, arc included.
    const built = sweepProfile(
      [circleLoop('outer', 2, 0, 1.75), circleLoop('inner', 1.5, 0, 1.75)],
      bentPath(3),
    )
    expect(built.error).toBeUndefined()
    expect(built.status).toBe('ok')
    const length = 3 + 1.5 * Math.PI + 3
    const expected = Math.PI * (4 - 2.25) * length
    expect(Math.abs(built.volume! - expected)).toBeLessThan(expected * 1e-4)
    expect(built.solids).toBe(1)
    // Both walls exist and follow the bend: each is two cylinders (the straight
    // runs) and one torus (the arc), plus the two annular caps.
    expect(built.surfaceTypes!.filter((t) => t === 'cylinderface')).toHaveLength(4)
    expect(built.surfaceTypes!.filter((t) => t === 'torusface')).toHaveLength(2)
    expect(built.surfaceTypes!.filter((t) => t === 'flatface')).toHaveLength(2)
  })

  it('cuts every hole of a plate with two bores', () => {
    // 10 x 6 rectangle with two r1 bores, path 10 along +Z through the material
    // between them.
    const rect: LoopEdge[] = [
      { kind: 'line', id: 'r0', start: [-5, -3], end: [5, -3] },
      { kind: 'line', id: 'r1', start: [5, -3], end: [5, 3] },
      { kind: 'line', id: 'r2', start: [5, 3], end: [-5, 3] },
      { kind: 'line', id: 'r3', start: [-5, 3], end: [-5, -3] },
    ] as unknown as LoopEdge[]
    const built = sweepProfile(
      [rect, circleLoop('leftBore', 1, -2, 0), circleLoop('rightBore', 1, 2, 0)],
      [{ entity_id: 'spine', edge_index: 0, kind: 'line', start: [0, 0], end: [0, -10] }],
    )
    expect(built.error).toBeUndefined()
    expect(built.status).toBe('ok')
    const expected = (60 - 2 * Math.PI) * 10
    expect(Math.abs(built.volume! - expected)).toBeLessThan(expected * 1e-6)
    expect(built.solids).toBe(1)
    // Four plate walls, two bore cylinders, two caps.
    expect(built.faces).toBe(8)
    expect(built.surfaceTypes!.filter((t) => t === 'cylinderface')).toHaveLength(2)
  })

  it('names the hole walls by their sketch entities, surviving a path length edit', () => {
    const resources: Resources = { scope: new DisposeScope(), table: new HandleTable() }
    try {
      const profile = [circleLoop('outer', 2), circleLoop('inner', 1.5)]
      const first = sweepProfile(profile, straightPath(10, 0.5), {}, resources)
      expect(first.error).toBeUndefined()
      const body = first.body!
      // The bore wall is the inner circle and the outer wall the outer circle.
      const bore = uuidsWithToken(body.face_ancestry, '@prof/inner')
      const shell = uuidsWithToken(body.face_ancestry, '@prof/outer')
      expect(bore).toHaveLength(1)
      expect(shell).toHaveLength(1)
      // The caps are the annuli the cut left. Each keeps the outer shell's cap
      // token: a cut modifies the cap, it does not create a new one, so the
      // bore's token belongs to the bore wall and not to the cap.
      const caps = uuidsWithToken(body.face_cap_ancestry, '@prof/outer')
      expect(caps).toHaveLength(2)

      // Find the bore rim on the far (end) cap: the pair of the bore wall and
      // one of the caps, whichever rim sits at the swept-to end (y = 10).
      const rimUuids = caps.map((cap) => deriveEdgeUuid(bore[0], cap))
      const edges = solidToEdges(oc!, resources.table, body.shape!, {
        createdBy: body.created_by,
        bodyId: body.id,
        edgeAncestry: body.edge_ancestry,
        edgeUuids: body.edge_uuids,
      })
      const endRim = edges.edges.findIndex((edge, i) =>
        rimUuids.includes(edges.edge_uuids[i] ?? '') &&
        (edge.kind === 'circle' || edge.kind === 'arc') &&
        edge.center[1] > 5,
      )
      expect(endRim, 'the bore/end-cap edge carries a construction UUID').toBeGreaterThanOrEqual(0)
      const rimQuery = edges.edge_queries[endRim]

      // Rebuild the same feature with a longer path: the bore wall keeps its
      // UUID, so the query picked on the first build survives the edit.
      const second = sweepProfile(profile, straightPath(12, 0.5))
      expect(second.error).toBeUndefined()
      expect(uuidsWithToken(second.body!.face_ancestry, '@prof/inner')).toEqual(bore)

      const store2: Record<string, Body> = { body_sw1: second.body! }
      const scope2 = new DisposeScope()
      try {
        const fillet = solveFillet(oc!, scope2, resources.table, {
          id: 'fil1', fillet: { edges: [rimQuery], radius: 0.2 },
        }, new Repository(), store2)
        expect(fillet.status).toBe('ok')
      } finally {
        scope2.dispose()
      }
    } finally {
      resources.table.disposeAll()
      resources.scope.dispose()
    }
  })

  it('refuses a hole the tight bend cannot carry, by name and with no body', () => {
    // A 1.2 bend with a 2 rad profile: the inner wall passes through the bend
    // axis, so the cut comes back BRepCheck-invalid. The feature must fail by
    // name instead of shipping the outer body as a solid.
    const built = sweepProfile(
      [circleLoop('outer', 2, 0, 1.75), circleLoop('inner', 1.5, 0, 1.75)],
      bentPath(1.2),
    )
    expect(built.status).toBeUndefined()
    expect(built.error).toBe('sweep: the hole loop inner could not be swept along the path')
    expect(built.store['body_sw1']).toBeUndefined()
  })

  it('leaves a solid profile sweep unchanged (volume, faces, UUIDs)', () => {
    // The no-hole path is the pre-existing one: a plain circle profile still
    // builds the same solid with the same construction names. The UUID set is
    // pinned, since no profile without holes may move.
    const built = sweepProfile([circleLoop('c0', 1.5)], straightPath(10, 0.5))
    expect(built.error).toBeUndefined()
    expect(built.status).toBe('ok')
    const expected = Math.PI * 2.25 * 10
    expect(Math.abs(built.volume! - expected)).toBeLessThan(expected * 1e-6)
    expect(built.faces).toBe(3)
    const faces = (built.body!.face_uuids ?? []).filter((u): u is string => u !== null).sort()
    const edges = (built.body!.edge_uuids ?? []).filter((u): u is string => u !== null).sort()
    expect(faces).toEqual([
      'u_07d420aa81f0f479', 'u_4ef6cb2c52d70ad4', 'u_dab0b483c67eecfe',
    ])
    expect(edges).toEqual([
      'e_33fd589792c6e15e', 'e_6b3b7482a08328d3', 'e_f455723936a95de5',
    ])
  })
})
