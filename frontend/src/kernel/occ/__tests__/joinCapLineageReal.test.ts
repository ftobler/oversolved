// @vitest-environment node
//
// A joined extrude's cap keeps its own profile lineage (join-cap-lineage).
//
// An add extrude fuses its tool into the target body. The tool's cap face keeps
// its construction UUID through the fuse, but its ancestral tokens used to be
// empty: the producer named caps by their role alone, and every consumer reads
// an empty token list as "no ancestry" and falls back to the body's
// `profile_queries`. On a joined body those belong to the CREATING feature, so
// the boss's top cap claimed the plate's sketch entities -- and after a
// downstream fillet the face lost its own creator too, because attribution only
// remembered the last modifier.
//
// The fix is at the producer: a cap's tokens are the profile entities that
// bounded it, so the cap says where it came from no matter which body receives
// it. Face and edge attribution is recorded against the construction UUID, so
// it survives a later modifier the way the UUID does.
//
// Skips when opencascade.js or the Rust solver is absent.
import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../loadOcc'
import { SharedHarness } from '../sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { repoFromSnapshot, type BuildResponse } from '../../builder'
import { parseAncestry } from '../../query'

const oc = await loadOcc()
const solveBytes = loadSolver()

type Feature = Record<string, unknown>
type Spec = { features: Feature[] }
type Mesh = {
  face_data: Array<{ centroid: number[]; normal: number[]; surface_type: string; area: number }>
  face_queries: string[]
  face_uuids: (string | null)[]
  face_created_by?: string[]
}

const PLATE_TOP = 2
const BOSS_TOP = 12
const BOSS_ENTITY = 'boss'

/** A centred rectangle on a datum plane, sized in the sketch's own 2D frame. */
function rectSketch(sketchId: string, w: number, h: number, plane = '@builtin_plane_top'): Feature {
  return {
    id: sketchId, kind: 'sketch', label: 'Rectangle', plane,
    entities: [
      { id: 'bottom', kind: 'line' }, { id: 'right', kind: 'line' },
      { id: 'top', kind: 'line' }, { id: 'left', kind: 'line' },
    ],
    initial: {
      bottom: [-w / 2, -h / 2, w / 2, -h / 2], right: [w / 2, -h / 2, w / 2, h / 2],
      top: [w / 2, h / 2, -w / 2, h / 2], left: [-w / 2, h / 2, -w / 2, -h / 2],
    },
    constraints: [],
  }
}

function circleSketch(sketchId: string, eid: string, r: number, plane = '@builtin_plane_top'): Feature {
  return {
    id: sketchId, kind: 'sketch', label: 'Circle', plane,
    entities: [{ id: eid, kind: 'circle' }],
    initial: { [eid]: [0, 0, r] },
    constraints: [],
  }
}

function extrude(
  id: string, sketch: string, distance: number,
  opts: { operation?: string; direction?: string } = {},
): Feature {
  return {
    id, kind: 'extrude',
    extrude: {
      sketch: '@' + sketch, distance, direction: opts.direction ?? 'normal', operation: opts.operation ?? 'add',
    },
  }
}

