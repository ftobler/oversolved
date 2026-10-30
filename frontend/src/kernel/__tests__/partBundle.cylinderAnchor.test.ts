// @vitest-environment node
//
// Curved-face anchors sit at the face's OWN axial midpoint, on its axis.
// `surface_frame.origin` is wherever OCC built the surface (the extrude's start
// plane, the cut tool's start), so it sat at an END of the face or outside the
// face entirely: a mate then welded two features by their ends, and a pocket
// wall's anchor lay outside the wall it belonged to. Real OCC + Rust solver, so
// the extent measured here really is the face's own tessellation.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { SharedHarness } from '../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { toPartBundle, type Anchor, type PartBundle } from '../partBundle'
import type { BodyResult, FaceData } from '../../types/cad'

const oc = await loadOcc()
const solveBytes = loadSolver()

type Vec3 = [number, number, number]
type Frame = NonNullable<FaceData['surface_frame']>

function rectSketch(sketchId: string, w: number, h: number, plane: string) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane,
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: {
      bottom: [0, 0, w, 0], right: [w, 0, w, h],
      top: [w, h, 0, h], left: [0, h, 0, 0],
    },
    constraints: [
      { id: 'c1', kind: 'coincident' as const, a: { entity: 'bottom', point: 'end' as const }, b: { entity: 'right', point: 'start' as const } },
      { id: 'c2', kind: 'coincident' as const, a: { entity: 'right', point: 'end' as const }, b: { entity: 'top', point: 'start' as const } },
      { id: 'c3', kind: 'coincident' as const, a: { entity: 'top', point: 'end' as const }, b: { entity: 'left', point: 'start' as const } },
      { id: 'c4', kind: 'coincident' as const, a: { entity: 'left', point: 'end' as const }, b: { entity: 'bottom', point: 'start' as const } },
      { id: 'c5', kind: 'horizontal' as const, target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal' as const, target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical' as const, target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical' as const, target: { entity: 'left' } },
      { id: 'c9', kind: 'length' as const, target: { entity: 'bottom' }, value: w },
      { id: 'c10', kind: 'length' as const, target: { entity: 'left' }, value: h },
    ],
  }
}

function circleSketch(sketchId: string, cx: number, cy: number, r: number, plane: string) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Circle', plane,
    entities: [{ id: 'c1', kind: 'circle' as const }],
    initial: { c1: [cx, cy, r] },
  }
}

/** Perpendicular distance from p to the frame's axis line: 0 when p sits on it. */
function offAxis(p: Vec3, frame: Frame): number {
  const [ox, oy, oz] = frame.origin
  const [ax, ay, az] = frame.axis
  const len = Math.hypot(ax, ay, az)
  const dx = p[0] - ox, dy = p[1] - oy, dz = p[2] - oz
  const along = (dx * ax + dy * ay + dz * az) / len
  return Math.sqrt(Math.max(0, dx * dx + dy * dy + dz * dz - along * along))
}

