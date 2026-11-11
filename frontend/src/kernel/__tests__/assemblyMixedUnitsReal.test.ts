// @vitest-environment node
//
// A metric part and an imperial part in one assembly. The assembly document has
// no unit of its own and keeps the millimetre frame, while each part stores its
// numbers in its own unit. So two cubes with the same physical size enter the
// assembly at different part-to-assembly scales: the metric cube at 1, the
// imperial cube at 25.4 (1 inch per stored unit).
//
// The metric cube's sketch dimensions 25.4 mm and the imperial cube's sketch
// dimensions 1 inch; both are 25.4 mm on a side (16387.064 mm^3).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { loadOcc } from '../occ/loadOcc'
import { setSolveLocalsForTest, solveLocally, measureAssemblyLocally } from '../solveLocally'
import { setSketchSolver, resetSketchSolver } from '../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadPkgNodeExport, PKG_MATE } from '@/wasm-kernel/loadPkgNode'
import { handleBundleRequest } from '../worker/solverWorker'
import type { BundleRequest } from '../worker/solverProtocol'
import { solveAssembly, type MateSpec } from '../solveAssembly'
import { bundleCachePut, resetBundleDbConnection } from '../bundleCache'
import type { PartBundle } from '../partBundle'
import { partSolvePayload } from '@/drive/solveWriteBack'
import { rotateVector } from '@/utils/transform3d'
import { identity } from '@/__tests__/fixtures'
import type { PartDoc, Transform3D } from '@/types/cad'
import type { RelayService } from '../worker/solverProtocol'

const oc = await loadOcc()
const solveBytes = loadSolver()
const solveMate = loadPkgNodeExport<(input: Uint8Array) => Uint8Array>('solve_mate_bytes', PKG_MATE)
const describeReal = oc && solveBytes && solveMate ? describe : describe.skip

const SIDE_MM = 25.4
const UNIT_VOLUME = SIDE_MM ** 3  // 16387.064

/** A fully constrained square on the Front plane, pinned to `@builtin_origin`. */
function squareSketch(sketchId: string, side: number) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Square', plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: {
      bottom: [0, 0, side, 0], right: [side, 0, side, side],
      top: [side, side, 0, side], left: [0, side, 0, 0],
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
      { id: 'c9', kind: 'length' as const, target: { entity: 'bottom' }, value: side },
      { id: 'c10', kind: 'length' as const, target: { entity: 'left' }, value: side },
      { id: 'c11', kind: 'point_distance_x' as const, a: { entity: 'bottom', point: 'start' as const }, b: '@builtin_origin', value: 0, sign: -1 },
      { id: 'c12', kind: 'point_distance_y' as const, a: { entity: 'bottom', point: 'start' as const }, b: '@builtin_origin', value: 0, sign: -1 },
    ],
  }
}

function cubeDoc(side: number, unit?: 'inch'): PartDoc {
  return {
    version: 1,
    kind: 'part',
    ...(unit === 'inch' ? { length_unit: unit } : {}),
    features: [
      squareSketch('sk1', side),
      { id: 'ex1', kind: 'extrude', extrude: { sketch: '$sk1', distance: side, direction: 'normal', operation: 'new' } },
    ],
  } as PartDoc
}

const metricDoc = () => cubeDoc(SIDE_MM)
const inchDoc = () => cubeDoc(1, 'inch')

let nextBundleId = 1
function bundleReq(doc_id: string, content_hash: string, spec: Record<string, unknown>): BundleRequest {
  return { id: nextBundleId++, kind: 'buildBundle', spec: { ...spec, id: doc_id }, doc_id, content_hash }
}

async function buildBundle(doc: PartDoc, doc_id: string): Promise<PartBundle> {
  const res = await handleBundleRequest(bundleReq(doc_id, `hash-${doc_id}`, partSolvePayload(doc, doc_id)), solveLocally)
  if (!res.ok) throw new Error(`bundle build failed: ${res.error}`)
  return res.payload
}

function meshBbox(bundle: PartBundle): number[] {
  const out = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (const body of bundle.bodies) {
    const v = body.mesh.vertices
    for (let i = 0; i < v.length; i += 3) {
      for (let axis = 0; axis < 3; axis++) {
        out[axis] = Math.min(out[axis], v[i + axis])
        out[axis + 3] = Math.max(out[axis + 3], v[i + axis])
      }
    }
  }
  return out
}

