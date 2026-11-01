// @vitest-environment node
//
// Real-OCC tests for a through hole's widened mouth. A face sketch registers
// the face's OUTWARD normal (postRegister's resolveSketchPlane), so the default
// `direction: normal` points out of the material. Under `normal` a through hole
// probes for the material side and drills there, so the counterbore step and
// the countersink cone widen on the material side instead of boring the full
// depth at cb_diameter or cutting air. `reverse` is the author's side and is
// obeyed as written. The volumes are analytic: the bore removes pi r^2 t, the
// step adds the annulus pi (R^2 - r^2) over cb_depth, and the cone adds the
// frustum between r and R less the bore cylinder it covers.
//
// On a top-face sketch `normal` and `reverse` reach the same side, and must
// agree in volume AND in the construction uuids the stepped faces carry, so an
// existing pick keeps resolving whichever way the user wrote the hole.
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

  }

  it('a Front-plane mouth at z=0 keeps cutting with direction: normal', () => {
    // The already-correct case: the plane normal points into the plate, so
    // the entry side is the authored axis.
    const { volume, result } = drill(0, 0, { ...COUNTERBORE, direction: 'normal' })
    expect(result.status).toBe('ok')
    expect(result.direction).toBe('normal')
    expect(volume).toBeCloseTo(BOX_VOLUME - counterboreRemoved(BORE_R, PLATE_Z, CB_R, CB_DEPTH), 6)
  })

  it('obeys direction: reverse out of a Front-plane mouth at z=0 and names the fix', () => {
    // reverse is an authored side: it drills -z into the air below the plate
    // rather than being probed back into it, and the warning names normal.
    const { volume, result } = drill(0, 0, { ...COUNTERBORE, direction: 'reverse' })
    expect(result.status).toBe('ok')
    expect(result.hole_count).toBe(0)
    expect(result.direction).toBe('reverse')
    expect(String(result.solver_warning)).toContain('direction: normal drills into it')
    expect(volume).toBeCloseTo(BOX_VOLUME, 6)
  })

  it('opens an entry face below a plane that sits above it', () => {
    // The mouth sits above the top face: the step reaches back through the air
    // to z=13 so the entry is still opened at cb_diameter, and the bore still
    // clears the far face. The 7 mm case is further above the face than
    // cb_depth, so the side probe has to reach past the gap to decide at all.
    for (const gap of [1, 7]) {
      for (const direction of ['normal', 'reverse'] as const) {
        const { volume, result } = drill(PLATE_Z + gap, 0, { ...COUNTERBORE, direction })
        expect(result.status, `gap ${gap} ${direction}`).toBe('ok')
        expect(volume).toBeCloseTo(BOX_VOLUME - counterboreRemoved(BORE_R, PLATE_Z, CB_R, CB_DEPTH), 6)
      }
    }
  })

  it('keeps the cosmetic thread on the bore below a raised mouth', () => {
    const { result } = drill(PLATE_Z + 1, 0, {
      ...COUNTERBORE, direction: 'normal', thread: { designation: 'M4x0.7', nominal: 4, pitch: 0.7 },
    })
    const thread = result.thread as { helices: Array<{ center: number[] }> }
    // The step is 4 mm into the plate, so the thread starts at z=9: measuring
    // from the raised sketch plane would start it 1 mm higher, inside the step.
    expect(thread.helices[0].center[2]).toBeCloseTo(PLATE_Z - CB_DEPTH)
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

  it('opens the cone at the face below a plane that sits above it', () => {
    // The cone is measured from the entry face, so lifting the plane 1 mm keeps
    // the same material cone; the extension into the air widens r1 to match.
    const expected = BOX_VOLUME - (Math.PI * BORE_SINK_R ** 2 * PLATE_Z + countersinkExtra(BORE_SINK_R, MOUTH_R, ANGLE))
    for (const direction of ['normal', 'reverse'] as const) {
      const { volume, result } = drill(PLATE_Z + 1, 0, { ...COUNTERSINK, direction })
      expect(result.status).toBe('ok')
      expect(volume).toBeCloseTo(expected, 6)
    }
  })
})
