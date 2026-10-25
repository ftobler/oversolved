// @vitest-environment node
//
// Real-OCC tests for a through hole whose sketch plane has material on BOTH
// sides at some sites: a 10 mm plate (z -5..5) with a block on its +y half
// (z 5..15), drilled from a plane on the plate's top face at one site under
// the block and one clear of it. This is the 3D_Printer_Extruder_Support
// practice run: the side probe could not decide the site under the block, so
// that site took a symmetric bore up through the block (F1) and widened its
// mouth toward the authored normal, into the block (F2), while its neighbour
// widened into the plate.
//
// A through hole drills one way from its plane, and the way is resolved once
// for the whole feature: the sites that decide vote, the rest follow, and a
// site with material on the losing side is named in a warning. `reverse` is
// an authored side and is obeyed without probing.
//
// Skips when OCC.js is absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { makeBoxAt, faceSurfaceType } from '../../occ/primitives'
import { booleanWithDiff, volumeOf } from '../../occ/booleans'
import { bodyFrame } from '../../occ/tessellation'
import { Repository } from '../../query'
import { solveHole } from '../hole'
import type { Body } from '../../types3d'
import type { OccShape } from '../../occ/occTypes'

const oc = await loadOcc()

const PLATE = 40 * 40 * 10
const BLOCK = 40 * 20 * 10
const BORE_R = 1.25
const CB_R = 2.5
const CB_DEPTH = 2.5

const UP = { origin: [0, 0, 5], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }
// The same plane with its normal flipped, so `reverse` points up into the block.
const DOWN = { origin: [0, 0, 5], x_axis: [1, 0, 0], y_axis: [0, -1, 0], normal: [0, 0, -1] }

// Sketch xy for the two sites: under the block at world y=10, clear at y=-10.
const SITES = (plane: typeof UP) => (plane === UP
  ? { under: [0, 10], clear: [0, -10] }
  : { under: [0, -10], clear: [0, 10] })

interface CylinderFace { radius: number; zMin: number; zMax: number }

interface Drill {
  result: Record<string, unknown>
  volume: number
  cylinders: CylinderFace[]
}

function drill(hole: Record<string, unknown>, plane: typeof UP = UP): Drill {
  const scope = new DisposeScope()
  const table = new HandleTable()
  try {
    const repo = new Repository()
    const sites = SITES(plane)
    repo.register('_pt_sk', plane)
    repo.register('sk/p_under/xy', { external_xy: sites.under })
    repo.register('sk/p_clear/xy', { external_xy: sites.clear })
    const plate = makeBoxAt(oc!, scope, [-20, -20, -5], 40, 40, 10)
    const block = makeBoxAt(oc!, scope, [-20, 0, 5], 40, 20, 10)
    const body = scope.track(booleanWithDiff(oc!, scope, plate, block, 'fuse').shape)
    const bodyStore: Record<string, Body> = {
      body_t: {
        id: 'body_t', created_by: 'ex', modified_by: [],
        shape: table.register(body, 'ex'), sketch_id: 'sk',
        brep_diff: null, profile_queries: [],
      },
    }
    const result = solveHole(
      oc!, scope, table,
      { id: 'h1', hole: { sketch: '@sk', target: 'body_t', diameter: 2 * BORE_R, depth_mode: 'through_all', ...hole } },
      repo, bodyStore,
      { sk: { entities: [{ id: 'p_under', kind: 'point' }, { id: 'p_clear', kind: 'point' }] } },
    )
    const shape = table.get<OccShape>(bodyStore.body_t.shape!)
    return { result, volume: volumeOf(oc!, scope, shape), cylinders: cylinderFaces(shape, scope) }
  } finally {
    scope.dispose()
  }
}

