// @vitest-environment node
//
// Phase-1 probe for the loft kernel path, kept as a regression test. It pins the
// OCCT 7.4.0p1 (opencascade.js 1.1.1) behaviour the loft adapter (occ/loftShape.ts)
// is built on, none of which is documented for this build:
//
//   - Exactly ONE constructor is bound, taking all three arguments
//     (isSolid, ruled, pres3d); `AddWire` is bound WITHOUT the isClosing flag
//     (a two-argument call is a BindingError).
//   - `Generated(edge)` reports the image of that edge in EVERY band it belongs
//     to: in a three-section ruled loft every section's edge reports BOTH bands,
//     so a band is reachable from either of its two sections. That is why the
//     adapter names a band from the LOWEST section that reaches it.
//   - `FirstShape()`/`LastShape()` each hold the cap face of the first/last
//     ADDED wire: adding the small top wire first makes FirstShape the top cap
//     (z = 10), never the world-axis one.
//   - A ruled loft between a 10x10 square at z=0 and a 6x6 square at z=10 is
//     V = 653.33, 6 faces, 12 edges (the frustum formula
//     h/3*(A1+A2+sqrt(A1*A2))); a smooth three-section loft (10, 16, 8) is
//     V = 1918.7975274, 6 faces; a circle to a square with
//     CheckCompatibility(true) builds 7 faces.
//
// Skips when opencascade.js is absent, like every *Real suite.
import { describe, it, expect } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope, drainList } from '../disposeScope'
import { canonicalFaces, canonicalEdges } from '../bodyNames'
import { volumeOf, surfaceAreaOf } from '../volume'
import { sketchLoopsToFace } from '../prismProfile'
import { healWire, faceCentroid } from '../primitives'
import type { OccModule, OccShape } from '../occTypes'
import type { PlaneLike } from '../../features/shared/planes'
import type { LoopEdge } from '../../profileLoops'

const oc = await loadOcc()

const square = (size: number): LoopEdge[] => [
  { id: 'e1', kind: 'line', start: [-size / 2, -size / 2], end: [size / 2, -size / 2] },
  { id: 'e2', kind: 'line', start: [size / 2, -size / 2], end: [size / 2, size / 2] },
  { id: 'e3', kind: 'line', start: [size / 2, size / 2], end: [-size / 2, size / 2] },
  { id: 'e4', kind: 'line', start: [-size / 2, size / 2], end: [-size / 2, -size / 2] },
]

const circle = (radius: number): LoopEdge[] => [
  { id: 'e1', kind: 'arc', center: [0, 0], radius, angle_start_deg: 0, angle_end_deg: 360, ccw: true, start: [radius, 0], end: [radius, 0] },
]

function planeAt(z: number): PlaneLike {
  return { origin: [0, 0, z], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }
}

/** A section boundary wire at z, built the way the loft leaf builds one. */
function wireOf(module: OccModule, scope: DisposeScope, loops: LoopEdge[], z: number): OccShape {
  const face = scope.track(sketchLoopsToFace(module, scope, [loops], planeAt(z)))
  const raw = scope.track(module.BRepTools.OuterWire(face))
  return scope.track(healWire(module, scope, raw))
}

const isSame = (a: OccShape, b: OccShape): boolean => (a as unknown as { IsSame(o: unknown): boolean }).IsSame(b)

