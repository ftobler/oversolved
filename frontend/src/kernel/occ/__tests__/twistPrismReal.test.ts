// @vitest-environment node
//
// Real-OCC spike for `extrude.twist`, kept as the regression guard for the
// builder it settled on. It answers, for the route it pins:
//   - WHICH ROUTE: the pinned OCC build cannot do CadQuery's twisted extrude.
//     `BRepOffsetAPI_MakePipeShell` binds exactly four `SetMode` overloads, all
//     one-argument (`SetMode_1` bool, `_2` gp_Ax2, `_3` gp_Dir, `_4`
//     TopoDS_Shape SpineSupport); the auxiliary-spine overload
//     `SetMode(TopoDS_Wire, bool, BRepFill_TypeOfContact)` is absent, and the
//     `BRepFill_TypeOfContact` enum it needs is absent too. So the feature lofts
//     one section per 10 degrees of rotation with `BRepOffsetAPI_ThruSections`
//     (`occ/twistPrism.ts`). The first test pins those four arities and the
//     missing entry points, so a repin that adds the overload shows up here.
//   - the loft is valid, one solid and within 1e-4 relative of `area * distance`
//     for a square at 90 and 360 degrees, an L (sign), a washer (hole), a lobed
//     screw profile at 8 turns and a circle (rotation-symmetric no-op);
//   - one lateral face per profile edge, the end cap is the rotated profile, and
//     `Generated(edge)` keeps the profile edge lineage.
//
// Measured on this box (x86, node 24), for the section counts below: square 90
// (9 sections) builds in ~40 ms, lobed 8 turns (288 sections) in ~420 ms, and
// the eight-turn volume read is ~130 ms. Section count is a count, not a time,
// so the test pins counts and volumes only.
//
// Skips when OCC is absent.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import {
  makeLineEdge,
  makeWire,
  makeFaceFromWire,
  makeCircleEdge,
  faceArea,
  faceSurfaceType,
  type Vec3,
} from '../primitives'
import { countSolids, shapeIsValid } from '../booleans'
import { volumeForMeasure } from '../volume'
import { shapeBbox } from '../faceBounds'
import { extrudeProfileWithLineage } from '../prismLineage'
import { twistPrismBuilder, twistSectionCount, MAX_TWIST_DEG } from '../twistPrism'
import type { PlaneLike } from '../../features/shared/planes'
import type { LoopEdge } from '../../profileLoops'
import type { OccModule, OccShape } from '../occTypes'

const oc = await loadOcc()

const XY: PlaneLike = {
  origin: [0, 0, 0],
  x_axis: [1, 0, 0],
  y_axis: [0, 1, 0],
  normal: [0, 0, 1],
}
const Z: Vec3 = [0, 0, 1]

function polygonWire(occ: OccModule, scope: DisposeScope, pts: Vec3[]): OccShape {
  const edges = pts.map((p, i) => scope.track(makeLineEdge(occ, scope, p, pts[(i + 1) % pts.length])))
  return scope.track(makeWire(occ, scope, edges, { requireClosed: true }))
}

function squareWire(occ: OccModule, scope: DisposeScope, half: number): OccShape {
  return polygonWire(occ, scope, [
    [-half, -half, 0],
    [half, -half, 0],
    [half, half, 0],
    [-half, half, 0],
  ])
}

/** A counter-clockwise L: asymmetric in x and y, so a rotation shows in its
 *  bounding box. */
function lWire(occ: OccModule, scope: DisposeScope): OccShape {
  return polygonWire(occ, scope, [
    [0, 0, 0],
    [20, 0, 0],
    [20, 5, 0],
    [5, 5, 0],
    [5, 20, 0],
    [0, 20, 0],
  ])
}

/** The example020 screw's lobed outline: alternating radii, six lobes. */
function lobedWire(occ: OccModule, scope: DisposeScope, outer: number, inner: number): OccShape {
  const pts: Vec3[] = []
  for (let i = 0; i < 12; i++) {
    const r = i % 2 === 0 ? outer : inner
    const a = (i / 12) * 2 * Math.PI
    pts.push([r * Math.cos(a), r * Math.sin(a), 0])
  }
  return polygonWire(occ, scope, pts)
}

