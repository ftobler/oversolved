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
import { volumeOf, surfaceAreaOf } from '../../occ/volume'
import { countSolids } from '../../occ/booleans'
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

// A radial square 4 tall (local v = axial) over a pitch of 3: consecutive turns
// overlap, the self-intersection case the leaf names.
function tallProfileBoundary() {
  return [{
    boundary: [
      { kind: 'line', id: 'l1', start: [-0.5, -2], end: [0.5, -2] },
      { kind: 'line', id: 'l2', start: [0.5, -2], end: [0.5, 2] },
      { kind: 'line', id: 'l3', start: [0.5, 2], end: [-0.5, 2] },
      { kind: 'line', id: 'l4', start: [-0.5, 2], end: [-0.5, -2] },
    ],
  }]
}

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

// The Top plane (world XZ): sketch (u, v) -> world (u, 0, -v). A thread
// profile is drawn here, in the plane the helix axis lies in.
const TOP_PLANE: PlaneLike = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 0, -1], normal: [0, 1, 0] }

// The Ex025 thread profile: a trapezoid beside the helix start, spanning world
// x 0.35..0.5 and z 0.05..0.35, so its outer edge touches the helix radius.
// Sketch v is -z, hence the negative second coordinates.
function threadProfileBoundary() {
  return [{
    boundary: [
      { kind: 'line', id: 'l1', start: [0.35, -0.1], end: [0.5, -0.05] },
      { kind: 'line', id: 'l2', start: [0.5, -0.05], end: [0.5, -0.35] },
      { kind: 'line', id: 'l3', start: [0.5, -0.35], end: [0.35, -0.3] },
      { kind: 'line', id: 'l4', start: [0.35, -0.3], end: [0.35, -0.1] },
    ],
  }]
}

// A helix of radius 0.5, pitch 0.4, 6 turns starting at (0.5, 0, zOffset).
// `zOffset` is the helix feature's own `offset`: it slides the whole path
// along its axis, which is a rigid translation of everything the sweep builds.
function threadHelixDescriptor(zOffset: number) {
  return {
    kind: 'helix', origin: [0, 0, zOffset], axis: [0, 0, 1], ref_axis: [0, 0, 1], x_axis: [0, 1, 0],
    radius: 0.5, pitch: 0.4, turns: 6, start_angle: -90, hand: 'right' as const,
  }
}

function seedThreadRepo(zOffset: number): Repository {
  const repo = new Repository()
  repo.register('_pt_skP', TOP_PLANE)
  repo.register('_topo_skP', { surfaces: threadProfileBoundary() })
  repo.register('_curve_hx1', threadHelixDescriptor(zOffset))
  return repo
}

type ThreadBuild = { status?: string; error?: string; volume?: number; area?: number; solids?: number }

/** Build the thread through solveSweep and read its mass properties before the
 *  scope drains. */