function wireEdges(module: OccModule, scope: DisposeScope, wire: OccShape): OccShape[] {
  const E = module.TopAbs_ShapeEnum
  const out: OccShape[] = []
  const exp = scope.track(new module.TopExp_Explorer_2(wire, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) {
    const raw = scope.track(exp.Current())
    out.push(scope.track(module.TopoDS.Edge_1(raw)))
  }
  return out
}

function loftOf(module: OccModule, scope: DisposeScope, wires: OccShape[], ruled: boolean, smooth: boolean) {
  const maker = scope.track(new module.BRepOffsetAPI_ThruSections(true, ruled, 1e-6))
  for (const wire of wires) maker.AddWire(wire)
  if (smooth) maker.SetSmoothing(true)
  maker.Build()
  return maker
}

describe.skipIf(!oc)('ThruSections phase-1 probe (real OCC)', () => {
  function setup() {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    return oc
  }

  it('builds a ruled two-section loft with the frustum volume', () => {
    const module = setup()
    const scope = new DisposeScope()
    try {
      const bottom = wireOf(module, scope, square(10), 0)
      const top = wireOf(module, scope, square(6), 10)
      const maker = loftOf(module, scope, [bottom, top], true, false)
      expect(maker.IsDone()).toBe(true)
      const shape = scope.track(maker.Shape())
      // h/3*(A1 + A2 + sqrt(A1*A2)) = 10/3*(100 + 36 + 60) = 653.33.
      expect(volumeOf(module, scope, shape)).toBeCloseTo(653.3333333333334, 6)
      expect(surfaceAreaOf(module, scope, shape)).toBeCloseTo(462.3372488699382, 6)
      expect(canonicalFaces(module, scope, shape)).toHaveLength(6)
      expect(canonicalEdges(module, scope, shape)).toHaveLength(12)

      // Both caps are faces of the output, and each cap belongs to the wire
      // that generated it: FirstShape is the FIRST added wire's cap.
      const faces = canonicalFaces(module, scope, shape)
      const firstCap = canonicalFaces(module, scope, maker.FirstShape())[0]
      const lastCap = canonicalFaces(module, scope, maker.LastShape())[0]
      expect(faces.some((f) => isSame(f, firstCap))).toBe(true)
      expect(faces.some((f) => isSame(f, lastCap))).toBe(true)
      expect(faceCentroid(module, scope, firstCap)[2]).toBeCloseTo(0, 6)
      expect(faceCentroid(module, scope, lastCap)[2]).toBeCloseTo(10, 6)
    } finally {
      scope.dispose()
    }
  })

  it('caps follow the ADD order, not the world axis', () => {
    const module = setup()
    const scope = new DisposeScope()
    try {
      // The small top wire is added first: FirstShape must be the top cap.
      const top = wireOf(module, scope, square(6), 10)
      const bottom = wireOf(module, scope, square(10), 0)
      const maker = loftOf(module, scope, [top, bottom], true, false)
      expect(maker.IsDone()).toBe(true)
      expect(faceCentroid(module, scope, canonicalFaces(module, scope, maker.FirstShape())[0])[2]).toBeCloseTo(10, 6)
      expect(faceCentroid(module, scope, canonicalFaces(module, scope, maker.LastShape())[0])[2]).toBeCloseTo(0, 6)
      expect(volumeOf(module, scope, scope.track(maker.Shape()))).toBeCloseTo(653.3333333333334, 6)
    } finally {
      scope.dispose()
    }
  })

  it('every section edge reports every band of a ruled loft', () => {
    const module = setup()
    const scope = new DisposeScope()
    try {
      const wires = [wireOf(module, scope, square(10), 0), wireOf(module, scope, square(16), 5), wireOf(module, scope, square(8), 10)]
      const maker = loftOf(module, scope, wires, true, false)
      expect(maker.IsDone()).toBe(true)
      const shape = scope.track(maker.Shape())
      // Two bands of four faces plus two caps.
      expect(canonicalFaces(module, scope, shape)).toHaveLength(10)
      expect(volumeOf(module, scope, shape)).toBeCloseTo(1606.6666666666667, 6)
      // BOTH bands come back from a FIRST-section edge (mid-heights 2.69 and
      // 7.22): the band set is not partitioned by section. Over the four edges
      // of the section that is eight distinct band faces.
      const perEdge = wireEdges(module, scope, wires[0]).map((edge) => {
        const faces = drainList(scope, maker.Generated(edge)).flatMap((g) => canonicalFaces(module, scope, g))
        return faces.map((f) => Math.round(faceCentroid(module, scope, f)[2]))
      })
      expect(perEdge).toHaveLength(4)
      for (const zs of perEdge) expect(zs.sort()).toEqual([3, 7])
    } finally {
      scope.dispose()
    }
  })

  it('smoothing a three-section loft runs one surface through every section', () => {
    const module = setup()
    const scope = new DisposeScope()
    try {
      const wires = [wireOf(module, scope, square(10), 0), wireOf(module, scope, square(16), 5), wireOf(module, scope, square(8), 10)]
      const maker = loftOf(module, scope, wires, false, true)
      expect(maker.IsDone()).toBe(true)
      const shape = scope.track(maker.Shape())
      expect(canonicalFaces(module, scope, shape)).toHaveLength(6)
      expect(volumeOf(module, scope, shape)).toBeCloseTo(1918.797527439778, 6)
      // One image per section edge: the single smooth band.
      const generated = wireEdges(module, scope, wires[0]).flatMap((edge) =>
        drainList(scope, maker.Generated(edge)).flatMap((g) => canonicalFaces(module, scope, g)),
      )
      expect(generated).toHaveLength(4)
    } finally {
      scope.dispose()
    }
  })

  it('accepts sections with different edge counts when asked to check compatibility', () => {
    const module = setup()
    const scope = new DisposeScope()
    try {
      const bottom = wireOf(module, scope, circle(5), 0)
      const top = wireOf(module, scope, square(10), 10)
      const maker = scope.track(new module.BRepOffsetAPI_ThruSections(true, false, 1e-6))
      maker.AddWire(bottom)
      maker.AddWire(top)
      maker.CheckCompatibility(true)
      maker.Build()
      expect(maker.IsDone()).toBe(true)
      const shape = scope.track(maker.Shape())
      expect(canonicalFaces(module, scope, shape)).toHaveLength(7)
      expect(volumeOf(module, scope, shape)).toBeCloseTo(895.2381598586524, 6)
    } finally {
      scope.dispose()
    }
  })
})
