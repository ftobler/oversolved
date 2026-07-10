// @vitest-environment node
//
// End-to-end gated test for assembly export (exportAssemblyLocally): rebuild two
// part documents, place each at its solved transform, and serialise the compound.
// This is the one path in the assembly feature that touches OCC after the bundle
// is built, so it is only meaningfully covered against the real kernel.
//
// Skips when OCC.js or the Rust sketch solver is absent. Install OCC with:
//   cd frontend && npm run occ:install

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadOcc } from './occ/loadOcc'
import { DisposeScope } from './occ/disposeScope'
import { stepBytesToShape } from './occ/stepIo'
import { volumeOf } from './occ/booleans'
import { readSolidVertices } from './occ/primitives'
import { exportAssemblyLocally, setSolveLocalsForTest } from './solveLocally'
import { setSketchSolver, resetSketchSolver } from './features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { IDENTITY_TRANSFORM, quatFromAxisAngle, rotateVector, type Vec3 } from '@/utils/transform3d'
import type { OccModule } from './occ/occTypes'
import type { Transform3D } from '@/types/cad'

const oc = await loadOcc()
const solveBytes = loadSolver()

function rectSketch(sketchId: string, w: number, h: number, plane = '@builtin_plane_front') {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane,
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: { bottom: [0, 0, w, 0], right: [w, 0, w, h], top: [w, h, 0, h], left: [0, h, 0, 0] },
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

function extrude(sketchId: string, id: string, distance: number): Record<string, unknown> {
  return { id, kind: 'extrude', sketch: '$' + sketchId, distance, direction: 'normal', operation: 'new' }
}

// Two single-body parts, each an axis-aligned box.
const VOL_A = 10 * 10 * 5
const VOL_B = 6 * 6 * 4

function partA() {
  return { id: 'partA', features: [rectSketch('skA', 10, 10), extrude('skA', 'exA', 5)] }
}

function partB() {
  return { id: 'partB', features: [rectSketch('skB', 6, 6), extrude('skB', 'exB', 4)] }
}

function placed(tx: number, ty: number, tz: number): Transform3D {
  return { ...IDENTITY_TRANSFORM, tx, ty, tz }
}

interface Bbox { min: Vec3; max: Vec3 }

/** The B-rep vertex AABB. A box's vertex set IS its AABB corners, exactly. */
function bboxOf(occ: OccModule, scope: DisposeScope, bytes: Uint8Array): Bbox {
  const shape = scope.track(stepBytesToShape(occ, scope, bytes))
  const verts = readSolidVertices(occ, scope, shape)
  expect(verts.length).toBeGreaterThan(0)
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const v of verts) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], v[i])
      max[i] = Math.max(max[i], v[i])
    }
  }
  return { min, max }
}

function expectVecClose(a: Vec3, b: Vec3, digits = 4) {
  for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i], digits)
}

function stlTriangleCount(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = view.getUint32(80, true)
  expect(bytes.length).toBe(84 + count * 50)
  return count
}

