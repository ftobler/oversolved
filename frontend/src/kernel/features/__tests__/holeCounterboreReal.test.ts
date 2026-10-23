// @vitest-environment node
//
// Real-OCC tests for the hole's widened mouth styles. The volume checks are
// analytic: the bore removes pi r^2 h, a counterbore adds the annulus
// pi (R^2 - r^2) d over its step depth, and a countersink adds the frustum
// between the bore and the mouth radius less the bore cylinder that the
// frustum already covers. Point and circle sites are both exercised because a
// circle overrides the feature diameter. The full-document case proves the
// new cutter faces keep resolving through an upstream dimension edit.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { makeBox } from '../../occ/primitives'
import { volumeOf } from '../../occ/booleans'
import { Repository } from '../../query'
import { solveHole } from '../hole'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { SharedHarness } from '../../occ/sharedHarness'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { holeFacePath, mintFaceUuid } from '../../constructionName'
import type { Body } from '../../types3d'
import type { OccModule, OccShape } from '../../occ/occTypes'

const oc = await loadOcc()
const solveBytes = loadSolver()

const PLANE = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }
const BOX = 20 * 20 * 10

/** A 20 x 20 x 10 box with its top face on the Front plane (z = 0). */
function boxTarget(occ: OccModule, scope: DisposeScope, table: HandleTable): Record<string, Body> {
  const box = makeBox(occ, scope, 20, 20, 10)
  return {
    body_t: {
      id: 'body_t', created_by: 'ex_t', modified_by: [],
      shape: table.register(box, 'ex_t'),
      sketch_id: 'sk_t', brep_diff: null,
      profile_queries: [],
    },
  }
}

/** Volume removed by a counterbored bore: pi r^2 h plus the wider step annulus. */
function counterboreRemoved(r: number, depth: number, R: number, step: number): number {
  return Math.PI * r * r * depth + Math.PI * (R * R - r * r) * step
}

/** Extra volume a countersink cone removes over the plain bore: the frustum
 *  between r and R at the cone's depth, less the bore cylinder inside it. */
function countersinkExtra(r: number, R: number, angleDeg: number): number {
  const h = (R - r) / Math.tan((angleDeg * Math.PI) / 360)
  return (Math.PI * h / 3) * (R * R + R * r + r * r) - Math.PI * r * r * h
}

function runHole(
  hole: Record<string, unknown>,
  repoSetup: (repo: Repository) => void,
  entities: Array<{ id: string; kind: string }>,
): { volume: number; result: Record<string, unknown>; body: Body } {
  const scope = new DisposeScope()
  const table = new HandleTable()
  try {
    const repo = new Repository()
    repo.register('_pt_sk', PLANE)
    repoSetup(repo)
    const bodyStore = boxTarget(oc!, scope, table)
    const result = solveHole(oc!, scope, table, {
      id: 'h1',
      hole: { sketch: '@sk', target: 'body_t', ...hole },
    }, repo, bodyStore, { sk: { entities } })
    return {
      result,
      body: bodyStore.body_t,
      volume: volumeOf(oc!, scope, table.get<OccShape>(bodyStore.body_t.shape!)),
    }
  } finally {
    scope.dispose()
  }
}

const pointSite = (repo: Repository) => repo.register('sk/p1/xy', { external_xy: [10, 10] })
const circleSite = (repo: Repository) =>
  repo.register('sk/c1', { external_params: [10, 10, 2], kind: 'circle', sketch_id: 'sk' })
const pointEntity = [{ id: 'p1', kind: 'point' }]
const circleEntity = [{ id: 'c1', kind: 'circle' }]