function buildThread(zOffset: number): ThreadBuild {
  const scope = new DisposeScope()
  const table = new HandleTable()
  const bodyStore: Record<string, Body> = {}
  try {
    try {
      const result = solveSweep(oc!, scope, table, {
        id: 'sw1', kind: 'sweep',
        sweep: { sketch: ['$skP'], path: '@hx1', operation: 'new' },
      }, seedThreadRepo(zOffset), bodyStore)
      const body = bodyStore['body_sw1']
      if (body?.shape == null) return { status: result.status }
      const solid = table.get<OccShape>(body.shape)
      return {
        status: result.status,
        volume: volumeOf(oc!, scope, solid),
        area: surfaceAreaOf(oc!, scope, solid),
        solids: countSolids(oc!, scope, solid),
      }
    } catch (exc) {
      return { error: (exc as Error).message }
    }
  } finally {
    table.disposeAll()
    scope.dispose()
  }
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

  it('builds the bottle thread on the helix start side and refuses it across the axis', () => {
    // The bottle half in miniature: the profile is drawn on a plane normal to
    // the neck axis, so the helix pierces it at the start. Rotating the same
    // profile across the axis leaves the crossing 20 mm away, where the old
    // leaf built a displaced thread with status ok.
    const squareAt = (cx: number) => [{
      boundary: [
        { kind: 'line', id: 'l1', start: [cx - 0.5, -0.5], end: [cx + 0.5, -0.5] },
        { kind: 'line', id: 'l2', start: [cx + 0.5, -0.5], end: [cx + 0.5, 0.5] },
        { kind: 'line', id: 'l3', start: [cx + 0.5, 0.5], end: [cx - 0.5, 0.5] },
        { kind: 'line', id: 'l4', start: [cx - 0.5, 0.5], end: [cx - 0.5, -0.5] },
      ],
    }]
    const seed = (cx: number): Repository => {
      const repo = new Repository()
      repo.register('_pt_skP', {
        origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1],
      })
      repo.register('_topo_skP', { surfaces: squareAt(cx) })
      repo.register('_curve_hx1', helixDescriptor())
      return repo
    }
    const build = (cx: number): { status?: string; error?: string } => {
      const scope = new DisposeScope()
      const table = new HandleTable()
      const bodyStore: Record<string, Body> = {}
      try {
        try {
          const result = solveSweep(oc!, scope, table, {
            id: 'sw1', kind: 'sweep',
            sweep: { sketch: ['$skP'], path: '@hx1', operation: 'new' },
          }, seed(cx), bodyStore)
          return { status: result.status }
        } catch (exc) {
          return { error: (exc as Error).message }
        }
      } finally {
        table.disposeAll()
        scope.dispose()
      }
    }
    expect(build(10).status).toBe('ok')
    expect(build(-10).error).toBe(
      "sweep: the profile is too far from the path: the nearest crossing is 19.5 mm outside it " +
      "(the band is the profile's own size) (path '@hx1')",
    )
  })

  it('builds a thread profile drawn beside the helix start', () => {
    // Ex025: the profile is offset 0.05 from the helix start, the ordinary way
    // a thread is modelled. It used to be refused as "the path does not pass
    // through the profile".
    const built = buildThread(0)
    expect(built.error).toBeUndefined()
    expect(built.status).toBe('ok')
    expect(built.solids).toBe(1)
  })

  it('equals the grazing build, where the helix touches the profile edge', () => {
    // A helix shifted along its own axis is the same rigid motion, so offset
    // 0.2 (the old workaround) must build the same body. This is the oracle:
    // no reference tool is needed.
    const offset = buildThread(0)
    const grazing = buildThread(0.2)
    expect(offset.error).toBeUndefined()
    expect(grazing.error).toBeUndefined()
    expect(offset.solids).toBe(1)
    expect(grazing.solids).toBe(1)
    expect(Math.abs(offset.volume! - grazing.volume!)).toBeLessThanOrEqual(grazing.volume! * 1e-9)
    expect(Math.abs(offset.area! - grazing.area!)).toBeLessThanOrEqual(grazing.area! * 1e-9)
  })

  it('refuses a profile farther beside the path than its own size, naming the gap', () => {
    // A 1 mm square whose nearest edge is 5 mm from the helix start: the gap is
    // far past the square's own 1.414 diagonal.
    const squareAt = (cx: number) => [{
      boundary: [
        { kind: 'line', id: 'l1', start: [cx - 0.5, -0.5], end: [cx + 0.5, -0.5] },
        { kind: 'line', id: 'l2', start: [cx + 0.5, -0.5], end: [cx + 0.5, 0.5] },
        { kind: 'line', id: 'l3', start: [cx + 0.5, 0.5], end: [cx - 0.5, 0.5] },
        { kind: 'line', id: 'l4', start: [cx - 0.5, 0.5], end: [cx - 0.5, -0.5] },
      ],
    }]
    const repo = new Repository()
    repo.register('_pt_skP', {
      origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1],
    })
    repo.register('_topo_skP', { surfaces: squareAt(4.5) })
    repo.register('_curve_hx1', helixDescriptor())
    const scope = new DisposeScope()
    const table = new HandleTable()
    try {
      expect(() => solveSweep(oc!, scope, table, {
        id: 'sw1', kind: 'sweep',
        sweep: { sketch: ['$skP'], path: '@hx1', operation: 'new' },
      }, repo, {})).toThrow(/5 mm outside it/)
    } finally {
      table.disposeAll()
      scope.dispose()
    }
  })

  it('a profile taller than the pitch is the named overlap error, body unchanged', () => {
    // 4 tall along the helix axis over a pitch of 3: consecutive turns overlap,
    // so the swept solid is invalid. The leaf must name that as an overlap
    // error rather than surface a generic MakePipeShell/valid-solid failure,
    // and must not have minted a body.
    const scope = new DisposeScope()
    const table = new HandleTable()
    const bodyStore: Record<string, Body> = {}
    try {
      const repo = new Repository()
      repo.register('_pt_skP', PROFILE_PLANE)
      repo.register('_topo_skP', { surfaces: tallProfileBoundary() })
      repo.register('_curve_hx1', helixDescriptor())
      expect(() => solveSweep(oc!, scope, table, {
        id: 'sw1', kind: 'sweep',
        sweep: { sketch: ['$skP'], path: '@hx1', operation: 'new' },
      }, repo, bodyStore)).toThrow(/overlaps the next turn/)
      expect(bodyStore['body_sw1']).toBeUndefined()
    } finally {
      table.disposeAll()
      scope.dispose()
    }
  })
})
