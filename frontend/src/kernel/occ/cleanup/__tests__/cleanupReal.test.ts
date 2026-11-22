// @vitest-environment node
//
// Real-OCC tests for the cleanup layer's presets.
//
// The BOOLEAN case is a byte-identical move check: the layer's plan must return
// the same topology, volume and composed diff as the old inline composition
// (cylinder canonicalisation, clean, compose) run side by side in this test.
// The MODIFIER case pins the difference the layer adds: an edge-only merge
// folds a split straight edge without folding a face on the fillet.

import { describe, it, expect } from 'vitest'
import { loadOcc } from '../../loadOcc'
import { DisposeScope } from '../../disposeScope'
import {
  booleanWithHistoryMany,
  cleanWithHistory,
  composeDiffThroughClean,
  composeOriginThroughClean,
  countSubShapes,
  shapeIsValid,
} from '../../booleans'
import { canonicalizeCylinderFaces } from '../../canonicalSurfaces'
import { applyFilletWithDiff, exploreEdges } from '../../edgeModifier'
import { mapDiffThroughRebase, mapOriginThroughRebase } from '../compose'
import { volumeOfDefault } from '../../volume'
import { emptyShapeNames, type ShapeNames } from '../../partNames'
import { runCleanup } from '../pipeline'
import { booleanPlan, modifierPlan } from '../presets'
import type { OccModule, OccShape, OccSubShape } from '../../occTypes'

const oc = await loadOcc()

function facesOf(oc2: OccModule, scope: DisposeScope, shape: OccShape): OccSubShape[] {
  const E = oc2.TopAbs_ShapeEnum
  const exp = scope.track(new oc2.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  const out: OccSubShape[] = []
  for (; exp.More(); exp.Next()) out.push(scope.track(oc2.TopoDS.Face_1(exp.Current())) as OccSubShape)
  return out
}

/**
 * A box with an r4 bore cut from below and a coaxial r4.5/r4 tube added from
 * above, the tube's frame rotated so the two r4 faces disagree on the seam.
 * Both the cylinder pass and the clean have work to do.
 */
function coaxialJoint(oc2: OccModule, scope: DisposeScope): OccShape {
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
    booleanWithHistoryMany(oc2, scope, cyl(10, 4.5, 10, [1, 1, 0]), [cyl(10, 4, 10, [1, 1, 0])], 'cut').shape,
  )
  return scope.track(booleanWithHistoryMany(oc2, scope, cut, [tube], 'fuse').shape)
}

/** Names every face of `shape` with a position tag, the way a producer would. */
function numberedNames(oc2: OccModule, scope: DisposeScope, shape: OccShape): ShapeNames {
  const names = emptyShapeNames()
  facesOf(oc2, scope, shape).forEach((face, i) => names.faceNames.set(face, `face-${i}`))
  return names
}

