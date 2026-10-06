// @vitest-environment node
//
// `bodyFrame` on a body with an imported-assembly-sized edge count.
//
// A real multi-part STEP assembly carries tens of thousands of edges, and the
// AABB fold used to merge the two point clouds with `points.push(...samples)`.
// That passes one argument per point, so past the engine's argument limit it
// threw `RangeError: Maximum call stack size exceeded` -- out of EVERY
// identification path (`solidToMesh`, `readShapeFaceMetadata`, `solidToEdges`),
// each of which sits inside the per-body catch in `tessellateBodies` /
// `extractBrepMetadata`. The import therefore "succeeded" with zero bodies and
// no error: a silently empty part.
//
// Always-on (no opencascade.js gate): `bodyFrame` only walks the explorer and
// the curve adaptor, so a stub module drives it at a scale a real OCC build
// could not reach in a unit test.

import { describe, it, expect } from 'vitest'
import { DisposeScope } from '../disposeScope'
import { bodyFrame } from '../tessellation'
import type { OccModule, OccShape } from '../occTypes'

// One stub sub-shape per topological entity. `HashCode`/`IsSame` are what
// SubShapeDedup keys on; a unique id per entity means nothing dedups away.
interface StubShape { id: number; kind: 'vertex' | 'edge'; pt: [number, number, number] }

function stubSub(s: StubShape) {
  return {
    ...s,
    HashCode: () => s.id,
    IsSame: (o: { id: number }) => o.id === s.id,
  }
}

/**
 * A stub OCC module exposing exactly the surface `bodyFrame` walks:
 * a vertex/edge explorer, `BRep_Tool.Pnt`, and a curve adaptor. Every edge
 * reports as a non-line so it contributes the full 17-sample fan, which is how
 * the real point count explodes on an imported assembly.
 */
function stubOcc(vertices: number, edges: number): { oc: OccModule; solid: OccShape } {
  const VERTEX = 'v'
  const EDGE = 'e'
  const verts: StubShape[] = []
  for (let i = 0; i < vertices; i++) verts.push({ id: i, kind: 'vertex', pt: [i, -i, 0] })
  const eds: StubShape[] = []
  for (let i = 0; i < edges; i++) eds.push({ id: 1e6 + i, kind: 'edge', pt: [0, 0, i] })

  class Explorer {
    private readonly items: StubShape[]
    private i = 0
    constructor(_shape: unknown, kind: unknown) {
      this.items = kind === VERTEX ? verts : kind === EDGE ? eds : []
    }
    More(): boolean { return this.i < this.items.length }
    Next(): void { this.i++ }
    Current(): StubShape { return this.items[this.i] }
    delete(): void {}
  }

  const oc = {
    TopAbs_ShapeEnum: { TopAbs_VERTEX: VERTEX, TopAbs_EDGE: EDGE, TopAbs_SHAPE: 's' },
    TopExp_Explorer_2: Explorer,
    TopoDS: {
      Vertex_1: (s: StubShape) => stubSub(s),
      Edge_1: (s: StubShape) => stubSub(s),
    },
    BRep_Tool: {
      // By-value gp_Pnt proxy: the reader deletes it after reading.
      Pnt: (v: StubShape) => ({ X: () => v.pt[0], Y: () => v.pt[1], Z: () => v.pt[2], delete: (): void => {} }),
    },
    // Each edge runs one unit along +z from its base point, so the edge samples
    // own the z extent outright and never disturb the vertices' x/y box.
    BRepAdaptor_Curve_2: class {
      private readonly e: StubShape
      constructor(e: StubShape) { this.e = e }
      GetType() { return { value: 'bspline' } }
      FirstParameter(): number { return 0 }
      LastParameter(): number { return 1 }
      Value(u: number) {
        const p = this.e.pt
        return { X: () => p[0], Y: () => p[1], Z: () => p[2] + u, delete: (): void => {} }
      }
      delete(): void {}
    },
    GeomAbs_CurveType: { GeomAbs_Line: { value: 'line' } },
  } as unknown as OccModule

  return { oc, solid: {} as OccShape }
}

describe('bodyFrame on an assembly-sized body', () => {
  it('folds a point count past the spread-argument limit without overflowing', () => {
    // 20k edges x 17 samples = 340k points, comfortably past the ~125k
    // argument ceiling that used to throw.
    const { oc, solid } = stubOcc(2000, 20000)
    const scope = new DisposeScope()
    try {
      const frame = bodyFrame(oc, scope, solid)
      // Vertices span x in [0, 1999] and y in [-1999, 0]; edges span z in
      // [0, 20000] (base 19999 plus the sample that runs one unit past it).
      expect(frame.half[0]).toBeCloseTo(1999 / 2, 6)
      expect(frame.half[1]).toBeCloseTo(1999 / 2, 6)
      expect(frame.half[2]).toBeCloseTo(20000 / 2, 6)
      expect(frame.center[2]).toBeCloseTo(10000, 6)
    } finally {
      scope.dispose()
    }
  })

  it('still degrades to a zero frame on a body with no points at all', () => {
    const { oc, solid } = stubOcc(0, 0)
    const scope = new DisposeScope()
    try {
      expect(bodyFrame(oc, scope, solid)).toEqual({ center: [0, 0, 0], half: [0, 0, 0] })
    } finally {
      scope.dispose()
    }
  })
})
