// @vitest-environment node
//
// Who owns a hole's breakout edge. An edge a feature's own tool created belongs
// to that feature even when the face it cuts into was mutated by an earlier one
// (feature/bug-cut-edge-credit.md). The reported case: a side hole drilled into
// a pocket cut by an `add_boolean` subtract credited its breakout curve to the
// pocket face's recorded owner (the tool body's creator) instead of the hole,
// while a hole into a plain block credited the hole by accident (the neighbour
// face had no recorded owner, so the modifier stamp won).
//
// Real OCC plus the Rust sketch solver through the production builder
// (SharedHarness), so the test reads the same payload a viewport pick does:
// `face_edge_queries`, `edge_created_by`, and the `select {created_by}` engine.
//
// The audit half pins the other producers: split-by-plane and move-face must
// own the edges of their own tool, and an `add_boolean` seam must keep the tool
// body's creator. Each audit case records the credit the probe measured before
// the fix, so the pinning test says what changed and why.
//
// Skips when OCC.js or the sketch solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { parseAncestry } from '../../query'
import { selectByPredicate } from '../../select'
import { mintFaceUuid, splitPlaneFacePath, moveFaceExtendPath } from '../../constructionName'
import type { BuildResponse } from '../../builder'
import type { BodyResult } from '@/types/cad'

const oc = await loadOcc()
const solveBytes = loadSolver()

type Dict = Record<string, unknown>

interface FaceMesh {
  face_data?: Array<{ centroid: number[]; normal: number[]; surface_type: string }>
  face_queries?: string[]
  face_uuids?: (string | null)[]
  face_created_by?: string[]
  face_edge_queries?: string[][]
}
interface BodyView {
  mesh?: FaceMesh
  edges?: Array<{ kind: string; start?: number[]; end?: number[]; center?: number[] }>
  edge_queries?: string[]
  edge_created_by?: string[]
  edge_uuids?: (string | null)[]
}

// ─── fixtures ───

/** A rectangle sketch on `plane`, fully constrained. */
function rectSketch(id: string, w: number, h: number, plane = '@builtin_plane_front'): Dict {
  const pts: [number, number][] = [[0, 0], [w, 0], [w, h], [0, h]]
  const entities: Dict[] = []
  const initial: Record<string, number[]> = {}
  const constraints: Dict[] = []
  for (let i = 0; i < 4; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % 4]
    entities.push({ id: `l${i}`, kind: 'line' })
    initial[`l${i}`] = [a[0], a[1], b[0], b[1]]
    constraints.push({
      id: `c${i}`, kind: 'coincident',
      a: { entity: `l${i}`, point: 'end' }, b: { entity: `l${(i + 1) % 4}`, point: 'start' },
    })
    constraints.push({ id: `hv${i}`, kind: a[1] === b[1] ? 'horizontal' : 'vertical', target: { entity: `l${i}` } })
  }
  constraints.push({ id: 'len1', kind: 'length', target: { entity: 'l0' }, value: w })
  constraints.push({ id: 'len2', kind: 'length', target: { entity: 'l1' }, value: h })
  return { id, kind: 'sketch', plane, entities, initial, constraints }
}

function circleSketch(id: string, cx: number, cy: number, r: number, plane: string): Dict {
  return {
    id, kind: 'sketch', plane,
    entities: [{ id: 'c1', kind: 'circle' }],
    initial: { c1: [cx, cy, r] },
    constraints: [{ id: 'd1', kind: 'diameter', target: { entity: 'c1' }, value: 2 * r }],
  }
}

/** A single drill site. A free point is fine here: the sketch is not the subject. */
function pointSketch(id: string, x: number, y: number, plane: string): Dict {
  return {
    id, kind: 'sketch', plane,
    entities: [{ id: 'p1', kind: 'point' }], initial: { p1: [x, y] }, constraints: [],
  }
}

const extrude = (id: string, sketch: string, distance: number, operation = 'new'): Dict =>
  ({ id, kind: 'extrude', extrude: { sketch, distance, direction: 'normal', operation } })
