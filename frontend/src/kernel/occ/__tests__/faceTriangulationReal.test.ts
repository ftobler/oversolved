// @vitest-environment node
//
// `tessellateFace` reads a face's triangulation in one `OversolvedMesh` call
// (r3 build helper) instead of six embind crossings per node and five per
// triangle. Its output feeds face_data, triangle_to_face, the classifiers and
// the action-matrix baseline, so the swap must be number for number. The old
// per-call reader is kept below as the reference.
//
// Skips when OCC is absent, like every *Real suite.

import { describe, it, expect } from 'vitest'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { makeBox, makeCylinder, tessellateFace } from '../primitives'
import { makeTranslationTrsf } from '../transforms'
import { MESH_PURPOSE_NONE } from '../defaultArgs'
import type { OccModule, OccOrientableShape, OccOrientedShape, OccShape, OccSubShape } from '../occTypes'
import type { Vec3 } from '../primitives'

const oc = await loadOcc()

// A forced collection for the heap test; the flag must be set before the
// context that hands out `gc` is made.
setFlagsFromString('--expose-gc')
const gc = runInNewContext('gc') as () => void

// The heap test's window. The leak it guards against keeps every read's
// buffer, about 15 MB over the measured passes; the bound sits well under that
// and well over the few hundred KB of process-wide noise a loaded CI runner
// adds (a 1 MB bound failed there at 1.4 MB with nothing retained).
const WARMUP_PASSES = 3
const MEASURED_PASSES = 50
const GROWTH_BOUND = 4 << 20

/**
 * The process's ArrayBuffer bytes once dead buffers are actually released.
 *
 * A forced `gc()` finds the dead typed arrays at once, but the counter is a
 * process-wide figure that other in-flight buffers (the worker's RPC to the
 * vitest host) also move, and it can lag the collection on a busy host. So
 * each sample yields to the event loop after collecting, and the lowest of a
 * few samples is the reading: transient bytes only ever raise a sample, while
 * retained bytes are in every one.
 */
async function settledArrayBuffers(): Promise<number> {
  let lowest = Infinity
  for (let sample = 0; sample < 3; sample++) {
    gc()
    await new Promise<void>((resolve) => setImmediate(resolve))
    lowest = Math.min(lowest, process.memoryUsage().arrayBuffers)
  }
  return lowest
}

const LINEAR = 0.1
const ANGULAR = 0.1
const FINE_LINEAR = 0.0005
const FINE_ANGULAR = 0.004

/** The per-call reader `tessellateFace` used before r3, verbatim in effect:
 *  location applied node by node, REVERSED winding flipped. */
function referenceRead(
  occ: OccModule,
  scope: DisposeScope,
  face: OccShape,
): { vertices: Vec3[]; triangles: [number, number, number][] } {
  const loc = scope.track(new occ.TopLoc_Location_1())
  const handle = scope.track(occ.BRep_Tool.Triangulation(face, loc, MESH_PURPOSE_NONE))
  if (handle.IsNull()) return { vertices: [], triangles: [] }
  const poly = handle.get()
  if (!poly) return { vertices: [], triangles: [] }
  const trsf = scope.track(loc.Transformation())
  const reverse = enumIs(occ, face)
  const vertices: Vec3[] = []
  for (let i = 1; i <= poly.NbNodes(); i++) {
    const n = poly.Node(i)
    n.Transform(trsf)
    vertices.push([n.X(), n.Y(), n.Z()])
    n.delete()
  }
  const triangles: [number, number, number][] = []
  for (let i = 1; i <= poly.NbTriangles(); i++) {
    const t = poly.Triangle(i)
    const a = t.Value(1) - 1
    const b = t.Value(2) - 1
    const c = t.Value(3) - 1
    t.delete()
    triangles.push(reverse ? [a, c, b] : [a, b, c])
  }
  return { vertices, triangles }
}

/** REVERSED orientation, read the way primitives.ts `isReversed` does. */
function enumIs(occ: OccModule, face: OccShape): boolean {
  return (face as OccOrientedShape).Orientation_1().value === occ.TopAbs_Orientation.TopAbs_REVERSED.value
}