describe.skipIf(!oc || !solveBytes)('axial midpoint anchors (real OCC + Rust solver)', () => {
  const harness = new SharedHarness(oc!)

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  function build(features: unknown[]): { bundle: PartBundle; fds: FaceData[] } {
    const result = harness.run({ version: 1, kind: 'part', features })
    const bodies = result.bodies as Record<string, BodyResult>
    const fds = Object.values(bodies).flatMap((b) => b.mesh?.face_data ?? [])
    return { bundle: toPartBundle('doc-anchor', 'hash-anchor', bodies), fds }
  }

  // The one face of a surface type; more than one means the pick is ambiguous.
  function soleFrame(fds: FaceData[], surfaceType: string): Frame {
    const hits = fds.filter((fd) => fd.surface_type === surfaceType)
    expect(hits.map((fd) => fd.surface_frame?.origin), `frames of ${surfaceType}`).toHaveLength(1)
    const frame = hits[0].surface_frame
    expect(frame, `a ${surfaceType} carries no surface_frame`).toBeDefined()
    return frame!
  }

  function soleAnchor(bundle: PartBundle, kind: Anchor['kind']): Anchor {
    const hits = Object.values(bundle.anchors).filter((a) => a.kind === kind)
    expect(hits.map((a) => a.point), `anchors of kind ${kind}`).toHaveLength(1)
    return hits[0]
  }

  it('a symmetric extrude anchors its wall at the midpoint of the swept span', () => {
    // The circle is swept 10 total, half either side of the Top plane: the wall
    // face spans y -5..5, so its midpoint is y = 0 on the sketch plane.
    const { bundle, fds } = build([
      circleSketch('sk1', 5, 5, 4, '@builtin_plane_top'),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'symmetric', operation: 'new' },
    ])
    const frame = soleFrame(fds, 'cylinderface')
    const anchor = soleAnchor(bundle, 'cylinder')
    // The wall's rotation axis, not the radial normal, and sign for sign the
    // surface frame's own axis (the mate welds against that sign).
    expect(Math.abs(anchor.axis[1])).toBeCloseTo(1, 6)
    expect(Math.abs(anchor.axis[0]) + Math.abs(anchor.axis[2])).toBeCloseTo(0, 6)
    expect(anchor.axis).toEqual(frame.axis)
    expect(offAxis(anchor.point, frame)).toBeCloseTo(0, 6)
    expect(anchor.point[1]).toBeCloseTo(0, 5)
  })

  it('a one-sided extrude anchors its wall midway to the far face', () => {
    // Top's normal is +Y, so this wall spans y 0..10: the midpoint is y = 5,
    // where the old anchor sat at the sweep start plane, y = 0.
    const { bundle, fds } = build([
      circleSketch('sk1', 5, 5, 4, '@builtin_plane_top'),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'normal', operation: 'new' },
    ])
    const frame = soleFrame(fds, 'cylinderface')
    const anchor = soleAnchor(bundle, 'cylinder')
    expect(anchor.axis).toEqual(frame.axis)
    expect(offAxis(anchor.point, frame)).toBeCloseTo(0, 6)
    expect(anchor.point[1]).toBeCloseTo(5, 5)
  })

  it('a pocket wall is anchored inside the wall, not at the cut tool start', () => {
    // The plate spans y -0.5..0.5 and the symmetric tool spans y -1..1, so the
    // wall only exists where the plate is. The old anchor was the tool's start
    // plane, y = -1: outside the face it named.
    const { bundle, fds } = build([
      rectSketch('sk1', 20, 20, '@builtin_plane_top'),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 1, direction: 'symmetric', operation: 'new' },
      circleSketch('sk2', 10, 10, 5, '@builtin_plane_top'),
      { id: 'ex2', kind: 'extrude', sketch: '$sk2', distance: 2, direction: 'symmetric', operation: 'cut' },
    ])
    const frame = soleFrame(fds, 'cylinderface')
    const anchor = soleAnchor(bundle, 'cylinder')
    expect(anchor.axis).toEqual(frame.axis)
    expect(offAxis(anchor.point, frame)).toBeCloseTo(0, 6)
    expect(anchor.point[1]).toBeCloseTo(0, 5)
  })

  it('a cone face anchors at the midpoint of its own axial span', () => {
    // A triangle revolved about +Y gives a cone with a coaxial bore: the
    // conical face runs y 0..4, so its midpoint is y = 2, inside the face.
    const { bundle, fds } = build([
      {
        id: 'skax', kind: 'sketch', label: 'Axis', plane: '@builtin_plane_front',
        entities: [{ id: 'ax', kind: 'line' as const }],
        initial: { ax: [0, -1, 0, 5] },
        constraints: [{ id: 'fix', kind: 'fixed' as const, target: { entity: 'ax' } }],
      },
      {
        // Pinned, not coincident-chained: the loop is authored coordinate-closed
        // (the area builder reads the authored coordinates), and a fixed keeps
        // every seeded parameter in place instead of letting the free DOF
        // rescale the triangle during the solve.
        id: 'skprof', kind: 'sketch', label: 'Profile', plane: '@builtin_plane_front',
        entities: [
          { id: 'ab', kind: 'line' as const }, { id: 'bc', kind: 'line' as const },
          { id: 'ca', kind: 'line' as const },
        ],
        initial: { ab: [1, 0, 3, 0], bc: [3, 0, 1, 4], ca: [1, 4, 1, 0] },
        constraints: [
          { id: 'f1', kind: 'fixed' as const, target: { entity: 'ab' } },
          { id: 'f2', kind: 'fixed' as const, target: { entity: 'bc' } },
          { id: 'f3', kind: 'fixed' as const, target: { entity: 'ca' } },
        ],
      },
      { id: 'rev1', kind: 'revolve', sketch: '$skprof', angle: 360, axis: '@skax/ax', operation: 'new' },
    ])
    const frame = soleFrame(fds, 'coneface')
    const cone = soleAnchor(bundle, 'cone')
    expect(cone.axis).toEqual(frame.axis)
    expect(offAxis(cone.point, frame)).toBeCloseTo(0, 6)
    // The revolve axis is the world Y line through the origin, so the midpoint
    // of the face's y 0..4 span lands at (0, 2, 0).
    expect(cone.point[0]).toBeCloseTo(0, 5)
    expect(cone.point[1]).toBeCloseTo(2, 5)
    expect(cone.point[2]).toBeCloseTo(0, 5)
  })
})