/** The local plane anchor on the top or bottom face of an axis-aligned cube. */
function zFaceAnchor(bundle: PartBundle, side: 'min' | 'max'): string {
  let best: { id: string; z: number } | null = null
  for (const [id, anchor] of Object.entries(bundle.anchors)) {
    // The part-frame anchors (Origin, Front) are planes too and sit at z = 0;
    // created_by is empty on those and names the body on a face anchor.
    if (anchor.created_by === '') continue
    if (anchor.kind !== 'plane' || Math.abs(anchor.axis[2]) < 0.999) continue
    const z = anchor.point[2]
    if (best === null || (side === 'max' ? z > best.z : z < best.z)) best = { id, z }
  }
  if (best === null) throw new Error('no z-facing plane anchor')
  return best.id
}

function worldBbox(bundle: PartBundle, t: Transform3D): number[] {
  const out = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (const body of bundle.bodies) {
    const v = body.mesh.vertices
    for (let i = 0; i < v.length; i += 3) {
      const [x, y, z] = rotateVector([t.qx, t.qy, t.qz, t.qw], [v[i], v[i + 1], v[i + 2]])
      const p = [x + t.tx, y + t.ty, z + t.tz]
      for (let axis = 0; axis < 3; axis++) {
        out[axis] = Math.min(out[axis], p[axis])
        out[axis + 3] = Math.max(out[axis + 3], p[axis])
      }
    }
  }
  return out
}

function expectBbox(actual: number[], expected: number[]): void {
  expect(actual).toHaveLength(6)
  // Bundle meshes are f32, so a coordinate near 76 mm carries ~3e-6 of
  // rounding; the assembly geometry itself is f64.
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i], 4))
}

function expectIdentityRotation(t: Transform3D): void {
  // q and -q are the same rotation, so compare the absolute components.
  expect(Math.abs(t.qx)).toBeCloseTo(0, 9)
  expect(Math.abs(t.qy)).toBeCloseTo(0, 9)
  expect(Math.abs(t.qz)).toBeCloseTo(0, 9)
  expect(Math.abs(t.qw)).toBeCloseTo(1, 9)
}

const relay: RelayService = {
  requestPartDoc: async () => { throw new Error('bundles are pre-cached') },
  requestBuildBundle: async () => { throw new Error('bundles are pre-cached') },
}

interface AssemblyCase {
  metric: PartBundle
  inch: PartBundle
  fixedHandle: string
  movingHandle: string
  transforms: Record<string, Transform3D>
}

/** Solve the metric cube fixed at identity and the inch cube on its top face,
 *  or the same with the roles swapped. */
async function solveStack(opts: {
  fixed: 'metric' | 'inch'
  offset?: number
}): Promise<AssemblyCase> {
  const metric = await buildBundle(metricDoc(), 'metric')
  const inch = await buildBundle(inchDoc(), 'inch')
  await bundleCachePut(metric)
  await bundleCachePut(inch)

  const fixed = opts.fixed === 'metric' ? metric : inch
  const moving = opts.fixed === 'metric' ? inch : metric
  const fixedHandle = opts.fixed
  const movingHandle = opts.fixed === 'metric' ? 'inch' : 'metric'
  const movingDoc = opts.fixed === 'metric' ? 'inch' : 'metric'

  const parts = [
    { handle: fixedHandle, doc_id: fixedHandle, transform: identity(), fixed: true },
    { handle: movingHandle, doc_id: movingDoc, transform: { ...identity(), tx: 40, ty: 40, tz: 40 } },
  ]
  const mates: MateSpec[] = [{
    id: 'm1',
    kind: 'fixed',
    ref_a: { part: fixedHandle, anchor: zFaceAnchor(fixed, 'max') },
    ref_b: { part: movingHandle, anchor: zFaceAnchor(moving, 'min') },
    flip: true,
    // The two faces' canonical roll frames are half a turn apart, so 180
    // degrees is the authored angle that lands the square faces flush instead
    // of corner to corner. It is authored data, not a unit concern.
    angle: 180,
    ...(opts.offset === undefined ? {} : { offset: opts.offset }),
  }]

  const result = await solveAssembly(parts, { metric: 'hash-metric', inch: 'hash-inch' }, mates, relay, solveMate!)
  expect(result.status.mates.m1.stale).toBe(false)
  expect(result.status.mates.m1.error).toBeUndefined()
  expect(result.status.verdict).not.toBe('overconstrained')
  return { metric, inch, fixedHandle, movingHandle, transforms: result.transforms }
}