describe.skipIf(!oc)('the BOOLEAN preset matches the old boolean composition', () => {
  it('returns the same topology, volume and composed diff as canonicalise + clean', () => {
    const scope = new DisposeScope()
    try {
      // The joint carries the cylinder pass's work; the corner box gives the
      // raw fuse a real diff and origin table to compose.
      const joint = coaxialJoint(oc!, scope)
      const tool = scope.track(new oc!.BRepPrimAPI_MakeBox_2(10, 10, 10)).Shape()
      const raw = booleanWithHistoryMany(oc!, scope, joint, [tool], 'fuse')
      scope.track(raw.shape)

      // The old path, still expressed here as the move's oracle: canonicalise
      // (mapping the diff through its rebase), clean, compose through the clean.
      const canonical = canonicalizeCylinderFaces(oc!, scope, raw.shape)
      const pre = scope.track(canonical.shape)
      const preDiff = canonical.changed ? mapDiffThroughRebase(raw.diff, canonical.rebase) : raw.diff
      const preOrigin = canonical.changed ? mapOriginThroughRebase(raw.faceOrigin, canonical.rebase) : raw.faceOrigin
      const legacyClean = cleanWithHistory(oc!, scope, pre)
      const legacyShape = scope.track(legacyClean.shape)
      const legacyDiff = composeDiffThroughClean(oc!, scope, preDiff, legacyClean.history, legacyShape)
      const legacyOrigin = composeOriginThroughClean(oc!, scope, preOrigin, legacyClean.history, legacyShape)

      const names = numberedNames(oc!, scope, raw.shape)
      const result = runCleanup(
        oc!,
        scope,
        { shape: raw.shape, diff: raw.diff, names, faceOrigin: raw.faceOrigin },
        booleanPlan({ unifyFaces: true }),
      )

      expect(result.changed).toBe(true)
      expect(result.passes.map((p) => [p.name, p.status])).toEqual([
        ['canonicalCylinders', 'adopted'],
        ['unifySameDomain', 'adopted'],
      ])
      expect(shapeIsValid(oc!, scope, result.shape)).toBe(true)
      const faceCount = countSubShapes(oc!, scope, result.shape, oc!.TopAbs_ShapeEnum.TopAbs_FACE)
      const edgeCount = countSubShapes(oc!, scope, result.shape, oc!.TopAbs_ShapeEnum.TopAbs_EDGE)
      expect(faceCount).toBe(countSubShapes(oc!, scope, legacyShape, oc!.TopAbs_ShapeEnum.TopAbs_FACE))
      expect(edgeCount).toBe(countSubShapes(oc!, scope, legacyShape, oc!.TopAbs_ShapeEnum.TopAbs_EDGE))
      // The fixture must exercise the merge, or equal counts prove nothing.
      expect(faceCount).toBeLessThan(countSubShapes(oc!, scope, pre, oc!.TopAbs_ShapeEnum.TopAbs_FACE))
      expect(volumeOfDefault(oc!, scope, result.shape)).toBeCloseTo(
        volumeOfDefault(oc!, scope, legacyShape), 9,
      )
      expect(result.diff?.new_faces.length).toBe(legacyDiff.new_faces.length)
      expect(result.diff?.inherited_faces.length).toBe(legacyDiff.inherited_faces.length)
      expect(result.diff?.new_edges.length).toBe(legacyDiff.new_edges.length)
      expect(result.diff?.inherited_edges.length).toBe(legacyDiff.inherited_edges.length)
      expect(result.faceOrigin?.length).toBe(legacyOrigin.length)

      // Every output face took exactly one name, and every name lands on a
      // face of the result (the hand-off the naming step depends on).
      const resultFaces = facesOf(oc!, scope, result.shape)
      expect(result.names?.faceNames.size).toBe(resultFaces.length)
      const uuids = new Set<string>()
      for (const [face, uuid] of result.names!.faceNames.entries()) {
        expect(resultFaces.some((f) => f.IsSame(face))).toBe(true)
        uuids.add(uuid)
      }
      expect(uuids.size).toBe(resultFaces.length)
    } finally {
      scope.dispose()
    }
  })
})

/** Two 20x10x10 boxes sharing a full face: four coplanar face pairs. */
function fusedCoplanarBoxes(oc2: OccModule, scope: DisposeScope): OccShape {
  const a = scope.track(new oc2.BRepPrimAPI_MakeBox_2(20, 10, 10)).Shape()
  const corner = scope.track(new oc2.gp_Pnt_3(20, 0, 0))
  const b = scope.track(new oc2.BRepPrimAPI_MakeBox_3(corner, 20, 10, 10)).Shape()
  return scope.track(booleanWithHistoryMany(oc2, scope, a, [b], 'fuse').shape)
}

/** The one upright straight edge of `shape` (the fillet pick). */
function verticalEdge(oc2: OccModule, scope: DisposeScope, shape: OccShape): OccShape {
  for (const edge of exploreEdges(oc2, scope, shape)) {
    const curve = scope.track(new oc2.BRepAdaptor_Curve_2(edge))
    if (curve.GetType().value !== oc2.GeomAbs_CurveType.GeomAbs_Line.value) continue
    const a = scope.track(curve.Value(curve.FirstParameter()))
    const b = scope.track(curve.Value(curve.LastParameter()))
    if (Math.abs(a.Z() - b.Z()) > 1e-6) return edge
  }
  throw new Error('no vertical edge')
}