describe.skipIf(!oc || !solveBytes)('exportAssemblyLocally (real OCC + Rust solver)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
    resetSketchSolver()
    setSketchSolver(solveBytes)
    setSolveLocalsForTest(async () => oc)
  })
  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  it('STEP-exports two parts as one compound whose volume is their sum', async () => {
    const scope = new DisposeScope()
    try {
      const bytes = await exportAssemblyLocally(
        [
          { spec: partA(), transform: IDENTITY_TRANSFORM },
          { spec: partB(), transform: placed(100, 0, 0) },
        ],
        { format: 'step' },
      )
      expect(bytes).not.toBeNull()
      const text = new TextDecoder().decode(bytes!)
      expect(text).toContain('ISO-10303-21')

      const shape = scope.track(stepBytesToShape(occ, scope, bytes!))
      // A compound's volume is the sum of its solids', whether or not they overlap.
      expect(volumeOf(occ, scope, shape)).toBeCloseTo(VOL_A + VOL_B, 1)
    } finally {
      scope.dispose()
    }
  })

  it('places each part at its transform: the union AABB spans both positions', async () => {
    const scope = new DisposeScope()
    try {
      const alone = await exportAssemblyLocally([{ spec: partA(), transform: IDENTITY_TRANSFORM }], { format: 'step' })
      const both = await exportAssemblyLocally(
        [
          { spec: partA(), transform: IDENTITY_TRANSFORM },
          { spec: partA(), transform: placed(100, 0, 0) },
        ],
        { format: 'step' },
      )
      const one = bboxOf(occ, scope, alone!)
      const two = bboxOf(occ, scope, both!)
      // The first copy sets the lower bound; the second, shifted +100 in x, the upper.
      expectVecClose(two.min, one.min)
      expectVecClose(two.max, [one.max[0] + 100, one.max[1], one.max[2]])
    } finally {
      scope.dispose()
    }
  })

  it('rotates a part about its own origin before translating it', async () => {
    const scope = new DisposeScope()
    try {
      const q = quatFromAxisAngle([0, 0, 1], Math.PI / 2)
      const transform: Transform3D = { tx: 7, ty: 0, tz: 0, qx: q[0], qy: q[1], qz: q[2], qw: q[3] }
      const alone = await exportAssemblyLocally([{ spec: partA(), transform: IDENTITY_TRANSFORM }], { format: 'step' })
      const moved = await exportAssemblyLocally([{ spec: partA(), transform }], { format: 'step' })

      const rest = bboxOf(occ, scope, alone!)
      const actual = bboxOf(occ, scope, moved!)

      // A box's 8 vertices are exactly its AABB corners, so pushing those corners
      // through `rotate(q, p) + t` predicts the placed AABB exactly. This is the
      // assertion that would fail if gp_Trsf.Multiply composed the other way:
      // translate-then-rotate would swing the part around the world origin.
      const expMin: Vec3 = [Infinity, Infinity, Infinity]
      const expMax: Vec3 = [-Infinity, -Infinity, -Infinity]
      for (let c = 0; c < 8; c++) {
        const corner: Vec3 = [
          c & 1 ? rest.max[0] : rest.min[0],
          c & 2 ? rest.max[1] : rest.min[1],
          c & 4 ? rest.max[2] : rest.min[2],
        ]
        const r = rotateVector(q, corner)
        for (let i = 0; i < 3; i++) {
          const w = r[i] + (i === 0 ? transform.tx : 0)
          expMin[i] = Math.min(expMin[i], w)
          expMax[i] = Math.max(expMax[i], w)
        }
      }
      expectVecClose(actual.min, expMin)
      expectVecClose(actual.max, expMax)
    } finally {
      scope.dispose()
    }
  })

  it('STL-exports the whole assembly: two boxes carry twice one box of triangles', async () => {
    const one = await exportAssemblyLocally([{ spec: partA(), transform: IDENTITY_TRANSFORM }], { format: 'stl', tessellation: 0.5 })
    const two = await exportAssemblyLocally(
      [
        { spec: partA(), transform: IDENTITY_TRANSFORM },
        { spec: partB(), transform: placed(100, 0, 0) },
      ],
      { format: 'stl', tessellation: 0.5 },
    )
    expect(stlTriangleCount(one!)).toBeGreaterThanOrEqual(12)
    expect(stlTriangleCount(two!)).toBe(stlTriangleCount(one!) * 2)  // two boxes, 12 triangles each
  })

  it('returns null for an assembly with no parts', async () => {
    expect(await exportAssemblyLocally([], { format: 'step' })).toBeNull()
  })

  it('skips a part with no solid rather than failing the whole export', async () => {
    const scope = new DisposeScope()
    try {
      const sketchOnly = { id: 'sketchOnly', features: [rectSketch('skC', 4, 4)] }
      const bytes = await exportAssemblyLocally(
        [
          { spec: sketchOnly, transform: IDENTITY_TRANSFORM },
          { spec: partA(), transform: IDENTITY_TRANSFORM },
        ],
        { format: 'step' },
      )
      expect(bytes).not.toBeNull()
      const shape = scope.track(stepBytesToShape(occ, scope, bytes!))
      expect(volumeOf(occ, scope, shape)).toBeCloseTo(VOL_A, 1)
    } finally {
      scope.dispose()
    }
  })

  it('returns null when no part has a solid', async () => {
    const sketchOnly = { id: 'sketchOnly', features: [rectSketch('skC', 4, 4)] }
    expect(await exportAssemblyLocally([{ spec: sketchOnly, transform: IDENTITY_TRANSFORM }], { format: 'step' }))
      .toBeNull()
  })
})