/** A square plate with a centred circular hole. */
function washerFace(occ: OccModule, scope: DisposeScope, half: number, holeRadius: number): OccShape {
  const outer = squareWire(occ, scope, half)
  const hole = scope.track(makeWire(occ, scope, [
    scope.track(makeCircleEdge(occ, scope, [0, 0, 0], Z, [1, 0, 0], holeRadius)),
  ], { requireClosed: true }))
  return scope.track(makeFaceFromWire(occ, scope, outer, [hole]))
}

function circleFace(occ: OccModule, scope: DisposeScope, radius: number): OccShape {
  const wire = scope.track(makeWire(occ, scope, [
    scope.track(makeCircleEdge(occ, scope, [0, 0, 0], Z, [1, 0, 0], radius)),
  ], { requireClosed: true }))
  return scope.track(makeFaceFromWire(occ, scope, wire))
}

function lateralFaceCount(occ: OccModule, scope: DisposeScope, shape: OccShape): number {
  const E = occ.TopAbs_ShapeEnum
  const exp = scope.track(new occ.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  let n = 0
  for (; exp.More(); exp.Next()) {
    const face = scope.track(occ.TopoDS.Face_1(exp.Current()))
    // A lifted twisted wall is a B-spline or a cylinder, never a plane; the two
    // caps are the only flat faces the loft makes.
    if (faceSurfaceType(occ, scope, face) !== 'flatface') n++
  }
  return n
}

interface Bar {
  solid: OccShape
  volume: number
  expected: number
  valid: boolean
  solids: number
  laterals: number
  endBbox: number[]
}

function twistBar(
  occ: OccModule,
  scope: DisposeScope,
  face: OccShape,
  distance: number,
  twistDeg: number,
  direction: Vec3 = Z,
): Bar {
  const expected = faceArea(occ, scope, face) * Math.abs(distance)
  const builder = twistPrismBuilder(occ, scope, face, [0, 0, 0], direction, distance, (twistDeg * Math.PI) / 180)
  const solid = builder.Shape()
  scope.track(solid)
  const end = builder.LastShape?.()
  if (end === undefined) throw new Error('the twist builder exposed no end cap')
  // Validity before any measurement that consumes the shape.
  const valid = shapeIsValid(occ, scope, solid)
  return {
    solid,
    valid,
    volume: volumeForMeasure(occ, scope, solid),
    solids: countSolids(occ, scope, solid),
    laterals: lateralFaceCount(occ, scope, solid),
    endBbox: shapeBbox(occ, scope, end),
    expected,
  }
}

/** Square loops with entity ids, for the lineage check. */
function squareLoops(half: number): LoopEdge[][] {
  return [[
    { kind: 'line', start: [-half, -half], end: [half, -half], id: 'b' },
    { kind: 'line', start: [half, -half], end: [half, half], id: 'r' },
    { kind: 'line', start: [half, half], end: [-half, half], id: 't' },
    { kind: 'line', start: [-half, half], end: [-half, -half], id: 'l' },
  ]]
}

function expectRelative(actual: number, expected: number, rel: number): void {
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(rel)
}

describe.skipIf(!oc)('twist prism spike (real OCC)', () => {
  it('pins the SetMode surface: the auxiliary-spine overload is not in the build', () => {
    const proto = (oc!.BRepOffsetAPI_MakePipeShell as unknown as {
      prototype: Record<string, unknown>
    }).prototype
    const arity = (name: string): number => {
      const member = proto[name]
      if (typeof member !== 'function') throw new Error(`${name} is not bound`)
      return (member as { length: number }).length
    }
    // Four one-argument overloads: the Frenet flag, gp_Ax2, gp_Dir and
    // TopoDS_Shape (SpineSupport). CadQuery's `SetMode(auxSpine, false)` needs
    // one of three arguments, so none of these is it.
    expect(['SetMode_1', 'SetMode_2', 'SetMode_3', 'SetMode_4'].map(arity)).toEqual([1, 1, 1, 1])
    expect(proto.SetMode_5).toBeUndefined()
    expect((oc as unknown as Record<string, unknown>).BRepFill_TypeOfContact).toBeUndefined()
  })

  it('twisted square at 90 degrees: volume, 4 lateral walls and the rotated end cap', () => {
    const scope = new DisposeScope()
    try {
      const face = scope.track(makeFaceFromWire(oc!, scope, squareWire(oc!, scope, 5)))
      const bar = twistBar(oc!, scope, face, 10, 90)
      expect(bar.valid).toBe(true)
      expect(bar.solids).toBe(1)
      expectRelative(bar.volume, bar.expected, 1e-4)
      expect(bar.laterals).toBe(4)
      // A square maps to itself at 90 degrees, so the end cap's bbox is still
      // +-5; the 45 degree case below is what shows the rotation.
    } finally {
      scope.dispose()
    }
  })

  it('twisted square at 360 degrees: volume and the same four walls', () => {
    const scope = new DisposeScope()
    try {
      const face = scope.track(makeFaceFromWire(oc!, scope, squareWire(oc!, scope, 5)))
      const bar = twistBar(oc!, scope, face, 10, 360)
      expect(bar.valid).toBe(true)
      expect(bar.solids).toBe(1)
      expectRelative(bar.volume, bar.expected, 1e-4)
      expect(bar.laterals).toBe(4)
    } finally {
      scope.dispose()
    }
  })

  it('square at 45 degrees: the end cap is the profile rotated, bbox +-7.071', () => {
    const scope = new DisposeScope()
    try {
      const face = scope.track(makeFaceFromWire(oc!, scope, squareWire(oc!, scope, 5)))
      const bar = twistBar(oc!, scope, face, 10, 45)
      expectRelative(bar.volume, bar.expected, 1e-4)
      expect(bar.endBbox[0]).toBeCloseTo(-7.07106781, 4)
      expect(bar.endBbox[1]).toBeCloseTo(-7.07106781, 4)
      expect(bar.endBbox[3]).toBeCloseTo(7.07106781, 4)
      expect(bar.endBbox[4]).toBeCloseTo(7.07106781, 4)
    } finally {
      scope.dispose()
    }
  })

  it('sign: an L rotates right-handed about the direction of travel', () => {
    const scope = new DisposeScope()
    try {
      const positive = twistBar(oc!, scope, scope.track(makeFaceFromWire(oc!, scope, lWire(oc!, scope))), 10, 90)
      // The L reaches max x at y=0; +90 degrees about +Z maps +x onto +y, so the
      // end cap sits at x in [-20, 0], y in [0, 20].
      expect(positive.endBbox[0]).toBeCloseTo(-20, 5)
      expect(positive.endBbox[1]).toBeCloseTo(0, 5)
      expect(positive.endBbox[3]).toBeCloseTo(0, 5)
      expect(positive.endBbox[4]).toBeCloseTo(20, 5)

      const negative = twistBar(oc!, scope, scope.track(makeFaceFromWire(oc!, scope, lWire(oc!, scope))), 10, -90)
      // The opposite sign is the opposite handedness.
      expect(negative.endBbox[0]).toBeCloseTo(0, 5)
      expect(negative.endBbox[1]).toBeCloseTo(-20, 5)
      expect(negative.endBbox[3]).toBeCloseTo(20, 5)
      expect(negative.endBbox[4]).toBeCloseTo(0, 5)

      // Reverse mirrors about the sketch plane and keeps the handedness about
      // the travel direction: the same end cap, 10 below the plane.
      const reverse = twistBar(
        oc!, scope, scope.track(makeFaceFromWire(oc!, scope, lWire(oc!, scope))), 10, 90, [0, 0, -1],
      )
      expect(reverse.endBbox[2]).toBeCloseTo(-10, 5)
      expect(reverse.endBbox[0]).toBeCloseTo(0, 5)
      expect(reverse.endBbox[3]).toBeCloseTo(20, 5)
      expect(reverse.endBbox[1]).toBeCloseTo(-20, 5)
      expect(reverse.endBbox[4]).toBeCloseTo(0, 5)
      // The L's area is 175: a 20 x 5 bar plus a 5 x 15 arm.
      expectRelative(positive.volume, 175 * 10, 1e-4)
      expectRelative(negative.volume, 175 * 10, 1e-4)
      expectRelative(reverse.volume, 175 * 10, 1e-4)
    } finally {
      scope.dispose()
    }
  })

  it('washer: the hole twists with the outer wall and the volume is the plate minus the bore', () => {
    const scope = new DisposeScope()
    try {
      const face = washerFace(oc!, scope, 5, 2)
      const bar = twistBar(oc!, scope, face, 10, 120)
      expect(bar.valid).toBe(true)
      expect(bar.solids).toBe(1)
      // Four outer walls and the bore's wall: the hole is carried.
      expect(bar.laterals).toBe(5)
      expectRelative(bar.volume, (100 - Math.PI * 4) * 10, 1e-4)
    } finally {
      scope.dispose()
    }
  })

  it('the example020 lobed screw: 8 turns over 40, 288 sections, 12 walls', () => {
    const scope = new DisposeScope()
    try {
      const face = scope.track(makeFaceFromWire(oc!, scope, lobedWire(oc!, scope, 5, 3)))
      expect(twistSectionCount(2880)).toBe(288)
      const bar = twistBar(oc!, scope, face, 40, 2880)
      expect(bar.valid).toBe(true)
      expect(bar.solids).toBe(1)
      expect(bar.laterals).toBe(12)
      expectRelative(bar.volume, faceArea(oc!, scope, face) * 40, 1e-4)
    } finally {
      scope.dispose()
    }
  })

  it('a circle twisted about its centre is a valid no-op in shape', () => {
    const scope = new DisposeScope()
    try {
      const face = circleFace(oc!, scope, 5)
      const bar = twistBar(oc!, scope, face, 10, 90)
      expect(bar.valid).toBe(true)
      expect(bar.solids).toBe(1)
      expect(bar.laterals).toBe(1)
      expectRelative(bar.volume, Math.PI * 25 * 10, 1e-4)
      // Rotationally symmetric, so the bbox stays a circle's +-5 at both ends.
      expect(bar.endBbox[0]).toBeCloseTo(-5, 5)
      expect(bar.endBbox[3]).toBeCloseTo(5, 5)
    } finally {
      scope.dispose()
    }
  })

  it('keeps the profile edge lineage through the loft', () => {
    const scope = new DisposeScope()
    try {
      const loops = squareLoops(5)
      const { solid, faceAncestry } = extrudeProfileWithLineage(
        oc!, scope, loops, XY, Z, 10, 'sk1', 'ex1', 0, 90,
      )
      scope.track(solid)
      expect(countSolids(oc!, scope, solid)).toBe(1)
      expectRelative(volumeForMeasure(oc!, scope, solid), 1000, 1e-4)
      const tokens = Object.values(faceAncestry).map((list) => list.join(' '))
      for (const id of ['b', 'r', 't', 'l']) {
        expect(tokens.some((entry) => entry.includes(`@sk1/${id}`)), id).toBe(true)
      }
    } finally {
      scope.dispose()
    }
  })

  it('the cap bounds the angle: 720 sections of 10 degrees', () => {
    expect(MAX_TWIST_DEG).toBe(7200)
    expect(twistSectionCount(MAX_TWIST_DEG)).toBe(720)
    // An angle below one step still takes two sections (a one-section loft is
    // the straight prism, not a twist).
    expect(twistSectionCount(1)).toBe(2)
  })
})