describe.skipIf(!oc)('the MODIFIER preset keeps faces apart', () => {
  it('does not fold coplanar faces, while BOOLEAN does', () => {
    const scope = new DisposeScope()
    try {
      // A clean may work in place, so each plan gets its own fixture.
      const shapeForFaces = fusedCoplanarBoxes(oc!, scope)
      const shape = fusedCoplanarBoxes(oc!, scope)
      const before = countSubShapes(oc!, scope, shape, oc!.TopAbs_ShapeEnum.TopAbs_FACE)
      const volume = volumeOfDefault(oc!, scope, shape)

      const faces = runCleanup(
        oc!, scope, { shape: shapeForFaces }, booleanPlan({ unifyFaces: true }),
      )
      const edgesOnly = runCleanup(
        oc!, scope, { shape }, modifierPlan({ heal: 'skip' }),
      )
      expect(countSubShapes(oc!, scope, faces.shape, oc!.TopAbs_ShapeEnum.TopAbs_FACE)).toBe(6)
      expect(countSubShapes(oc!, scope, edgesOnly.shape, oc!.TopAbs_ShapeEnum.TopAbs_FACE)).toBe(before)
      expect(shapeIsValid(oc!, scope, edgesOnly.shape)).toBe(true)
      expect(volumeOfDefault(oc!, scope, edgesOnly.shape)).toBeCloseTo(volume, 9)
      // Measured on the pinned kernel: the edge-only merge leaves the split
      // edges of this fuse in place too. The seam plan is the first pass that
      // gives it an edge to fold; pinning the no-op makes that change visible.
      expect(countSubShapes(oc!, scope, edgesOnly.shape, oc!.TopAbs_ShapeEnum.TopAbs_EDGE))
        .toBe(countSubShapes(oc!, scope, shape, oc!.TopAbs_ShapeEnum.TopAbs_EDGE))
    } finally {
      scope.dispose()
    }
  })

  it('keeps a fillet face across a coplanar neighbour, UUID and all', () => {
    const scope = new DisposeScope()
    try {
      const base = fusedCoplanarBoxes(oc!, scope)
      const fillet = applyFilletWithDiff(oc!, scope, base, 2, [verticalEdge(oc!, scope, base)])
      expect(fillet.success).toBe(true)
      const shape = scope.track(fillet.shape)
      const names = numberedNames(oc!, scope, shape)
      const beforeFaces = facesOf(oc!, scope, shape)
      const beforeEdges = countSubShapes(oc!, scope, shape, oc!.TopAbs_ShapeEnum.TopAbs_EDGE)
      const volume = volumeOfDefault(oc!, scope, shape)

      const result = runCleanup(
        oc!,
        scope,
        { shape, names },
        modifierPlan({ heal: 'skip' }),
      )

      expect(result.passes).toEqual([{ name: 'unifySameDomain', status: 'adopted' }])
      expect(shapeIsValid(oc!, scope, result.shape)).toBe(true)
      expect(volumeOfDefault(oc!, scope, result.shape)).toBeCloseTo(volume, 9)
      // The fillet face must still be its own face, not folded into a
      // neighbour, and every stored UUID must survive.
      const afterFaces = facesOf(oc!, scope, result.shape)
      expect(afterFaces).toHaveLength(beforeFaces.length)
      expect(countSubShapes(oc!, scope, result.shape, oc!.TopAbs_ShapeEnum.TopAbs_EDGE)).toBe(beforeEdges)
      expect(result.names?.faceNames.size).toBe(afterFaces.length)
      const uuids = new Set<string>()
      for (const [face, uuid] of result.names!.faceNames.entries()) {
        expect(afterFaces.some((f) => f.IsSame(face))).toBe(true)
        uuids.add(uuid)
      }
      expect(uuids.size).toBe(afterFaces.length)
      // Precondition: the fixture really carries the fillet's cylindrical face.
      expect(facesOf(oc!, scope, base).length).toBeLessThan(beforeFaces.length)
      const cylinders = afterFaces.filter((face) => {
        const ad = scope.track(new oc!.BRepAdaptor_Surface_2(face, false))
        return ad.GetType().value === oc!.GeomAbs_SurfaceType.GeomAbs_Cylinder.value
      })
      expect(cylinders.length).toBeGreaterThan(0)
    } finally {
      scope.dispose()
    }
  })
})