const planeOffset = (id: string, plane: string, offset: number): Dict =>
  ({ id, kind: 'plane', definition: { mode: 'offset', plane, offset } })
const hole = (id: string, sketch: string, opts: { diameter: number; depth?: number; through?: boolean }): Dict =>
  ({
    id, kind: 'hole',
    hole: {
      sketch, diameter: opts.diameter,
      depth_mode: opts.through === true ? 'through_all' : 'blind',
      ...(opts.through === true ? {} : { depth: opts.depth }),
      direction: 'normal', target: '@body_ex1',
    },
  })

/**
 * A 20 x 20 x 10 block with a blind cylindrical pocket r6 from z=4 to the top,
 * cut by the ordinary `add_boolean` subtract of a separate extruded tool body.
 * The pocket wall carries the tool body's creator (`ex2`) as its recorded owner,
 * which is the neighbour the breakout bug read.
 */
function pocketBlock(): Dict[] {
  return [
    rectSketch('sk1', 20, 20),
    extrude('ex1', '$sk1', 10),
    planeOffset('pl1', '@builtin_plane_front', 4),
    circleSketch('sk2', 10, 10, 6, '@pl1'),
    extrude('ex2', '$sk2', 7),
    { id: 'bo1', kind: 'boolean', boolean: { operation: 'subtract', target: '@ex1', tools: ['@ex2'] } },
  ]
}

/** The side hole: from the -Y face at x=10, z=7, along +Y (builtin top plane maps
 *  sketch y to world -z). Its bore crosses the pocket wall at y=4. */
function sideHole(id = 'ho1', depth = 10): Dict {
  return hole(id, '$skh', { diameter: 4, depth })
}

/** The same pocket, only 2 deep (z=8 to the top), so moving its floor outward by
 *  more than the depth pushes the floor past the top face: the boss wall that
 *  move leaves is its extension face, and it meets the top face on a new edge. */
function shallowPocketBlock(): Dict[] {
  return [
    rectSketch('sk1', 20, 20),
    extrude('ex1', '$sk1', 10),
    planeOffset('pl1', '@builtin_plane_front', 8),
    circleSketch('sk2', 10, 10, 6, '@pl1'),
    extrude('ex2', '$sk2', 3),
    { id: 'bo1', kind: 'boolean', boolean: { operation: 'subtract', target: '@ex1', tools: ['@ex2'] } },
  ]
}

const sideHoleSketch = (): Dict => pointSketch('skh', 10, -7, '@builtin_plane_top')

// ─── payload readers ───

function tokensOf(query: string): string[] {
  if (!query.startsWith('?')) return []
  try {
    return parseAncestry(query)[0]
  } catch {
    return []
  }
}

/** The bare construction UUID a query leads with (`u_...`), if any. */
const uuidTokenOf = (query: string): string | undefined => {
  const token = tokensOf(query).find((t) => t.startsWith('@u|'))
  return token?.slice('@u|'.length)
}

const bodyOf = (r: BuildResponse, bodyId = 'body_ex1'): BodyView => (r.bodies as Record<string, BodyView>)[bodyId]

const meshOf = (r: BuildResponse, bodyId = 'body_ex1'): FaceMesh => bodyOf(r, bodyId).mesh ?? {}

/** Index of the face whose query ancestry names `token` (`@sk2/c1`, a uuid...). */
function faceWithToken(mesh: FaceMesh, token: string): number {
  const queries = mesh.face_queries ?? []
  for (let i = 0; i < queries.length; i++) if (tokensOf(queries[i]).includes(token)) return i
  return -1
}

/** The edge queries shared by the two faces (the edges where they meet). */
function edgesBetween(mesh: FaceMesh, a: number, b: number): string[] {
  expect(a, 'face A exists').toBeGreaterThanOrEqual(0)
  expect(b, 'face B exists').toBeGreaterThanOrEqual(0)
  const left = new Set(mesh.face_edge_queries?.[a] ?? [])
  return (mesh.face_edge_queries?.[b] ?? []).filter((q) => left.has(q))
}

