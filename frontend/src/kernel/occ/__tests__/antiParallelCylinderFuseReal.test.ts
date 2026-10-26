// @vitest-environment node
//
// OCCT 7.4's ShapeUpgrade_UnifySameDomain spins forever when its face merge
// meets two coaxial, equal-radius partial cylinder faces whose axes run
// opposite ways (bug-fuse-hang, CadQuery Ex026 seam lip: the lip's inner r2
// walls stand on the shell cavity's r2 fillet walls, the cavity's axis +Y and
// the lip's -Y). The fuse itself returns at once; the clean after it never
// does. The boolean pipeline's cylinder canonicalization re-expresses such a
// face on its partner's axis, so the merge sees one surface and folds it.
//
// The smallest pair is two quarter sectors stacked on one axis. A hang cannot
// be interrupted in-process (synchronous WASM), so the fuse test refuses to
// run the clean unless the canonicalization already aligned the axes, and the
// whole-document case runs in the SIGKILL-guarded solve child.
//
// Skips when OCC.js is absent.
import { readFileSync } from 'node:fs'
import { describe, it, expect, afterAll } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { makeBoxAt, makeCylinder, faceSurfaceFrame } from '../primitives'
import { booleanWithDiff, booleanWithHistory, countSubShapes, shapeIsValid, volumeOf } from '../booleans'
import { canonicalizeCylinderFaces } from '../canonicalSurfaces'
import type { OccModule, OccShape } from '../occTypes'
import { solveWithTimeout, disposeWorker } from '../../solveTimeout'
import { partSpecFromText } from '@/utils/partExport'
import { loadSolver } from '@/wasm-kernel/loadSolver'

const oc = await loadOcc()
const solveBytes = loadSolver()

type V3 = [number, number, number]

/** A quarter of an r2 cylinder about the y axis (x, z in [0, 2]), spanning
 *  `y0..y0+h`, built on a cylinder whose axis points `axisSign` * Y. */
function quarterSector(oc2: OccModule, scope: DisposeScope, y0: number, h: number, axisSign: 1 | -1): OccShape {
  const base: V3 = axisSign > 0 ? [0, y0, 0] : [0, y0 + h, 0]
  const cyl = makeCylinder(oc2, scope, base, [0, axisSign, 0], 2, h)
  scope.track(cyl)
  const quadrant = makeBoxAt(oc2, scope, [0, y0 - 1, 0], 3, h + 2, 3)
  scope.track(quadrant)
  const r = booleanWithHistory(oc2, scope, cyl, quadrant, 'common').shape
  return scope.track(r)
}

/** The axis direction of every cylinder face of `shape`. */
function cylinderAxes(oc2: OccModule, scope: DisposeScope, shape: OccShape): V3[] {
  const E = oc2.TopAbs_ShapeEnum
  const exp = scope.track(new oc2.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  const axes: V3[] = []
  for (; exp.More(); exp.Next()) {
    const face = scope.track(oc2.TopoDS.Face_1(exp.Current()))
    const frame = faceSurfaceFrame(oc2, scope, face)
    if (frame && frame.radius !== undefined) axes.push(frame.axis)
  }
  return axes
}

const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const allAligned = (axes: V3[]): boolean => axes.every((a) => dot(a, axes[0]) > 0)

describe.skipIf(!oc)('fuse of coaxial cylinder walls with opposite axes (real OCC)', () => {
  it('canonicalization puts both stacked walls on one axis direction', () => {
    const scope = new DisposeScope()
    try {
      const raw = scope.track(booleanWithHistory(
        oc!, scope, quarterSector(oc!, scope, 0, 10, 1), quarterSector(oc!, scope, 10, 1, -1), 'fuse',
      ).shape)
      // Precondition: the raw fuse carries the anti-parallel pair the hang needs.
      const before = cylinderAxes(oc!, scope, raw)
      expect(before).toHaveLength(2)
      expect(allAligned(before)).toBe(false)

      const result = canonicalizeCylinderFaces(oc!, scope, raw)
      expect(result.changed).toBe(true)
      const after = cylinderAxes(oc!, scope, result.shape)
      expect(after).toHaveLength(2)
      expect(allAligned(after)).toBe(true)
      expect(shapeIsValid(oc!, scope, result.shape)).toBe(true)
      expect(volumeOf(oc!, scope, result.shape)).toBeCloseTo(11 * Math.PI, 9)
    } finally {
      scope.dispose()
    }
  })

  it('the fuse finishes in under 2 s and folds each stacked wall into one face', () => {
    const scope = new DisposeScope()
    try {
      const a = quarterSector(oc!, scope, 0, 10, 1)
      const b = quarterSector(oc!, scope, 10, 1, -1)
      // The clean below spins forever while the axes still disagree, and no
      // test timeout can interrupt it, so it only runs once they agree.
      const raw = scope.track(booleanWithHistory(oc!, scope, a, b, 'fuse').shape)
      const aligned = canonicalizeCylinderFaces(oc!, scope, raw)
      if (!allAligned(cylinderAxes(oc!, scope, aligned.shape))) {
        throw new Error('the walls still have opposite axes: the clean would hang, so it is not run')
      }
      const t0 = performance.now()
      const fused = booleanWithDiff(oc!, scope, a, b, 'fuse')
      const ms = performance.now() - t0
      scope.track(fused.shape)
      expect(ms).toBeLessThan(2000)
      expect(volumeOf(oc!, scope, fused.shape)).toBeCloseTo(11 * Math.PI, 9)
      expect(shapeIsValid(oc!, scope, fused.shape)).toBe(true)
      // One wall, two radial planes, the bottom and the top cap.
      expect(countSubShapes(oc!, scope, fused.shape, oc!.TopAbs_ShapeEnum.TopAbs_FACE)).toBe(5)
    } finally {
      scope.dispose()
    }
  })
})

// The reported document: a filleted box shelled 2 outward, and a 1 mm lip
// ring between the cavity outline (20x20 r2) and a 22x22 r3 outline extruded
// onto the rim as add (repro (a) of the report, with the closing arc drawn).
const SHELL_LIP = readFileSync(new URL('../__fixtures__/shell-lip-coincident-fillet.yaml', import.meta.url), 'utf8')

interface BodyView {
  mesh?: { face_queries?: string[] }
}

describe.skipIf(!oc || !solveBytes)('shell lip on the cavity fillet walls (real OCC, solve child)', () => {
  it('the lip extrude answers ok and folds every lip wall into its cavity wall', async () => {
    const spec = partSpecFromText(SHELL_LIP)
    // A hang rejects with the child's timeout instead of wedging the fork.
    const result = await solveWithTimeout(spec, undefined, 30000)
    if (result === null) throw new Error('OCC.js is unavailable in the solve child')
    const features = result.result as Record<string, { status?: string }>
    expect(features.ex2?.status).toBe('ok')
    const body = (result.bodies as Record<string, BodyView>).body_ex1
    // 52 raw faces less the eight lip walls merged into the cavity walls.
    expect(body?.mesh?.face_queries).toHaveLength(44)
  }, 60000)
})

afterAll(() => {
  disposeWorker()
})
