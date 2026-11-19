// @vitest-environment node
//
// Real-OCC tests for the coaxial-seam rule in canonicalSurfaces.ts. Two
// analytic cylinder faces can sit on the same infinite cylinder yet carry
// different X directions, so their pcurves run in different u ranges and
// UnifySameDomain cannot fold the boundary where they meet. The pass rebuilds
// the whole cluster onto the anchor's seam in that case.
//
// The report document (six bores and six coaxial tubes) pins the end-to-end
// result: on the shipped OCCT 8 kernel every inner joint already folds to 18
// circles, and the seam rule still removes one split cylinder pair (26 -> 25
// faces) without moving the volume. The focused fixture is the direct proof:
// it builds the mismatched seams deliberately, since a sketch plane cannot set
// a cylinder seam.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { faceCylinderXDirection, readSolidEdges } from '../primitives'
import { booleanWithHistoryMany, cleanWithHistory } from '../booleans'
import { canonicalizeCylinderFaces } from '../canonicalSurfaces'
import { volumeOfDefault } from '../volume'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { setSketchSolver, resetSketchSolver } from '@/kernel/features/sketch'
import { solveLocally, setSolveLocalsForTest, persistentTableForTest } from '@/kernel/solveLocally'
import { partSpecFromText } from '@/utils/partExport'
import type { OccModule, OccShape } from '../occTypes'

const oc = await loadOcc()
const solveBytes = loadSolver()

const JOINT_CENTRES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 5, 0], [0, -5, 0],
  [5, 0, 0], [-5, 0, 0],
  [0, 0, 5], [0, 0, -5],
]

interface CylinderFace {
  xDir: [number, number, number]
  loc: [number, number, number]
}

