// @vitest-environment node
//
// Gated real-OCC tests for the helix leaf, driven directly (no Rust sketch
// solver needed): build a real cylinder primitive, register its faces/edges in
// a Repository as the builder would, and call solveHelix. A helix is a
// reference curve: it registers plain data and never a body. Skips when
// opencascade.js is absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { Repository } from '../../query'
import { sortedFacesOf } from '../../occ/faceLoops'
import { makeCylinderWithFaces, makeCircleEdge, makeLineEdge } from '../../occ/primitives'
import { solveHelix } from '../helix'
import { resolveAxisQuery } from '../shared/directionQuery'
import type { Body } from '../../types3d'
import type { OccShape } from '../../occ/occTypes'

const oc = await loadOcc()

const distanceToZAxis = (p: number[]) => Math.hypot(p[0], p[1])

interface FaceIf extends OccShape { IsSame(other: OccShape): boolean }

function faceIndex(occ: NonNullable<typeof oc>, scope: DisposeScope, shape: OccShape, face: OccShape): number {
  const faces = sortedFacesOf(occ, scope, shape)
  const target = face as FaceIf
  return faces.findIndex((f) => target.IsSame(f))
}

describe.skipIf(!oc)('helix leaf (real OCC)', () => {
  function setup() {
    const scope = new DisposeScope()
    const table = new HandleTable()
    const repo = new Repository()
    const { shape, faces } = makeCylinderWithFaces(oc!, scope, [0, 0, 0], [0, 0, 1], 5, 10)
    const handle = table.register(shape, 'ex1')
    const body: Body = {
      id: 'body_ex1', created_by: 'ex1', modified_by: [], shape: handle,
      sketch_id: 'sk1', brep_diff: null, profile_queries: [],
    }
    const bodyStore: Record<string, Body> = { body_ex1: body }
    const idx = faceIndex(oc!, scope, shape, faces.lateral)
    repo.register('cf', {
      type: 'cylinderface', body_id: 'body_ex1', face_index: idx,
      axis: [0, 0, 1], centroid: [0, 0, 5], normal: [1, 0, 0],
    })
    return { scope, table, repo, bodyStore, shape, faces }
  }

  it('a face helix spans the cylinder and sits on radius 5', () => {
    const { scope, table, repo, bodyStore } = setup()
    try {
      const result = solveHelix(oc!, scope, table, {
        id: 'hx1', kind: 'helix',
        helix: {
          reference: '@cf', radius_mode: 'derived', mode: 'pitch_height', pitch: 2,
          height_from_reference: true, hand: 'right', direction: 'normal', start_angle: 0, offset: 0,
        },
      }, repo, bodyStore)

      expect(result.status).toBe('ok')
      expect(result.helix.radius).toBeCloseTo(5)
      expect(result.helix.turns).toBeCloseTo(5)
      expect(result.helix.height).toBeCloseTo(10)
      const zs = [result.curve.points[0][2], result.curve.points[result.curve.points.length - 1][2]].sort((a, b) => a - b)
      expect(zs[0]).toBeCloseTo(0, 4)
      expect(zs[1]).toBeCloseTo(10, 4)
      for (const p of result.curve.points) expect(distanceToZAxis(p)).toBeCloseTo(5, 4)

      // The repo descriptor is plain data under _curve_<id>.
      const desc = repo.elements.get('_curve_hx1') as Record<string, unknown>
      expect(desc.kind).toBe('helix')
      expect(desc.radius).toBeCloseTo(5)
      expect(repo.elements.get('hx1')).toBeDefined()
      expect(repo.elements.get('hx1/start')).toBeDefined()
      expect(repo.elements.get('hx1/end')).toBeDefined()
      // A helix is a reference curve, never a body.
      expect(Object.keys(bodyStore)).toEqual(['body_ex1'])
    } finally {
      table.disposeAll()
      scope.dispose()
    }
  })

  it('a circular edge reference uses the circle radius', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    const repo = new Repository()
    try {
      makeCircleEdge(oc!, scope, [0, 0, 10], [0, 0, 1], [1, 0, 0], 5)
      repo.register('ce', {
        type: 'edge', kind: 'circle', center: [0, 0, 10], axis: [0, 0, 1], radius: 5, x_axis: [1, 0, 0],
      })
      const result = solveHelix(oc!, scope, table, {
        id: 'hx1', kind: 'helix',
        helix: { reference: '@ce', radius_mode: 'derived', mode: 'pitch_turns', pitch: 2, turns: 5, hand: 'right', direction: 'normal', start_angle: 0, offset: 0 },
      }, repo, {})
      expect(result.status).toBe('ok')
      expect(result.helix.radius).toBeCloseTo(5)
      // No axial extent: normal starts in the circle's plane.
      expect(result.curve.points[0][2]).toBeCloseTo(10, 6)
    } finally {
      table.disposeAll()
      scope.dispose()
    }
  })

  it('the bare helix id resolves to its axis, not its endpoint chord', () => {
    const { scope, table, repo, bodyStore } = setup()
    try {
      // Fractional turns so the start-to-end chord is NOT the climb axis: only
      // the center/axis branch can return +Z here.
      solveHelix(oc!, scope, table, {
        id: 'hx1', kind: 'helix',
        helix: { reference: '@cf', radius_mode: 'derived', mode: 'pitch_turns', pitch: 2, turns: 3.25, hand: 'right', direction: 'normal', start_angle: 0, offset: 0 },
      }, repo, bodyStore)
      const [origin, dir] = resolveAxisQuery('@hx1', repo, [9, 9, 9], [1, 0, 0], bodyStore)
      // The axis is the cylinder's Z axis through the origin, not the chord.
      expect(Math.hypot(origin[0], origin[1])).toBeCloseTo(0, 6)
      expect(dir[0]).toBeCloseTo(0)
      expect(dir[1]).toBeCloseTo(0)
      expect(Math.abs(dir[2])).toBeCloseTo(1)
    } finally {
      table.disposeAll()
      scope.dispose()
    }
  })

  it('a straight edge with an entered radius rides that radius about the line', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    const repo = new Repository()
    try {
      makeLineEdge(oc!, scope, [5, 0, 0], [5, 0, 10])
      repo.register('se', { type: 'straightedge', kind: 'line', start: [5, 0, 0], end: [5, 0, 10] })
      const result = solveHelix(oc!, scope, table, {
        id: 'hx1', kind: 'helix',
        helix: { reference: '@se', radius_mode: 'entered', radius: 3, mode: 'pitch_turns', pitch: 2, turns: 3, hand: 'right', direction: 'normal', start_angle: 0, offset: 0 },
      }, repo, {})
      expect(result.status).toBe('ok')
      expect(result.helix.radius).toBeCloseTo(3)
      // Every sample is 3 from the line x=5, y=0 (the line runs along z).
      for (const p of result.curve.points) expect(Math.hypot(p[0] - 5, p[1])).toBeCloseTo(3, 6)
    } finally {
      table.disposeAll()
      scope.dispose()
    }
  })

  it('a derived radius on a straight reference is a named error', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    const repo = new Repository()
    try {
      repo.register('se', { type: 'straightedge', kind: 'line', start: [5, 0, 0], end: [5, 0, 10] })
      expect(() => solveHelix(oc!, scope, table, {
        id: 'hx1', kind: 'helix',
        helix: { reference: '@se', radius_mode: 'derived', mode: 'pitch_turns', pitch: 2, turns: 3, hand: 'right', direction: 'normal' },
      }, repo, {})).toThrow(/straight-edge/)
    } finally {
      table.disposeAll()
      scope.dispose()
    }
  })

  it('refuses a cone face and an ellipse edge by name', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    const repo = new Repository()
    try {
      repo.register('cone', { type: 'coneface', axis: [0, 0, 1], centroid: [0, 0, 1] })
      expect(() => solveHelix(oc!, scope, table, {
        id: 'h1', kind: 'helix',
        helix: { reference: '@cone', radius_mode: 'derived', mode: 'pitch_turns', pitch: 2, turns: 3 },
      }, repo, {})).toThrow(/cone/)

      repo.register('ell', { type: 'edge', kind: 'ellipse', center: [0, 0, 0], axis: [0, 0, 1], a: 5, b: 3 })
      expect(() => solveHelix(oc!, scope, table, {
        id: 'h2', kind: 'helix',
        helix: { reference: '@ell', radius_mode: 'derived', mode: 'pitch_turns', pitch: 2, turns: 3 },
      }, repo, {})).toThrow(/ellipse/)

      repo.register('flat', { type: 'flatface', normal: [0, 0, 1], centroid: [0, 0, 1] })
      expect(() => solveHelix(oc!, scope, table, {
        id: 'h3', kind: 'helix',
        helix: { reference: '@flat', radius_mode: 'derived', mode: 'pitch_turns', pitch: 2, turns: 3 },
      }, repo, {})).toThrow(/flat face/)
    } finally {
      table.disposeAll()
      scope.dispose()
    }
  })

  it('a sketch circle reference lifts through the sketch plane', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    const repo = new Repository()
    try {
      repo.register('_pt_sk', { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] })
      repo.register('sk/circ0', { external_params: [0, 0, 5], kind: 'circle', sketch_id: 'sk' })
      const result = solveHelix(oc!, scope, table, {
        id: 'hx1', kind: 'helix',
        helix: { reference: '@sk/circ0', radius_mode: 'derived', mode: 'pitch_turns', pitch: 2, turns: 4, hand: 'right', direction: 'normal', start_angle: 0, offset: 0 },
      }, repo, {})
      expect(result.status).toBe('ok')
      expect(result.helix.radius).toBeCloseTo(5)
      // The circle's axis is the sketch normal (+Z) and it lies in the sketch
      // plane (z=0), so the helix rides radius 5 about world Z.
      for (const p of result.curve.points) expect(distanceToZAxis(p)).toBeCloseTo(5, 4)
    } finally {
      table.disposeAll()
      scope.dispose()
    }
  })

  it('a sketch line reference with an entered radius is lifted and used', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    const repo = new Repository()
    try {
      repo.register('_pt_sk', { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] })
      repo.register('sk/ln0', { external_params: [5, 0, 5, 10], kind: 'line', sketch_id: 'sk' })
      const result = solveHelix(oc!, scope, table, {
        id: 'hx1', kind: 'helix',
        helix: { reference: '@sk/ln0', radius_mode: 'entered', radius: 2, mode: 'pitch_turns', pitch: 2, turns: 3, hand: 'right', direction: 'normal', start_angle: 0, offset: 0 },
      }, repo, {})
      expect(result.status).toBe('ok')
      expect(result.helix.radius).toBeCloseTo(2)
      // The sketch line is (5,0)-(5,10) on the front plane, i.e. world x=5,
      // z=0, y 0..10; the helix rides radius 2 about that line.
      for (const p of result.curve.points) expect(Math.hypot(p[0] - 5, p[2])).toBeCloseTo(2, 6)
    } finally {
      table.disposeAll()
      scope.dispose()
    }
  })

  it('a left-hand helix mirrors the right-hand one', () => {
    const { scope, table, repo, bodyStore } = setup()
    try {
      const base = {
        reference: '@cf', radius_mode: 'derived', mode: 'pitch_turns', pitch: 2, turns: 4,
        start_angle: 0, offset: 0, direction: 'normal',
      } as const
      const right = solveHelix(oc!, scope, table, { id: 'right', kind: 'helix', helix: { ...base, hand: 'right' } }, repo, bodyStore)
      const left = solveHelix(oc!, scope, table, { id: 'left', kind: 'helix', helix: { ...base, hand: 'left' } }, repo, bodyStore)
      expect(right.curve.points.length).toBe(left.curve.points.length)
      // With start_angle 0 the start radius is +Y, so the left curve is the
      // right curve reflected through the y-z plane (x negated, y and z equal).
      for (let i = 0; i < right.curve.points.length; i++) {
        expect(left.curve.points[i][0]).toBeCloseTo(-right.curve.points[i][0], 6)
        expect(left.curve.points[i][1]).toBeCloseTo(right.curve.points[i][1], 6)
        expect(left.curve.points[i][2]).toBeCloseTo(right.curve.points[i][2], 6)
      }
    } finally {
      table.disposeAll()
      scope.dispose()
    }
  })
})