describeReal('assembly mixed units', () => {
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes!)
    setSolveLocalsForTest(async () => oc)
  })
  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    resetBundleDbConnection()
  })

  it('builds both parts at their physical size: 25.4 mm, one at part scale 1 and one at 25.4', async () => {
    const metric = await buildBundle(metricDoc(), 'metric')
    const inch = await buildBundle(inchDoc(), 'inch')

    // The bundle is what the assembly frame consumes, so both are already in
    // millimetres here: 1 stored inch becomes 25.4 mm.
    expectBbox(meshBbox(metric), [0, 0, 0, SIDE_MM, SIDE_MM, SIDE_MM])
    expectBbox(meshBbox(inch), [0, 0, 0, SIDE_MM, SIDE_MM, SIDE_MM])

    // The face anchor is a position, so it scales with the part; its normal
    // does not.
    const top = inch.anchors[zFaceAnchor(inch, 'max')]
    expect(top.point[2]).toBeCloseTo(SIDE_MM, 6)
    expect(top.axis).toEqual([0, 0, 1])
  }, 120_000)

  it('measures both placed instances at 25.4 mm and 16387.064 mm3', async () => {
    const metricSpec = partSolvePayload(metricDoc(), 'metric')
    const inchSpec = partSolvePayload(inchDoc(), 'inch')
    const measure = await measureAssemblyLocally([
      { handle: 'metric', spec: metricSpec, transform: identity() },
      { handle: 'inch', spec: inchSpec, transform: { ...identity(), tx: 50 } },
    ])
    expect(measure).not.toBeNull()
    expect(measure!.bodies).toBe(2)
    expect(measure!.volume).toBeCloseTo(2 * UNIT_VOLUME, 4)
    expectBbox(measure!.bbox!, [0, 0, 0, 50 + SIDE_MM, SIDE_MM, SIDE_MM])
    for (const body of measure!.perBody) expect(body.volume).toBeCloseTo(UNIT_VOLUME, 4)
  }, 180_000)

  it('mates the imperial cube flush onto the metric cube with no scale gap', async () => {
    const solved = await solveStack({ fixed: 'metric' })
    const metricBox = worldBbox(solved.metric, solved.transforms.metric)
    const inchBox = worldBbox(solved.inch, solved.transforms.inch)

    expectBbox(metricBox, [0, 0, 0, SIDE_MM, SIDE_MM, SIDE_MM])
    expectBbox(inchBox, [0, 0, SIDE_MM, SIDE_MM, SIDE_MM, 2 * SIDE_MM])
    // Coincident, not a 25.4 mm gap and not a 24.4 mm overlap.
    expect(inchBox[2] - metricBox[5]).toBeCloseTo(0, 5)
    expect(solved.transforms.inch.tx).toBeCloseTo(0, 6)
    expect(solved.transforms.inch.ty).toBeCloseTo(0, 6)
    expect(solved.transforms.inch.tz).toBeCloseTo(SIDE_MM, 6)
    expectIdentityRotation(solved.transforms.inch)
  }, 180_000)

  it('reads a mate offset as millimetres in either part unit context', async () => {
    // The assembly document has no length unit: its offsets and transforms are
    // millimetres. An offset authored with the imperial part on either side is
    // still 5 mm; if the part's inch context leaked in it would be 127 mm.
    const metricFixed = await solveStack({ fixed: 'metric', offset: 5 })
    const inchFixed = await solveStack({ fixed: 'inch', offset: 5 })

    for (const solved of [metricFixed, inchFixed]) {
      expect(solved.transforms[solved.movingHandle].tz).toBeCloseTo(SIDE_MM + 5, 6)
      expect(solved.transforms[solved.fixedHandle].tz).toBeCloseTo(0, 6)
    }
  }, 240_000)

  it('gives the same relative placement with the imperial cube fixed instead', async () => {
    const metricFixed = await solveStack({ fixed: 'metric', offset: 5 })
    const inchFixed = await solveStack({ fixed: 'inch', offset: 5 })

    const metricBoxA = worldBbox(metricFixed.metric, metricFixed.transforms.metric)
    const inchBoxA = worldBbox(metricFixed.inch, metricFixed.transforms.inch)
    const metricBoxB = worldBbox(inchFixed.metric, inchFixed.transforms.metric)
    const inchBoxB = worldBbox(inchFixed.inch, inchFixed.transforms.inch)

    expectBbox(metricBoxA, [0, 0, 0, SIDE_MM, SIDE_MM, SIDE_MM])
    expectBbox(inchBoxB, [0, 0, 0, SIDE_MM, SIDE_MM, SIDE_MM])
    // In both solves the moving cube sits 5 mm above the fixed one, with the
    // same 25.4 mm side: swapping which cube is grounded changes only the
    // world frame, not the relative placement.
    expectBbox(inchBoxA, [0, 0, SIDE_MM + 5, SIDE_MM, SIDE_MM, 2 * SIDE_MM + 5])
    expectBbox(metricBoxB, [0, 0, SIDE_MM + 5, SIDE_MM, SIDE_MM, 2 * SIDE_MM + 5])
  }, 240_000)
})