describe.skipIf(!oc)('hole counterbore and countersink (real OCC)', () => {
  it('a blind counterbore removes the bore plus the step annulus', () => {
    const { volume, result } = runHole({
      diameter: 4, depth: 8, style: 'counterbore', cb_diameter: 8, cb_depth: 3,
    }, pointSite, pointEntity)
    expect(result.status).toBe('ok')
    expect(result.hole_count).toBe(1)
    expect(volume).toBeCloseTo(BOX - counterboreRemoved(2, 8, 4, 3), 4)
  })

  it('a through counterbore keeps its step at the mouth', () => {
    const { volume, result } = runHole({
      diameter: 4, depth_mode: 'through_all', style: 'counterbore', cb_diameter: 8, cb_depth: 3,
    }, pointSite, pointEntity)
    expect(result.status).toBe('ok')
    expect(volume).toBeCloseTo(BOX - counterboreRemoved(2, 10, 4, 3), 4)
  })

  it('a circle site drills its own diameter through the counterbore', () => {
    // The circle's radius 2 wins over the feature diameter 10, so the bore and
    // the step keep the same analytic volume as the point case.
    const { volume, result } = runHole({
      diameter: 10, depth: 8, style: 'counterbore', cb_diameter: 8, cb_depth: 3,
    }, circleSite, circleEntity)
    expect(result.status).toBe('ok')
    expect(volume).toBeCloseTo(BOX - counterboreRemoved(2, 8, 4, 3), 4)
  })

  it('a 90 degree countersink adds the cone between the bore and the mouth', () => {
    const { volume, result } = runHole({
      diameter: 4, depth: 8, style: 'countersink', cb_diameter: 8, cs_angle: 90,
    }, pointSite, pointEntity)
    expect(result.status).toBe('ok')
    expect(volume).toBeCloseTo(BOX - (Math.PI * 4 * 8 + countersinkExtra(2, 4, 90)), 4)
  })

  it('an 82 degree countersink is deeper for the same mouth diameter', () => {
    // A smaller included angle makes the cone steeper: for the same radii it
    // reaches the bore further down, so it removes more; the assertion pins the
    // angle's tan, not just "a cone was cut".
    const narrow = countersinkExtra(2, 4, 82)
    expect(narrow).toBeGreaterThan(countersinkExtra(2, 4, 90))
    const { volume, result } = runHole({
      diameter: 4, depth: 8, style: 'countersink', cb_diameter: 8, cs_angle: 82,
    }, pointSite, pointEntity)
    expect(result.status).toBe('ok')
    expect(volume).toBeCloseTo(BOX - (Math.PI * 4 * 8 + narrow), 4)
  })

  it('a through countersink cuts the cone and the full bore', () => {
    const { volume, result } = runHole({
      diameter: 4, depth_mode: 'through_all', style: 'countersink', cb_diameter: 8,
    }, pointSite, pointEntity)
    expect(result.status).toBe('ok')
    expect(volume).toBeCloseTo(BOX - (Math.PI * 4 * 10 + countersinkExtra(2, 4, 90)), 4)
  })

  it('names the counterbore step wall and floor from the drill site', () => {
    const { body } = runHole({
      diameter: 4, depth: 8, style: 'counterbore', cb_diameter: 8, cb_depth: 3,
    }, pointSite, pointEntity)
    const uuids = body.face_uuids ?? []
    const uuid = (role: string) => mintFaceUuid(holeFacePath('h1', 'sk/p1', role as never))
    expect(uuids).toContain(uuid('bore'))
    expect(uuids).toContain(uuid('step_wall'))
    expect(uuids).toContain(uuid('step_floor'))
    expect(uuids).toContain(uuid('floor'))
  })

  it('names the countersink cone from the drill site', () => {
    const { body } = runHole({
      diameter: 4, depth: 8, style: 'countersink', cb_diameter: 8,
    }, pointSite, pointEntity)
    const uuids = body.face_uuids ?? []
    const uuid = (role: string) => mintFaceUuid(holeFacePath('h1', 'sk/p1', role as never))
    expect(uuids).toContain(uuid('sink'))
    expect(uuids).toContain(uuid('bore'))
  })

  it('keeps the cosmetic thread on the bore below the widened mouth', () => {
    const { result } = runHole({
      diameter: 4, depth: 8, style: 'counterbore', cb_diameter: 8, cb_depth: 3,
      thread: { designation: 'M4x0.7', nominal: 4, pitch: 0.7 },
    }, pointSite, pointEntity)
    const thread = result.thread as { helices: Array<{ radius: number; turns: number; center: number[] }> }
    expect(thread.helices).toHaveLength(1)
    expect(thread.helices[0].radius).toBeCloseTo(2)
    // The bore is 8 deep and the step takes the first 3, so the thread starts
    // at z=3 and covers 5 of the 8, not the counterbore wall.
    expect(thread.helices[0].center[2]).toBeCloseTo(3)
    expect(thread.helices[0].turns).toBeCloseTo(5 / 0.7)
  })

  it('refuses a mouth no wider than the bore', () => {
    expect(() => runHole({
      diameter: 8, depth: 8, style: 'counterbore', cb_diameter: 8, cb_depth: 3,
    }, pointSite, pointEntity)).toThrow(/larger than the bore/)
  })

  it('refuses a counterbore as deep as a blind hole', () => {
    expect(() => runHole({
      diameter: 4, depth: 3, style: 'counterbore', cb_diameter: 8, cb_depth: 3,
    }, pointSite, pointEntity)).toThrow(/less than the blind hole depth/)
  })

  it('refuses a countersink angle outside (0, 180)', () => {
    expect(() => runHole({
      diameter: 4, depth: 8, style: 'countersink', cb_diameter: 8, cs_angle: 180,
    }, pointSite, pointEntity)).toThrow(/between 0 and 180/)
  })
})

