// @vitest-environment node
//
// Real-OCC tests for the blind hole that drills out of the body. A face sketch
// registers the face's OUTWARD normal, so the default `direction: normal` runs
// the cutter into the air and every site misses. The body is unchanged, so the
// solve stays `ok` as before; the warning now names the one-field fix instead
// of only saying that nothing was removed. A hole that misses BOTH ways is a
// placement problem, not a direction one, and keeps the old text.
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
import type { Body } from '../../types3d'
import type { OccShape } from '../../occ/occTypes'

const oc = await loadOcc()

const BOX = 40 * 40 * 13

/** The registration a top-face sketch gets: the face frame, its outward +z. */
const TOP_FACE_PLANE = {
  origin: [0, 0, 13], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1],
}

function drill(
  hole: Record<string, unknown>,
  xy: [number, number] = [20, 20],
): { result: Record<string, unknown>; volume: number } {
  const scope = new DisposeScope()
  const table = new HandleTable()
  try {
    const repo = new Repository()
    repo.register('_pt_sk', TOP_FACE_PLANE)
    repo.register('sk/p1/xy', { external_xy: xy })
    const box = makeBoxAt(oc!, scope, [0, 0, 0], 40, 40, 13)
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
    return { result, volume: volumeOf(oc!, scope, table.get<OccShape>(bodyStore.body_t.shape!)) }
  } finally {
    scope.dispose()
  }
}

const BLIND = { diameter: 4, depth: 5 }

describe.skipIf(!oc)('an outward blind hole warns with the fix (real OCC)', () => {
  it('names direction: reverse when the authored normal drills out of the body', () => {
    const { result, volume } = drill({ ...BLIND, direction: 'normal' })
    expect(result.status).toBe('ok')
    expect(result.hole_count).toBe(0)
    expect(volume).toBeCloseTo(BOX, 6)
    expect(String(result.solver_warning)).toMatch(/direction: reverse/)
  })

  it('cuts with no warning once the direction is reversed', () => {
    const { result, volume } = drill({ ...BLIND, direction: 'reverse' })
    expect(result.status).toBe('ok')
    expect(result.hole_count).toBe(1)
    expect(result.solver_warning).toBeUndefined()
    expect(volume).toBeCloseTo(BOX - Math.PI * 4 * 5, 6)
  })

  it('keeps the miss text when the site misses in both directions', () => {
    // Off the plate in x and y: no direction can reach it, so pointing at
    // `reverse` would be wrong advice.
    const { result, volume } = drill({ ...BLIND, direction: 'normal' }, [100, 100])
    expect(result.status).toBe('ok')
    expect(volume).toBeCloseTo(BOX, 6)
    expect(String(result.solver_warning)).toMatch(/none of the 1 drill site\(s\) intersect body 'body_t'; nothing was removed/)
    expect(String(result.solver_warning)).not.toMatch(/direction: reverse/)
  })
})