/** The r4 (or given radius) analytic cylinder faces of a solid. */
function cylinderFaces(
  oc2: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  radius: number,
): CylinderFace[] {
  const E = oc2.TopAbs_ShapeEnum
  const exp = scope.track(new oc2.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  const out: CylinderFace[] = []
  for (; exp.More(); exp.Next()) {
    const face = scope.track(oc2.TopoDS.Face_1(exp.Current()))
    const ad = scope.track(new oc2.BRepAdaptor_Surface_2(face, false))
    if (ad.GetType().value !== oc2.GeomAbs_SurfaceType.GeomAbs_Cylinder.value) continue
    const cyl = scope.track(ad.Cylinder())
    if (Math.abs(cyl.Radius() - radius) > 1e-9) continue
    // Use the production reader so a wrong-component bug cannot pass this
    // fixture by comparing the same wrong vector on both faces.
    const xDir = faceCylinderXDirection(oc2, scope, face)
    if (xDir === null) continue
    const pos = cyl.Position()
    const loc = pos.Location()
    out.push({ xDir, loc: [loc.X(), loc.Y(), loc.Z()] })
    loc.delete()
    pos.delete()
  }
  return out
}

function isValid(oc2: OccModule, scope: DisposeScope, shape: OccShape): boolean {
  return scope.track(new oc2.BRepCheck_Analyzer(shape, true, false, false)).IsValid_2()
}

function close(volume: number, expected: number): void {
  // The guard's own tolerance is 1e-6 relative; the pre-change build volume is
  // the expected value, so the geometry must not move at all.
  expect(Math.abs(volume - expected)).toBeLessThan(1e-6 * Math.abs(expected))
}

/**
 * A box with an r4 bore cut from below and a coaxial r4.5/r4 tube added from
 * above. The two inner cylinders use the frames given, so two different X
 * directions place their seams apart while the faces stay one geometric
 * cylinder. An r4 bore and tube joined through the same frame is the control.
 */
function coaxialJoint(
  oc2: OccModule,
  scope: DisposeScope,
  tubeXDir: [number, number, number],
): OccShape {
  const cyl = (z: number, radius: number, height: number, xDir: [number, number, number]): OccShape => {
    const ax2 = scope.track(new oc2.gp_Ax2_2(
      scope.track(new oc2.gp_Pnt_3(10, 10, z)),
      scope.track(new oc2.gp_Dir_5(0, 0, 1)),
      scope.track(new oc2.gp_Dir_5(xDir[0], xDir[1], xDir[2])),
    ))
    return scope.track(new oc2.BRepPrimAPI_MakeCylinder_3(ax2, radius, height)).Shape()
  }
  const box = scope.track(new oc2.BRepPrimAPI_MakeBox_2(20, 20, 10)).Shape()
  const bore = cyl(-1, 4, 12, [1, 0, 0])
  const cut = scope.track(booleanWithHistoryMany(oc2, scope, box, [bore], 'cut').shape)
  const tube = scope.track(
    booleanWithHistoryMany(oc2, scope, cyl(10, 4.5, 10, tubeXDir), [cyl(10, 4, 10, tubeXDir)], 'cut').shape,
  )
  return scope.track(booleanWithHistoryMany(oc2, scope, cut, [tube], 'fuse').shape)
}

describe.skipIf(!oc)('canonicalizeCylinderFaces coaxial seam', () => {
  it('rebuilds a same-direction cluster whose analytic faces disagree on the seam', () => {
    const scope = new DisposeScope()
    try {
      const shape = coaxialJoint(oc!, scope, [1, 1, 0])
      const before = cylinderFaces(oc!, scope, shape, 4)
      expect(before).toHaveLength(2)
      // Precondition: the two frames really do place different seams, or the
      // fixture would not exercise the rule.
      expect(Math.abs(before[0].xDir[0] * before[1].xDir[0]
        + before[0].xDir[1] * before[1].xDir[1]
        + before[0].xDir[2] * before[1].xDir[2])).toBeLessThan(0.99)
      const volume = volumeOfDefault(oc!, scope, shape)

      const result = canonicalizeCylinderFaces(oc!, scope, shape)
      expect(result.changed).toBe(true)
      expect(result.swaps).toHaveLength(2)
      expect(isValid(oc!, scope, result.shape)).toBe(true)
      close(volumeOfDefault(oc!, scope, result.shape), volume)
      // Both faces now carry the anchor's seam; the following clean folds the
      // pair into one cylinder face.
      const rebuilt = cylinderFaces(oc!, scope, result.shape, 4)
      expect(rebuilt).toHaveLength(2)
      expect(rebuilt[0].xDir).toEqual(rebuilt[1].xDir)
      const cleaned = scope.track(cleanWithHistory(oc!, scope, result.shape).shape)
      expect(cylinderFaces(oc!, scope, cleaned, 4)).toHaveLength(1)
      expect(isValid(oc!, scope, cleaned)).toBe(true)
      close(volumeOfDefault(oc!, scope, cleaned), volume)
    } finally {
      scope.dispose()
    }
  })

  it('leaves a same-seam pair alone, even at different axial locations', () => {
    // The rejected alternative compared the gp_Ax3 locations. The bore's
    // cylinder is at z=-1 and the tube's at z=10, so such a rule would rebuild
    // this pair; the seam predicate must not.
    const scope = new DisposeScope()
    try {
      const shape = coaxialJoint(oc!, scope, [1, 0, 0])
      const before = cylinderFaces(oc!, scope, shape, 4)
      expect(before).toHaveLength(2)
      expect(before[0].xDir).toEqual(before[1].xDir)
      expect(before[0].loc[2]).not.toBeCloseTo(before[1].loc[2], 6)
      const edgesBefore = readSolidEdges(oc!, scope, shape).length
      const volume = volumeOfDefault(oc!, scope, shape)

      const result = canonicalizeCylinderFaces(oc!, scope, shape)
      expect(result.changed).toBe(false)
      expect(result.swaps).toHaveLength(0)
      expect(result.shape).toBe(shape)
      expect(cylinderFaces(oc!, scope, result.shape, 4)).toHaveLength(2)
      expect(readSolidEdges(oc!, scope, result.shape).length).toBe(edgesBefore)
      expect(isValid(oc!, scope, result.shape)).toBe(true)
      close(volumeOfDefault(oc!, scope, result.shape), volume)
    } finally {
      scope.dispose()
    }
  })

  it('does not rebuild a cluster that is already one surface', () => {
    const scope = new DisposeScope()
    try {
      const shape = coaxialJoint(oc!, scope, [1, 0, 0])
      // Without a seam disagreement the clean does the whole job: one cylinder
      // face across the joint, and no rebuild on a second pass.
      const cleaned = scope.track(cleanWithHistory(oc!, scope, shape).shape)
      expect(cylinderFaces(oc!, scope, cleaned, 4)).toHaveLength(1)
      expect(isValid(oc!, scope, cleaned)).toBe(true)
      const volume = volumeOfDefault(oc!, scope, cleaned)
      const result = canonicalizeCylinderFaces(oc!, scope, cleaned)
      expect(result.changed).toBe(false)
      expect(cylinderFaces(oc!, scope, result.shape, 4)).toHaveLength(1)
      expect(isValid(oc!, scope, result.shape)).toBe(true)
      close(volumeOfDefault(oc!, scope, result.shape), volume)
    } finally {
      scope.dispose()
    }
  })
})

describe.skipIf(!oc || !solveBytes)('coaxial joins in the pipes report document', () => {
  let response: Awaited<ReturnType<typeof solveLocally>> = null

  beforeAll(async () => {
    resetSketchSolver()
    setSketchSolver(solveBytes!)
    setSolveLocalsForTest(async () => oc)
  })
  afterAll(() => {
    setSolveLocalsForTest(null)
    resetSketchSolver()
  })

  function finalPartShape(): OccShape {
    const state = response?._build_state as unknown as {
      feature_order: string[]
      checkpoints: Record<string, { body_store_snapshot: Record<string, { shape: number | null }> }>
    }
    const last = state.feature_order[state.feature_order.length - 1]
    const store = state.checkpoints[last].body_store_snapshot
    const part = Object.values(store).find((entry) => entry.shape !== null)
    expect(part, 'the report document must build one part').toBeDefined()
    const table = persistentTableForTest()
    return table!.get<OccShape>(part!.shape as never)
  }

  async function buildOnce(): Promise<OccShape> {
    if (response === null) {
      const text = readFileSync(
        new URL('../../../../regressions/coaxial-tube-joins/recipe.yaml', import.meta.url),
        'utf8',
      )
      response = await solveLocally(partSpecFromText(text))
    }
    // The shape is owned by the persistent cross-solve table, not by a scope
    // here, so it stays live for every test in this describe.
    return finalPartShape()
  }

  it('folds every inner r4 joint, leaving the far caps and tube openings', async () => {
    const shape = await buildOnce()
    const scope = new DisposeScope()
    try {
      const edges = readSolidEdges(oc!, scope, shape)
      const circles = edges
        .map((e) => e.ed)
        .filter((ed) => ed.kind === 'circle') as unknown as Array<{ center: number[]; radius: number }>
      // Six tubes x four circles (two at the far cap, the r4.5 face circle and
      // the r4 joint) minus the six folded inner joints.
      expect(circles).toHaveLength(18)
      for (const centre of JOINT_CENTRES) {
        const atJoint = circles.some((circle) =>
          Math.abs(circle.radius - 4) < 1e-9 &&
          Math.hypot(
            circle.center[0] - centre[0],
            circle.center[1] - centre[1],
            circle.center[2] - centre[2],
          ) < 1e-6,
        )
        expect(atJoint, `r4 circle at joint ${centre.join(',')}`).toBe(false)
      }
      // The seam rule removes one split cylinder pair the circles do not show.
      expect(edges).toHaveLength(73)
      expect(scope.track(new oc!.BRepCheck_Analyzer(shape, true, false, false)).IsValid_2()).toBe(true)
      close(volumeOfDefault(oc!, scope, shape), 1017.2189985477036)
    } finally {
      scope.dispose()
    }
  })

  it('gives all six joins the same topology', async () => {
    const shape = await buildOnce()
    const scope = new DisposeScope()
    try {
      const circles = readSolidEdges(oc!, scope, shape)
        .map((e) => e.ed)
        .filter((ed) => ed.kind === 'circle') as unknown as Array<{ center: number[]; radius: number }>
      const jointStates = JOINT_CENTRES.map((centre) =>
        circles.some((circle) =>
          Math.abs(circle.radius - 4) < 1e-9 &&
          Math.hypot(
            circle.center[0] - centre[0],
            circle.center[1] - centre[1],
            circle.center[2] - centre[2],
          ) < 1e-6,
        ),
      )
      // A total-only check would pass a fix that moved the seam from +Y to -Y.
      expect(new Set(jointStates).size).toBe(1)
      expect(jointStates.every((kept) => !kept)).toBe(true)
    } finally {
      scope.dispose()
    }
  })
})
