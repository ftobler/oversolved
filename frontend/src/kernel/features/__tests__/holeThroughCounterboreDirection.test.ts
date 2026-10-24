// @vitest-environment node
//
// Real-OCC tests for a through hole's widened mouth. A face sketch registers
// the face's OUTWARD normal (postRegister's resolveSketchPlane), so the default
// `direction: normal` points out of the material. The bore may run either way
// for a through hole, but the counterbore step and the countersink cone must
// widen on the material side, or the step bores the full depth at cb_diameter
// and the cone cuts air. The volumes are analytic: the bore removes
// pi r^2 t, the step adds the annulus pi (R^2 - r^2) over cb_depth, and the
// cone adds the frustum between r and R less the bore cylinder it covers.
//
// `normal` and `reverse` must agree in volume AND in the construction uuids
// the stepped faces carry, so an existing pick keeps resolving whichever way
// the user wrote the hole.
//
// Skips when OCC.js is absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { makeBoxAt } from '../../occ/primitives'
import { volumeOf } from '../../occ/booleans'
import { Repository } from '../../query'
import { solveHole } from '../hole'
import { holeFacePath, mintFaceUuid, type HoleFaceRole } from '../../constructionName'
import type { Body } from '../../types3d'
import type { OccShape } from '../../occ/occTypes'

const oc = await loadOcc()

const PLATE_X = 40
const PLATE_Y = 40
const PLATE_Z = 13
const BOX_VOLUME = PLATE_X * PLATE_Y * PLATE_Z
const BORE_R = 4
const CB_R = 7.5
const CB_DEPTH = 4

/** A plane with Front's frame at height `z`: the registration a top-face sketch
 *  gets (origin on the face, +z outward) and a Front offset plane carries. */
const FRAME_AT = (z: number) => ({
  origin: [0, 0, z], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1],
})

interface Drill {
  volume: number
  result: Record<string, unknown>
  uuids: (string | null)[]
}

/**
 * Solve one through bore in a 40 x 40 x 13 plate whose bottom sits at
 * `boxStartZ`, with the drill site at world (20, 20, planeZ).
 */
function drill(planeZ: number, boxStartZ: number, hole: Record<string, unknown>): Drill {
  const scope = new DisposeScope()
  const table = new HandleTable()
  try {
    const repo = new Repository()
    repo.register('_pt_sk', FRAME_AT(planeZ))
    repo.register('sk/p1/xy', { external_xy: [20, 20] })
    const box = makeBoxAt(oc!, scope, [0, 0, boxStartZ], PLATE_X, PLATE_Y, PLATE_Z)
    const bodyStore: Record<string, Body> = {
      body_t: {
        id: 'body_t', created_by: 'ex', modified_by: [],
        shape: table.register(box, 'ex'), sketch_id: 'sk',
        brep_diff: null, profile_queries: [],
      },
    }
    const result = solveHole(
      oc!, scope, table,
      { id: 'h1', hole: { sketch: '@sk', target: 'body_t', ...hole } },
      repo, bodyStore, { sk: { entities: [{ id: 'p1', kind: 'point' }] } },
    )
    return {
      result,
      volume: volumeOf(oc!, scope, table.get<OccShape>(bodyStore.body_t.shape!)),
      uuids: bodyStore.body_t.face_uuids ?? [],
    }
  } finally {
    scope.dispose()
  }
}

/** Volume removed by a through counterbored bore at the mouth. */
function counterboreRemoved(r: number, thickness: number, R: number, step: number): number {
  return Math.PI * r * r * thickness + Math.PI * (R * R - r * r) * step
}

/** Extra volume a countersink cone removes over the plain bore. */
function countersinkExtra(r: number, R: number, angleDeg: number): number {
  const h = (R - r) / Math.tan((angleDeg * Math.PI) / 360)
  return (Math.PI * h / 3) * (R * R + R * r + r * r) - Math.PI * r * r * h
}

const COUNTERBORE = {
  diameter: 2 * BORE_R, depth_mode: 'through_all', style: 'counterbore',
  cb_diameter: 2 * CB_R, cb_depth: CB_DEPTH,
}