/** The attributed creator of an edge, read where a pick reads it. */
function creatorOf(view: BodyView, query: string): string | undefined {
  const at = (view.edge_queries ?? []).indexOf(query)
  expect(at, `the edge query is in the payload: ${query}`).toBeGreaterThanOrEqual(0)
  return (view.edge_created_by ?? [])[at]
}

function edgeAt(view: BodyView, query: string): { kind: string; center?: number[]; start?: number[]; end?: number[] } {
  const at = (view.edge_queries ?? []).indexOf(query)
  expect(at).toBeGreaterThanOrEqual(0)
  return (view.edges ?? [])[at]
}

/** Every edge query that names `token`, with its creator. */
function edgesNaming(view: BodyView, token: string): Array<{ query: string; creator: string }> {
  const out: Array<{ query: string; creator: string }> = []
  ;(view.edge_queries ?? []).forEach((q, i) => {
    if (!tokensOf(q).includes(token)) return
    out.push({ query: q, creator: (view.edge_created_by ?? [])[i] })
  })
  return out
}

const capUuid = (featureId: string, bodySlot: string, side: 'above' | 'below'): string =>
  mintFaceUuid(splitPlaneFacePath(featureId, bodySlot, side))

describe.skipIf(!oc || !solveBytes)('hole and self-tool edge credit (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  it('credits a side hole\'s breakout into an owned pocket face to the hole', () => {
    const r = h.run({ features: [...pocketBlock(), sideHoleSketch(), sideHole()] })
    expect(h.res(r, 'bo1').status).toBe('ok')
    expect(h.res(r, 'ho1').status).toBe('ok')
    expect(h.res(r, 'ho1').hole_count).toBe(1)

    const view = bodyOf(r)
    const mesh = meshOf(r)
    const bore = faceWithToken(mesh, '@skh/p1')
    const pocketWall = faceWithToken(mesh, '@sk2/c1')
    // The bore's far boundary is where it opens into the pocket: the seam
    // between the hole's own wall and the pocket's wall. This is the reported
    // edge, which read `ex2` (the pocket face's owner) before the fix.
    const breakout = edgesBetween(mesh, bore, pocketWall)
    expect(breakout).toHaveLength(1)
    expect(edgeAt(view, breakout[0]).kind).toBe('spline')
    expect(creatorOf(view, breakout[0])).toBe('ho1')
    expect(tokensOf(breakout[0])).toContain('@ho1')

    // The selector, the path the author actually uses, finds it and the pocket
    // owner does not claim it.
    const selected = selectByPredicate(
      { from: 'body_ex1', kind: 'edge', where: { created_by: 'ho1' } },
      r.bodies as unknown as Record<string, BodyResult>,
    )
    expect(selected.queries).toContain(breakout[0])
    const pocketEdges = selectByPredicate(
      { from: 'body_ex1', kind: 'edge', where: { created_by: 'ex2' } },
      r.bodies as unknown as Record<string, BodyResult>,
    )
    expect(pocketEdges.queries).not.toContain(breakout[0])

    // The hole keeps the rest of its own edges: the entry circle and the wall.
    const entry = edgesNaming(view, '@skh/p1').filter((e) => edgeAt(view, e.query).kind === 'circle')
    expect(entry.length).toBeGreaterThanOrEqual(1)
    for (const e of entry) expect(e.creator).toBe('ho1')

    // The pocket's own edges keep the tool body's creator: the floor circle,
    // the top rim and the wall seam.
    const pocketCircles = edgesNaming(view, '@sk2/c1').filter((e) => edgeAt(view, e.query).kind === 'circle')
    expect(pocketCircles.length).toBeGreaterThanOrEqual(2)
    for (const e of pocketCircles) expect(e.creator).toBe('ex2')
  })

  it('control: the same hole through a plain block credits its breakout to the hole', () => {
    const r = h.run({
      features: [
        rectSketch('sk1', 20, 20),
        extrude('ex1', '$sk1', 10),
        sideHoleSketch(),
        hole('ho1', '$skh', { diameter: 4, through: true }),
      ],
    })
    expect(h.res(r, 'ho1').status).toBe('ok')
    const view = bodyOf(r)
    const circles = edgesNaming(view, '@skh/p1').filter((e) => edgeAt(view, e.query).kind === 'circle')
    // The entry circle on the -Y face and the exit circle on the +Y face.
    expect(circles).toHaveLength(2)
    for (const e of circles) expect(e.creator).toBe('ho1')
    expect(meshOf(r).face_created_by?.[faceWithToken(meshOf(r), '@skh/p1')]).toBe('ho1')
  })

  it('control: an extrude cut at the same site credits its breakout to the extrude', () => {
    const r = h.run({
      features: [
        ...pocketBlock(),
        circleSketch('skh', 10, -7, 2, '@builtin_plane_top'),
        extrude('exc1', '$skh', 10, 'cut'),
      ],
    })
    expect(h.res(r, 'exc1').status).toBe('ok')
    const view = bodyOf(r)
    const mesh = meshOf(r)
    const breakout = edgesBetween(mesh, faceWithToken(mesh, '@skh/c1'), faceWithToken(mesh, '@sk2/c1'))
    expect(breakout).toHaveLength(1)
    expect(edgeAt(view, breakout[0]).kind).toBe('spline')
    expect(creatorOf(view, breakout[0])).toBe('exc1')
    // The entry circle keeps the extrude too.
    const entries = edgesNaming(view, '@skh/c1').filter((e) => edgeAt(view, e.query).kind === 'circle')
    expect(entries.length).toBeGreaterThanOrEqual(1)
    for (const e of entries) expect(e.creator).toBe('exc1')
  })

  it('chained holes: the crossing edge belongs to the second hole', () => {
    const r = h.run({
      features: [
        rectSketch('sk1', 20, 20),
        extrude('ex1', '$sk1', 10),
        // The first bore crosses the block along +Y at x=10, z=7.
        pointSketch('skh1', 10, -7, '@builtin_plane_top'),
        hole('ho1', '$skh1', { diameter: 4, through: true }),
        // The second drills along +X at y=10, z=7 and stops inside the first
        // bore, so its wall ends on the first wall. builtin_plane_right maps
        // sketch (x, y) to world (0, y, -x).
        pointSketch('skh2', -7, 10, '@builtin_plane_right'),
        hole('ho2', '$skh2', { diameter: 4, depth: 10 }),
      ],
    })
    expect(h.res(r, 'ho1').status).toBe('ok')
    expect(h.res(r, 'ho2').status).toBe('ok')
    expect(h.res(r, 'ho2').hole_count).toBe(1)

    const view = bodyOf(r)
    const mesh = meshOf(r)
    const crossing = edgesBetween(mesh, faceWithToken(mesh, '@skh1/p1'), faceWithToken(mesh, '@skh2/p1'))
    expect(crossing.length).toBeGreaterThanOrEqual(1)
    for (const q of crossing) {
      expect(creatorOf(view, q), q).toBe('ho2')
      expect(tokensOf(q)).toContain('@ho2')
    }
    // The first hole's other edges keep the first hole, including its wall: the
    // second cut split it, and the children carry their parent's owner.
    const firstEdges = edgesNaming(view, '@skh1/p1').filter((e) => !crossing.includes(e.query))
    expect(firstEdges.length).toBeGreaterThanOrEqual(2)
    for (const e of firstEdges) expect(e.creator, e.query).toBe('ho1')
    expect(mesh.face_created_by?.[faceWithToken(mesh, '@skh1/p1')]).toBe('ho1')
  })

  it('split by plane: the cap-to-old-face edge belongs to the split', () => {
    // Probe before the fix: the circle between the split cap and the pocket wall
    // read `ex2` (the pocket wall's owner) while the cap's outer boundary lines
    // read `sp1` only because neither of their faces had a recorded owner.
    const r = h.run({
      features: [
        ...pocketBlock(),
        planeOffset('pl2', '@builtin_plane_front', 7),
        { id: 'sp1', kind: 'split', split: { bodies: ['@ex1'], plane: '@pl2', keep: 'above' } },
      ],
    })
    expect(h.res(r, 'sp1').status).toBe('ok')
    const view = bodyOf(r)
    const mesh = meshOf(r)
    const cap = faceWithToken(mesh, '@u|' + capUuid('sp1', 'body_ex1', 'above'))
    const pocketWall = faceWithToken(mesh, '@sk2/c1')
    const capToPocket = edgesBetween(mesh, cap, pocketWall)
    expect(capToPocket).toHaveLength(1)
    expect(edgeAt(view, capToPocket[0]).kind).toBe('circle')
    expect(creatorOf(view, capToPocket[0])).toBe('sp1')
    expect(tokensOf(capToPocket[0])).toContain('@sp1')
    expect(mesh.face_created_by?.[cap]).toBe('sp1')
    // The cap's outer boundary edges are the split's too.
    for (const q of edgesNaming(view, '@u|' + capUuid('sp1', 'body_ex1', 'above'))) {
      expect(q.creator).toBe('sp1')
    }
    // The pocket's own top rim keeps its creator.
    const topRim = edgesNaming(view, '@sk2/c1').find((e) => (edgeAt(view, e.query).center?.[2] ?? 0) > 9.9)
    expect(topRim?.creator).toBe('ex2')
  })

  it('move_face: an edge its extension forms with an old face belongs to the move', () => {
    // Probe before the fix: pushing the pocket floor out through the top leaves
    // the boss wall as the move's extension face, and the circle where that new
    // wall meets the (ex1-owned) top face read `ex1`, the old neighbour's
    // owner. A moved cap edge whose UUID is carried keeps its earlier owner
    // (the uuid derives from the same face pair, and the recorded entry is
    // applied last, matching the "a modified element keeps its creator" rule),
    // so the extension-to-old-face edge is where the move's own creator shows.
    const base = h.run({ features: shallowPocketBlock() })
    const baseMesh = meshOf(base)
    const wallUuid = uuidTokenOf(baseMesh.face_queries?.[faceWithToken(baseMesh, '@sk2/c1')] ?? '')
    expect(wallUuid).toBeDefined()
    const floorQueries = baseMesh.face_queries ?? []
    const floorData = baseMesh.face_data ?? []
    const floorIndex = floorData.findIndex(
      (fd) => fd.surface_type === 'flatface' && Math.abs(fd.centroid[2] - 8) < 1e-6 && fd.normal[2] > 0.9,
    )
    expect(floorIndex).toBeGreaterThanOrEqual(0)
    const floorQuery = floorQueries[floorIndex]
    const floorUuid = uuidTokenOf(floorQuery)
    expect(floorUuid).toBeDefined()

    const r = h.run({
      features: [...shallowPocketBlock(), { id: 'mf1', kind: 'move_face', move_face: { faces: [floorQuery], distance: 4 } }],
    })
    expect(h.res(r, 'mf1').status).toBe('ok')
    const view = bodyOf(r)
    const mesh = meshOf(r)
    // The extension face is the minted `<mf1>|extend|<old wall>` face the boss
    // wall became; the boolean only folds it when a live twin shares the surface
    // and here the old pocket wall is gone, so it survives as its own face.
    const extension = faceWithToken(mesh, '@u|' + mintFaceUuid(moveFaceExtendPath('mf1', wallUuid as string)))
    expect(extension).toBeGreaterThanOrEqual(0)
    expect(mesh.face_created_by?.[extension]).toBe('mf1')
    // The block top is the z=10 flat face; it is the old face the extension now
    // meets, and it keeps the block's creator.
    const topFace = (mesh.face_data ?? []).findIndex(
      (fd) => fd.surface_type === 'flatface' && Math.abs(fd.centroid[2] - 10) < 1e-6 && fd.normal[2] > 0.9,
    )
    expect(topFace).toBeGreaterThanOrEqual(0)
    expect(mesh.face_created_by?.[topFace]).toBe('ex1')
    const newEdge = edgesBetween(mesh, extension, topFace)
    expect(newEdge).toHaveLength(1)
    expect(edgeAt(view, newEdge[0]).kind).toBe('circle')
    expect(creatorOf(view, newEdge[0])).toBe('mf1')
    expect(tokensOf(newEdge[0])).toContain('@mf1')
    // The moved cap keeps its pick's UUID and the move's owner.
    const cap = faceWithToken(mesh, '@u|' + (floorUuid as string))
    expect(cap).toBeGreaterThanOrEqual(0)
    expect(mesh.face_created_by?.[cap]).toBe('mf1')
  })

  it('add_boolean of two bodies keeps the tool body\'s creator on the seam', () => {
    const r = h.run({
      features: [
        rectSketch('sk1', 20, 20),
        extrude('ex1', '$sk1', 10),
        planeOffset('pl1', '@builtin_plane_front', 10),
        rectSketch('sk2', 10, 10, '@pl1'),
        extrude('ex2', '$sk2', 10),
        { id: 'bo1', kind: 'boolean', boolean: { operation: 'union', target: '@ex1', tools: ['@ex2'] } },
      ],
    })
    expect(h.res(r, 'bo1').status).toBe('ok')
    const view = bodyOf(r)
    // The seam lines sit on the target's top plane, z=10, and carry the bump's
    // profile ancestry. The bump's walls own them; the target's own edges stay
    // the target's.
    const seam = edgesNaming(view, '@sk2/l1')
      .concat(edgesNaming(view, '@sk2/l2'))
      .filter((e) => {
        const edge = edgeAt(view, e.query)
        return (edge.start?.[2] ?? -1) === 10 && (edge.end?.[2] ?? -1) === 10
      })
    expect(new Set(seam.map((e) => e.query)).size).toBe(2)
    for (const e of seam) expect(e.creator).toBe('ex2')
    // The target's own bottom edge stays the target's.
    const blockEdge = edgesNaming(view, '@sk1/l0').find((e) => (edgeAt(view, e.query).start?.[2] ?? -1) === 0)
    expect(blockEdge?.creator).toBe('ex1')
  })

  it('a stored fillet on a breakout edge still resolves after the owner fix', () => {
    const features = [...pocketBlock(), sideHoleSketch(), sideHole()]
    const built = h.run({ features })
    expect(h.res(built, 'ho1').status).toBe('ok')
    const mesh = meshOf(built)
    const breakout = edgesBetween(mesh, faceWithToken(mesh, '@skh/p1'), faceWithToken(mesh, '@sk2/c1'))
    expect(breakout).toHaveLength(1)
    const uuid = uuidTokenOf(breakout[0])
    expect(uuid).toBeDefined()

    // The query an older document stored: same construction UUID, the pre-fix
    // `@ex2` creator token in its ancestry. The UUID is derived from the face
    // pair, not from the owner, so the stored pick still names this edge.
    const oldQuery = breakout[0].replace('@ho1', '@ex2')
    expect(oldQuery).not.toBe(breakout[0])
    expect(oldQuery).toContain('@ex2')
    expect(uuidTokenOf(oldQuery)).toBe(uuid)

    for (const edgeQuery of [oldQuery, breakout[0]]) {
      const r = h.run({
        features: [...features, { id: 'fil1', kind: 'fillet', edges: [edgeQuery], radius: 0.5 }],
      })
      const res = h.res(r, 'fil1')
      expect(res.status, `fillet on ${edgeQuery}`).toBe('ok')
      expect(res.unresolved_edges).toBeUndefined()
    }
  }, 120_000)
})
