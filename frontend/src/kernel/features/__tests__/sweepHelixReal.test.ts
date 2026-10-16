// @vitest-environment node
//
// Gated real-OCC sweep-along-helix tests. The Pappus oracle: a 1x1 radial
// square swept along a helix of radius 10, pitch 3, 4 turns has volume
// A * 2*pi*rbar * turns = 1 * 2*pi*10*4 = 80*pi (exact for a profile in a
// radial plane under a screw motion). The direct volume test drives
// sweepProfileWithLineage without lineage naming (createdBy ''), so it isolates
// the trihedron question the plan's phase 1 raised: binormal mode keeps the
// radial profile radial. A further test drives solveSweep end to end against a
// hand-seeded repo (profile topology + a registered helix descriptor), so it
// runs without the Rust sketch solver; a harness-based version with real
// sketches is left to the gate where that solver is built.
//
// Skips when opencascade.js is absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { Repository } from '../../query'
import { solveSweep } from '../sweep'
import { sweepProfileWithLineage } from '../../occ/prismLineage'
import { buildCurveEdge } from '../../occ/helixEdge'
import { descriptorFromRepo } from '../helix'
import { extractProfileLoops } from '../shared/profileLoops'
import { volumeOf } from '../../occ/volume'
import type { OccShape } from '../../occ/occTypes'
import type { Body } from '../../types3d'
import type { PlaneLike } from '../shared/planes'

const oc = await loadOcc()
const PAPPUS = 80 * Math.PI

function profileBoundary() {
  return [{
    boundary: [
      { kind: 'line', id: 'l1', start: [-0.5, -0.5], end: [0.5, -0.5] },
      { kind: 'line', id: 'l2', start: [0.5, -0.5], end: [0.5, 0.5] },
      { kind: 'line', id: 'l3', start: [0.5, 0.5], end: [-0.5, 0.5] },
      { kind: 'line', id: 'l4', start: [-0.5, 0.5], end: [-0.5, -0.5] },
    ],
  }]
}

// The profile plane: through (10,0,0), x=+X, y=+Z, normal +Y (a radial plane).
const PROFILE_PLANE: PlaneLike = { origin: [10, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 0, 1], normal: [0, 1, 0] }

// The helix descriptor buildCurveEdge consumes, laid to start at (10,0,0) on
// the +X radius (start_angle -90 with x0=+Y and y0=z x x0=-X).
function helixDescriptor(hand: 'right' | 'left' = 'right') {
  return {
    kind: 'helix', origin: [0, 0, 0], axis: [0, 0, 1], ref_axis: [0, 0, 1], x_axis: [0, 1, 0],
    radius: 10, pitch: 3, turns: 4, start_angle: -90, hand,
  }
}

function seedRepo(): Repository {
  const repo = new Repository()
  repo.register('_pt_skP', PROFILE_PLANE)
  repo.register('_topo_skP', { surfaces: profileBoundary() })
  repo.register('_curve_hx1', helixDescriptor())
  return repo
}

describe.skipIf(!oc)('sweep along a helix (real OCC)', () => {
  it('binormal mode sweeps a radial square to the Pappus volume 80*pi', () => {
    const scope = new DisposeScope()
    try {
      const repo = seedRepo()
      const plane = repo.elements.get('_pt_skP') as PlaneLike
      const loops = extractProfileLoops(profileBoundary())
      const desc = descriptorFromRepo(repo, 'hx1')!
      const spine = scope.track(buildCurveEdge(oc!, scope, desc))
      const { solid } = sweepProfileWithLineage(oc!, scope, loops, plane, [spine], '', '', desc.axis)
      const volume = volumeOf(oc!, scope, solid)
      expect(Math.abs(volume - PAPPUS)).toBeLessThan(PAPPUS * 5e-3)
    } finally {
      scope.dispose()
    }
  })

  it('a left-hand helix sweeps the same Pappus volume', () => {
    const scope = new DisposeScope()
    try {
      const repo = new Repository()
      repo.register('_pt_skP', PROFILE_PLANE)
      repo.register('_curve_hx1', helixDescriptor('left'))
      const plane = repo.elements.get('_pt_skP') as PlaneLike
      const loops = extractProfileLoops(profileBoundary())
      const desc = descriptorFromRepo(repo, 'hx1')!
      const spine = scope.track(buildCurveEdge(oc!, scope, desc))
      const { solid } = sweepProfileWithLineage(oc!, scope, loops, plane, [spine], '', '', desc.axis)
      const volume = volumeOf(oc!, scope, solid)
      expect(Math.abs(volume - PAPPUS)).toBeLessThan(PAPPUS * 5e-3)
    } finally {
      scope.dispose()
    }
  })

  it('refuses a mixed helix + sketch path by name through solveSweep', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    const bodyStore: Record<string, Body> = {}
    try {
      const repo = seedRepo()
      expect(() => solveSweep(oc!, scope, table, {
        id: 'sw1', kind: 'sweep',
        sweep: { sketch: ['$skP'], path: ['@hx1', '$skOther'], operation: 'new' },
      }, repo, bodyStore)).toThrow(/must stand alone/)
    } finally {
      table.disposeAll()
      scope.dispose()
    }
  })

  it('solveSweep builds a valid body of the Pappus volume along a helix path', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    const bodyStore: Record<string, Body> = {}
    try {
      const repo = seedRepo()
      const result = solveSweep(oc!, scope, table, {
        id: 'sw1', kind: 'sweep',
        sweep: { sketch: ['$skP'], path: '@hx1', operation: 'new' },
      }, repo, bodyStore)
      expect(result.status).toBe('ok')
      const body = bodyStore['body_sw1']
      expect(body).toBeDefined()
      const volume = volumeOf(oc!, scope, table.get<OccShape>(body.shape!))
      expect(Math.abs(volume - PAPPUS)).toBeLessThan(PAPPUS * 5e-3)
    } finally {
      table.disposeAll()
      scope.dispose()
    }
  })
})