describe.skipIf(!oc)('a through counterbore widens on the material side (real OCC)', () => {
  for (const direction of ['normal', 'reverse'] as const) {
    it(`a top-face sketch drills the step into the plate with direction: ${direction}`, () => {
      const { volume, result } = drill(PLATE_Z, 0, { ...COUNTERBORE, direction })
      expect(result.status).toBe('ok')
      expect(result.hole_count).toBe(1)
      // The mouth is on the top face and the plane normal points out of the
      // plate, so `normal` must still put the step 4 mm below z=13.
      expect(volume).toBeCloseTo(BOX_VOLUME - counterboreRemoved(BORE_R, PLATE_Z, CB_R, CB_DEPTH), 6)
    })

    it(`a Front offset plane at z=13 drills the step into the plate with direction: ${direction}`, () => {
      const { volume, result } = drill(PLATE_Z, 0, { ...COUNTERBORE, direction })
      expect(result.status).toBe('ok')
      expect(volume).toBeCloseTo(BOX_VOLUME - counterboreRemoved(BORE_R, PLATE_Z, CB_R, CB_DEPTH), 6)
    })

    it(`a Front-plane mouth at z=0 keeps cutting with direction: ${direction}`, () => {
      // The already-correct case: the plane normal points into the plate, so
      // the entry side is the authored axis.
      const { volume, result } = drill(0, 0, { ...COUNTERBORE, direction })
      expect(result.status).toBe('ok')
      expect(volume).toBeCloseTo(BOX_VOLUME - counterboreRemoved(BORE_R, PLATE_Z, CB_R, CB_DEPTH), 6)
    })
  }

  it('opens an entry face below a plane that sits above it', () => {
    // The mouth is 1 mm above the top face: the step reaches back through the
    // air to z=13 so the entry is still opened at cb_diameter, and the bore
    // still clears the far face instead of stopping 1 mm short.
    for (const direction of ['normal', 'reverse'] as const) {
      const { volume, result } = drill(PLATE_Z + 1, 0, { ...COUNTERBORE, direction })
      expect(result.status).toBe('ok')
      expect(volume).toBeCloseTo(BOX_VOLUME - counterboreRemoved(BORE_R, PLATE_Z, CB_R, CB_DEPTH), 6)
    }
  })

  it('gives both directions the same bore, step wall and step floor uuids', () => {
    const uuid = (role: HoleFaceRole) => mintFaceUuid(holeFacePath('h1', 'sk/p1', role))
    const normal = drill(PLATE_Z, 0, { ...COUNTERBORE, direction: 'normal' })
    const reverse = drill(PLATE_Z, 0, { ...COUNTERBORE, direction: 'reverse' })
    for (const role of ['bore', 'step_wall', 'step_floor'] as const) {
      expect(normal.uuids).toContain(uuid(role))
      expect(reverse.uuids).toContain(uuid(role))
    }
    expect(new Set(normal.uuids)).toEqual(new Set(reverse.uuids))
  })
})

describe.skipIf(!oc)('a through countersink widens on the material side (real OCC)', () => {
  const BORE_SINK_R = 2.75
  const MOUTH_R = 5.6
  const ANGLE = 90
  const COUNTERSINK = {
    diameter: 2 * BORE_SINK_R, depth_mode: 'through_all', style: 'countersink',
    cb_diameter: 2 * MOUTH_R, cs_angle: ANGLE,
  }

  for (const direction of ['normal', 'reverse'] as const) {
    it(`a top-face sketch cuts the cone with direction: ${direction}`, () => {
      const { volume, result } = drill(PLATE_Z, 0, { ...COUNTERSINK, direction })
      expect(result.status).toBe('ok')
      expect(result.hole_count).toBe(1)
      const expected = BOX_VOLUME - (Math.PI * BORE_SINK_R ** 2 * PLATE_Z + countersinkExtra(BORE_SINK_R, MOUTH_R, ANGLE))
      expect(volume).toBeCloseTo(expected, 6)
    })
  }

  it('removes more than a plain bore in both directions', () => {
    const plain = Math.PI * BORE_SINK_R ** 2 * PLATE_Z
    for (const direction of ['normal', 'reverse'] as const) {
      const { volume } = drill(PLATE_Z, 0, { ...COUNTERSINK, direction })
      expect(BOX_VOLUME - volume).toBeGreaterThan(plain)
    }
  })
})