/** Every cylindrical face of `shape`, by radius and z extent. */
function cylinderFaces(shape: OccShape, scope: DisposeScope): CylinderFace[] {
  const E = oc!.TopAbs_ShapeEnum
  const out: CylinderFace[] = []
  const exp = scope.track(new oc!.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) {
    const face = scope.track(oc!.TopoDS.Face_1(scope.track(exp.Current())))
    if (faceSurfaceType(oc!, scope, face) !== 'cylinderface') continue
    const adaptor = scope.track(new oc!.BRepAdaptor_Surface_2(face, true))
    const radius = scope.track(adaptor.Cylinder()).Radius()
    const { center, half } = bodyFrame(oc!, scope, face)
    out.push({ radius, zMin: center[2] - half[2], zMax: center[2] + half[2] })
  }
  return out
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6
const BORE_THROUGH_PLATE = Math.PI * BORE_R ** 2 * 10
const STEP = Math.PI * (CB_R ** 2 - BORE_R ** 2) * CB_DEPTH
const COUNTERBORE = { style: 'counterbore', cb_diameter: 2 * CB_R, cb_depth: CB_DEPTH }

describe.skipIf(!oc)('a through hole with material on both sides of its plane (real OCC)', () => {
  for (const style of ['simple', 'counterbore'] as const) {
    it(`a ${style} bore stays out of the block above the plate`, () => {
      const { volume, cylinders } = drill({ direction: 'normal', ...(style === 'counterbore' ? COUNTERBORE : {}) })
      const bores = cylinders.filter(c => near(c.radius, BORE_R))
      expect(bores.length).toBeGreaterThan(0)
      for (const bore of bores) expect(bore.zMax).toBeLessThanOrEqual(5 + 1e-6)
      const removed = 2 * (BORE_THROUGH_PLATE + (style === 'counterbore' ? STEP : 0))
      expect(volume).toBeCloseTo(PLATE + BLOCK - removed, 6)
    })
  }

  it('opens both counterbores into the plate with the default direction', () => {
    const { cylinders, result } = drill({ direction: 'normal', ...COUNTERBORE })
    const steps = cylinders.filter(c => near(c.radius, CB_R))
    expect(steps).toHaveLength(2)
    for (const step of steps) {
      expect(step.zMin).toBeCloseTo(5 - CB_DEPTH, 6)
      expect(step.zMax).toBeCloseTo(5, 6)
    }
    expect(result.status).toBe('ok')
    expect(result.hole_count).toBe(2)
    expect(result.direction).toBe('reverse')
  })

  it('names the site under the block in the warning, not the clear one', () => {
    const { result } = drill({ direction: 'normal', ...COUNTERBORE })
    const warning = String(result.solver_warning ?? '')
    expect(warning).toContain('p_under')
    expect(warning).not.toContain('p_clear')
    expect(warning).toContain('drilled reverse at all sites')
  })

  it('obeys direction: reverse at every site without a warning', () => {
    const { result, cylinders } = drill({ direction: 'reverse', ...COUNTERBORE })
    expect(result.status).toBe('ok')
    expect(result.direction).toBe('reverse')
    expect(result.solver_warning).toBeUndefined()
    for (const step of cylinders.filter(c => near(c.radius, CB_R))) expect(step.zMax).toBeCloseTo(5, 6)
  })

  it('drills up through the block only when reverse points up', () => {
    // The flipped plane: reverse is +z, so the site under the block bores the
    // block and nothing below the plane, and the clear site drills air.
    const { result, volume, cylinders } = drill({ direction: 'reverse' }, DOWN)
    expect(result.direction).toBe('reverse')
    expect(result.hole_count).toBe(1)
    expect(result.status).toBe('partial')
    expect(String(result.exception)).toContain('p_clear')
    for (const bore of cylinders.filter(c => near(c.radius, BORE_R))) {
      expect(bore.zMin).toBeGreaterThanOrEqual(5 - 1e-6)
    }
    expect(volume).toBeCloseTo(PLATE + BLOCK - BORE_THROUGH_PLATE, 6)
  })
})