/** A datum plane parallel to Top, `offset` millimetres above it (world +Y). */
function topOffsetPlane(id: string, offset: number): Feature {
  return { id, kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_top', offset } }
}

/** The 15 x 15 plate on Top, `PLATE_TOP` thick. */
const plate = (): Feature[] => [rectSketch('sk1', 15, 15), extrude('ex1', 'sk1', PLATE_TOP, { operation: 'new' })]

/** The boss alone, for the identities the joined document has to reproduce. */
const standaloneBoss = (): Spec => ({
  features: [circleSketch('sk2', BOSS_ENTITY, 4, '@builtin_plane_top'), extrude('ex2', 'sk2', 10, { operation: 'new' })],
})

/**
 * Plate + boss joined by a plain add, in the three placements a user reaches
 * for. All three put the boss's far cap at Y = BOSS_TOP; they differ only in
 * where the boss's start cap sits relative to the plate.
 */
const joins: Array<{ name: string; features: () => Feature[] }> = [
  {
    name: 'boss on a plane at the plate top',
    features: () => [
      ...plate(), topOffsetPlane('pl2', PLATE_TOP),
      circleSketch('sk2', BOSS_ENTITY, 4, '@pl2'), extrude('ex2', 'sk2', BOSS_TOP - PLATE_TOP),
    ],
  },
  {
    name: 'boss through the plate from Top',
    features: () => [
      ...plate(), circleSketch('sk2', BOSS_ENTITY, 4), extrude('ex2', 'sk2', BOSS_TOP),
    ],
  },
  {
    name: 'boss starting inside the plate',
    features: () => [
      ...plate(), topOffsetPlane('pl1', 1),
      circleSketch('sk2', BOSS_ENTITY, 4, '@pl1'), extrude('ex2', 'sk2', BOSS_TOP - 1),
    ],
  },
]

describe.skipIf(!oc || !solveBytes)('a joined extrude cap keeps its profile lineage (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  function meshOf(result: BuildResponse, bodyId: string): Mesh {
    const mesh = h.body(result, bodyId).mesh as Mesh | undefined
    if (!mesh) throw new Error(`body ${bodyId} has no mesh`)
    return mesh
  }

  // The face with the highest centroid along Y that looks up: the boss top.
  function bossTopIndex(mesh: Mesh): number {
    let best = -1
    mesh.face_data.forEach((fd, i) => {
      if (fd.surface_type !== 'flatface' || fd.normal[1] < 0.99) return
      if (best < 0 || fd.centroid[1] > mesh.face_data[best].centroid[1]) best = i
    })
    if (best < 0) throw new Error('no upward flat face in the body')
    return best
  }

  // The one downward-looking flat face: the stand-alone boss's start cap.
  function bossStartIndex(mesh: Mesh): number {
    const hits = mesh.face_data.flatMap((fd, i) =>
      fd.surface_type === 'flatface' && fd.normal[1] < -0.99 ? [i] : [])
    expect(hits, 'one downward flat face on the stand-alone boss').toHaveLength(1)
    return hits[0]
  }

  // The canonical face index whose centroid is at height `y`, looking up.
  function flatFaceIndexAt(mesh: Mesh, y: number): number {
    const hits = mesh.face_data.flatMap((fd, i) =>
      fd.surface_type === 'flatface' && Math.abs(fd.centroid[1] - y) < 1e-6 && fd.normal[1] > 0.99 ? [i] : [])
    expect(hits, `one upward face at Y=${y}`).toHaveLength(1)
    return hits[0]
  }

  function ancestryOf(query: string): string[] {
    return parseAncestry(query)[0]
  }

  // The registered B-rep element for one face of the last checkpoint.
  function registeredFace(result: BuildResponse, bodyId: string, faceIndex: number): Record<string, unknown> {
    const state = result._build_state!
    const last = state.feature_order[state.feature_order.length - 1]
    const repo = repoFromSnapshot(state.checkpoints[last].repo_snapshot as Record<string, unknown>)
    const hits = [...repo.elements.values()].filter((el) => {
      const e = el as Record<string, unknown>
      return e.body_id === bodyId && e.face_index === faceIndex
    })
    expect(hits, `face ${faceIndex} of ${bodyId} is registered exactly once`).toHaveLength(1)
    return hits[0] as Record<string, unknown>
  }

  /** The stand-alone boss's cap UUIDs, built once: the identity the joined
   *  document must reproduce (the cap is named by its role, not its body). */
  function standaloneCaps(): { start: string; end: string } {
    const mesh = meshOf(h.run(standaloneBoss()), 'body_ex2')
    const start = mesh.face_uuids[bossStartIndex(mesh)]
    const end = mesh.face_uuids[bossTopIndex(mesh)]
    if (!start || !end) throw new Error('the stand-alone boss caps are unnamed')
    return { start, end }
  }

  for (const placement of joins) {
    it(`${placement.name}: the boss top names the boss sketch, not the plate's`, () => {
      const result = h.run({ features: placement.features() })
      for (const f of placement.features()) {
        // Sketches report their constraint state; only the solid features must solve.
        if (f.kind === 'sketch') continue
        expect(h.res(result, String(f.id)).status, `feature ${String(f.id)}`).toBe('ok')
      }
      const mesh = meshOf(result, 'body_ex1')
      const top = bossTopIndex(mesh)
      expect(mesh.face_data[top].centroid[1], 'the boss top sits at Y=12').toBeCloseTo(BOSS_TOP, 6)

      const ancestry = ancestryOf(mesh.face_queries[top])
      expect(ancestry, 'the cap carries its own profile entity').toContain(`@sk2/${BOSS_ENTITY}`)
      expect(ancestry.filter((id) => id.startsWith('@sk1/')), 'no token of the plate sketch').toEqual([])
      expect(mesh.face_uuids[top], 'the cap keeps the stand-alone uuid').toBe(standaloneCaps().end)

      const element = registeredFace(result, 'body_ex1', top)
      expect(element.created_by, 'the boss feature owns its cap').toBe('ex2')
      expect(element.uuid).toBe(mesh.face_uuids[top])
    })
  }

  // A boss whose start cap is buried in the plate contributes no cap face: the
  // union has no boundary there, so the face cannot be selected or named.
  it('a boss starting inside the plate leaves no start cap', () => {
    const features = [
      ...plate(), topOffsetPlane('pl1', 1),
      circleSketch('sk2', BOSS_ENTITY, 4, '@pl1'), extrude('ex2', 'sk2', BOSS_TOP - 1),
    ]
    const mesh = meshOf(h.run({ features }), 'body_ex1')
    expect(mesh.face_uuids).not.toContain(standaloneCaps().start)
    // The buried cap's identity is not silently transferred to another face.
    const flatAtPlateTop = flatFaceIndexAt(mesh, PLATE_TOP)
    expect(mesh.face_uuids[flatAtPlateTop]).not.toBe(standaloneCaps().start)
  })

  // A boss extruded down from the plate top has its start cap coplanar with the
  // plate's top face and touching it inside the outline, so the clean folds the
  // two into one face. The documented unify rule is "target source over a tool
  // source": the merged face keeps the plate's own UUID, and the boss's start
  // cap UUID disappears with the face (cleanMergeNamingReal pins the rule).
  it('a start cap fused into the plate cap keeps the plate face name', () => {
    const plateOnly = h.run({ features: plate() })
    const plateMesh = meshOf(plateOnly, 'body_ex1')
    const plateTopUuid = plateMesh.face_uuids[flatFaceIndexAt(plateMesh, PLATE_TOP)]
    expect(plateTopUuid).toBeTruthy()

    const features = [
      ...plate(), topOffsetPlane('pl2', PLATE_TOP),
      circleSketch('sk2', BOSS_ENTITY, 4, '@pl2'), extrude('ex2', 'sk2', 5, { direction: 'reverse' }),
    ]
    const mesh = meshOf(h.run({ features }), 'body_ex1')
    expect(mesh.face_uuids).not.toContain(standaloneCaps().start)
    const merged = flatFaceIndexAt(mesh, PLATE_TOP)
    expect(mesh.face_uuids[merged], 'the target face keeps its own name').toBe(plateTopUuid)
    // The full square: the two coplanar faces really did fold into one.
    expect(mesh.face_data[merged].area).toBeCloseTo(225, 0)
  })

  it('a downstream fillet leaves the cap its identity, creator and lineage', () => {
    const base = h.run({ features: joins[0].features() })
    const baseMesh = meshOf(base, 'body_ex1')
    const top = bossTopIndex(baseMesh)
    const capUuid = baseMesh.face_uuids[top]
    expect(capUuid).toBeTruthy()

    // The junction is the circle where the boss wall meets the plate's top face,
    // picked by geometry test-side only (the kernel names it, not the test).
    const edges = h.body(base, 'body_ex1').edges as Array<{ kind: string; center?: number[] }>
    const junction = (h.body(base, 'body_ex1').edge_queries as string[]).find((_q, i) =>
      edges[i]?.kind === 'circle' && Math.abs((edges[i].center?.[1] ?? -1) - PLATE_TOP) < 1e-6)
    expect(junction, 'the boss/plate junction edge').toBeTruthy()

    const features = [...joins[0].features(), { id: 'fi1', kind: 'fillet', fillet: { edges: [junction], radius: 0.5 } }]
    const result = h.run({ features })
    expect(h.res(result, 'fi1').status).toBe('ok')
    const mesh = meshOf(result, 'body_ex1')

    const stillTop = mesh.face_uuids.indexOf(capUuid)
    expect(stillTop, 'the cap survives the fillet under its own uuid').toBeGreaterThanOrEqual(0)
    expect(mesh.face_data[stillTop].centroid[1]).toBeCloseTo(BOSS_TOP, 6)
    expect(ancestryOf(mesh.face_queries[stillTop])).toContain(`@sk2/${BOSS_ENTITY}`)
    expect(ancestryOf(mesh.face_queries[stillTop]).filter((id) => id.startsWith('@sk1/'))).toEqual([])
    expect(registeredFace(result, 'body_ex1', stillTop).created_by).toBe('ex2')

    // The wall is the boss's too, and the fillet's own blend belongs to the fillet.
    const wall = mesh.face_data.findIndex((fd) => fd.surface_type === 'cylinderface')
    expect(wall).toBeGreaterThanOrEqual(0)
    expect(mesh.face_created_by?.[wall]).toBe('ex2')
    expect(registeredFace(result, 'body_ex1', wall).created_by).toBe('ex2')
    const blend = mesh.face_data.findIndex((fd) => fd.surface_type === 'torusface')
    expect(blend, 'the fillet made a blend face').toBeGreaterThanOrEqual(0)
    expect(registeredFace(result, 'body_ex1', blend).created_by).toBe('fi1')
  })
})