function facesOf(occ: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  const E = occ.TopAbs_ShapeEnum
  const exp = scope.track(new occ.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  const out: OccShape[] = []
  for (; exp.More(); exp.Next()) out.push(scope.track(occ.TopoDS.Face_1(exp.Current())))
  return out
}

/** Every face of `shape`, read by the helper and by the reference, side by side. */
function expectParity(occ: OccModule, scope: DisposeScope, shape: OccShape): number {
  let reversed = 0
  for (const face of facesOf(occ, scope, shape)) {
    const bulk = tessellateFace(occ, scope, face, LINEAR, ANGULAR)
    const ref = referenceRead(occ, scope, face)
    expect(bulk.vertices.length).toBeGreaterThan(0)
    // toEqual on numbers is Object.is per element: bit for bit, not a tolerance.
    expect(bulk.vertices).toEqual(ref.vertices)
    expect(bulk.triangles).toEqual(ref.triangles)
    if (enumIs(occ, face)) reversed++
  }
  return reversed
}

describe.skipIf(!oc)('tessellateFace bulk read parity (real OCC)', () => {
  it('a box, including its REVERSED faces', () => {
    const scope = new DisposeScope()
    try {
      const reversed = expectParity(oc!, scope, makeBox(oc!, scope, 10, 20, 30))
      expect(reversed, 'a box has REVERSED faces, so the winding flip is exercised').toBeGreaterThan(0)
    } finally {
      scope.dispose()
    }
  })

  it('a cylinder, whose lateral face carries a seam', () => {
    const scope = new DisposeScope()
    try {
      expectParity(oc!, scope, makeCylinder(oc!, scope, [0, 0, 0], [0, 0, 1], 4, 12))
    } finally {
      scope.dispose()
    }
  })

  it('an explicitly reversed face flips its winding against the forward one', () => {
    const scope = new DisposeScope()
    try {
      const face = facesOf(oc!, scope, makeCylinder(oc!, scope, [0, 0, 0], [0, 0, 1], 4, 12))[0]
      // Reversed() hands back a plain TopoDS_Shape; the readers take a face.
      const flipped = scope.track(oc!.TopoDS.Face_1(scope.track((face as OccOrientableShape).Reversed())))
      const fwd = tessellateFace(oc!, scope, face, LINEAR, ANGULAR)
      const rev = tessellateFace(oc!, scope, flipped, LINEAR, ANGULAR)
      expect(rev).toEqual(referenceRead(oc!, scope, flipped))
      expect(rev.vertices).toEqual(fwd.vertices)
      expect(rev.triangles).toEqual(fwd.triangles.map(([a, b, c]) => [a, c, b]))
    } finally {
      scope.dispose()
    }
  })

  it('reading a large mesh over and over does not grow the heap', async () => {
    // The per-call reader made one heap proxy per node and per triangle (the
    // heap note this replaced); the helper copies into JS-owned arrays and frees
    // its buffer before returning. Mesh first, so the mesher's own growth is
    // out of the window, then read every face many times over. The module
    // exports no heap view, so this reads the process's ArrayBuffer bytes (as
    // solveLocallySoakReal does): the JS copies are collected, while wasm
    // memory never shrinks, so a retained per-read buffer stays as growth
    // (about 15 MB over these passes).
    const scope = new DisposeScope()
    try {
      const fine = makeCylinder(oc!, scope, [0, 0, 0], [0, 0, 1], 40, 80)
      const faces = facesOf(oc!, scope, fine)
      const readAll = (): number => {
        let triangles = 0
        for (const face of faces) triangles += tessellateFace(oc!, scope, face, FINE_LINEAR, FINE_ANGULAR).triangles.length
        return triangles
      }
      // Deflection is relative to the shape, so the angular bound sets the count.
      expect(readAll()).toBeGreaterThan(10_000)
      // A few reads before the baseline, so any one-time allocation on the
      // read path lands outside the window and only per-read growth is left.
      for (let pass = 0; pass < WARMUP_PASSES; pass++) readAll()
      const before = await settledArrayBuffers()
      for (let pass = 0; pass < MEASURED_PASSES; pass++) readAll()
      const growth = await settledArrayBuffers() - before
      expect(growth, `ArrayBuffer growth over ${MEASURED_PASSES} passes`).toBeLessThan(GROWTH_BOUND)
    } finally {
      scope.dispose()
    }
  })

  it('a located solid reads in world coordinates', () => {
    const scope = new DisposeScope()
    try {
      const box = makeBox(oc!, scope, 2, 2, 2)
      // copy=false keeps the TShape and carries the move as a TopLoc_Location,
      // the form a STEP assembly instance arrives in.
      const builder = scope.track(new oc!.BRepBuilderAPI_Transform_2(
        box, makeTranslationTrsf(oc!, scope, 10, 0, 0), false, false,
      ))
      const moved = builder.Shape()
      const [orig] = facesOf(oc!, scope, box)
      const [placed] = facesOf(oc!, scope, moved)
      expect((placed as unknown as OccSubShape).IsPartner(orig), 'same TShape: the move is a location').toBe(true)
      expectParity(oc!, scope, moved)
      const xs = tessellateFace(oc!, scope, placed, LINEAR, ANGULAR).vertices.map((v) => v[0])
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(10)
    } finally {
      scope.dispose()
    }
  })
})