describe.skipIf(!oc || !solveBytes)('hole widened-mouth naming survives an upstream edit', () => {
  const h = new SharedHarness(oc!)
  beforeAll(() => {
    if (!solveBytes) return
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  const plate = (distance: number) => ({
    features: [
      {
        id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [{ id: 'bottom', kind: 'line' }, { id: 'right', kind: 'line' },
          { id: 'top', kind: 'line' }, { id: 'left', kind: 'line' }],
        initial: { bottom: [0, 0, 20, 0], right: [20, 0, 20, 20], top: [20, 20, 0, 20], left: [0, 20, 0, 0] },
        constraints: [
          { id: 'c1', kind: 'coincident', a: { entity: 'bottom', point: 'end' }, b: { entity: 'right', point: 'start' } },
          { id: 'c2', kind: 'coincident', a: { entity: 'right', point: 'end' }, b: { entity: 'top', point: 'start' } },
          { id: 'c3', kind: 'coincident', a: { entity: 'top', point: 'end' }, b: { entity: 'left', point: 'start' } },
          { id: 'c4', kind: 'coincident', a: { entity: 'left', point: 'end' }, b: { entity: 'bottom', point: 'start' } },
          { id: 'c5', kind: 'horizontal', target: { entity: 'bottom' } },
          { id: 'c6', kind: 'horizontal', target: { entity: 'top' } },
          { id: 'c7', kind: 'vertical', target: { entity: 'right' } },
          { id: 'c8', kind: 'vertical', target: { entity: 'left' } },
          { id: 'c9', kind: 'length', target: { entity: 'bottom' }, value: 20 },
          { id: 'c10', kind: 'length', target: { entity: 'left' }, value: 20 },
        ],
      },
      { id: 'ex1', kind: 'extrude', sketch: '@sk1', distance, direction: 'normal', operation: 'new' },
      {
        id: 'skh', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [{ id: 'p1', kind: 'point' }], initial: { p1: [10, 10] }, constraints: [],
      },
      {
        id: 'h1', kind: 'hole',
        hole: {
          sketch: '@skh', diameter: 4, depth: 8, target: 'body_ex1',
          style: 'counterbore', cb_diameter: 8, cb_depth: 3,
        },
      },
    ],
  })

  // The query of the face whose construction uuid is the hole role's.
  function faceQueryForRole(r: ReturnType<SharedHarness['run']>, bodyId: string, role: string): string {
    const mesh = h.body(r, bodyId).mesh as { face_queries?: string[]; face_uuids?: (string | null)[] } | undefined
    const wanted = mintFaceUuid(holeFacePath('h1', 'skh/p1', role as never))
    const at = (mesh?.face_uuids ?? []).indexOf(wanted)
    if (at < 0) throw new Error(`no face named ${role}`)
    const query = mesh?.face_queries?.[at]
    if (query === undefined) throw new Error(`no query for ${role}`)
    return query
  }

  it('a step-floor pick still resolves after the plate gets thicker', () => {
    const first = h.run(plate(10))
    expect(h.res(first, 'h1').status).toBe('ok')
    // Moving the step floor is a real feature that consumes the pick; if the
    // query stops resolving the feature fails, so the solve status is the
    // naming assertion.
    const stepFloor = faceQueryForRole(first, 'body_ex1', 'step_floor')
    const withPick = (distance: number) => ({
      features: [
        ...plate(distance).features,
        { id: 'mf1', kind: 'move_face', move_face: { faces: [stepFloor], distance: 0.2 } },
      ],
    })
    const before = h.run(withPick(10))
    expect(h.res(before, 'mf1').status).toBe('ok')

    // Only the plate height changes; the hole and the move-face pick are
    // downstream and must re-find the same step floor by construction uuid.
    const after = h.run(withPick(12), { prevState: before._build_state })
    expect(h.res(after, 'h1').status).toBe('ok')
    expect(h.res(after, 'mf1').status).toBe('ok')
    expect(h.res(after, 'mf1').exception).toBeUndefined()
  }, 60_000)
})
