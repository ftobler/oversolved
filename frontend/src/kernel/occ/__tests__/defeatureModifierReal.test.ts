// @vitest-environment node
//
// Rung 2 of delete-face on edge-modifier faces (occ/defeatureWedge.ts) on
// minimal bodies, before the report document's pass matrix:
//   - a box with one filleted convex vertical edge: the wedge is fused back and
//     the box returns (rung 1 already passes this; rung 2 must not regress it);
//   - an L-block's concave inner corner: the fillet added material, so the
//     wedge is cut away and the sharp corner returns;
//   - a cylinder-to-plane and a plane-sphere fillet (the fixture's case built
//     small), and a chamfer on each side of convex/concave.
//
// Each passing case also pins the validation gate the plan asks for: the picks
// are gone, one valid solid, and the volume moved by the wedge the extrusion
// removed (fuse grows, cut shrinks) within the same estimate the adapter gates.
//
// Skips when OCC.js is absent.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fixture from './fixtures/deleteFaceModifier.json'
import { loadOcc } from '../loadOcc'
import { SharedHarness } from '../sharedHarness'
import { setSketchSolver, setSketchTopology, resetSketchSolver } from '../../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { DisposeScope } from '../disposeScope'
import {
  makeBox,
  makeBezierEdge,
  makeCylinder,
  makeLineEdge,
  makeWire,
  makeFaceFromWire,
  makePrism,
  faceSurfaceType,
  faceCentroid,
  faceNormal,
  type Vec3,
} from '../primitives'
import { canonicalFaces, canonicalEdges, readPartNames } from '../partNames'
import { applyFilletWithDiff, applyChamferWithDiff, isValidShape } from '../edgeModifier'
import { applyDeleteFacesWithLineage, neighbourRing } from '../defeature'
import { modifierWedge, RUNG_WEDGE } from '../defeatureWedge'
import { booleanWithDiff, exploreSolids, shapeIsValid } from '../booleans'
import { volumeOf } from '../volume'
import { noProgress } from '../defaultArgs'
import { deriveEdgeUuid } from '../../constructionName'
import { makeFaceIndexCache, resolveFacesByQuery } from '../../features/shared/faceResolution'
import type { OccShape, OccSubShape } from '../occTypes'
import type { PartSolid } from '../../types3d'

const oc = await loadOcc()
const solveBytes = loadSolver()
const topologyBytes = loadTopology()

describe.skipIf(!oc)('delete-face rung 2: the splitter wedge (real OCC)', () => {
  if (!oc) return
  const occ = oc

  const facesOf = (scope: DisposeScope, s: OccShape): OccShape[] =>
    canonicalFaces(occ, scope, s) as OccShape[]
  const edgesOf = (scope: DisposeScope, s: OccShape): OccShape[] =>
    canonicalEdges(occ, scope, s) as OccShape[]

  const verticalEdges = (scope: DisposeScope, s: OccShape): OccShape[] =>
    edgesOf(scope, s).filter((e) => {
      const g = edgeLine(scope, e)
      return g !== null && Math.abs(g[0][0] - g[1][0]) < 1e-9 && Math.abs(g[0][1] - g[1][1]) < 1e-9
    })
  const edgeLine = (scope: DisposeScope, edge: OccShape): [Vec3, Vec3] | null => {
    const curve = scope.track(new occ.BRepAdaptor_Curve_2(edge))
    if (curve.GetType().value !== occ.GeomAbs_CurveType.GeomAbs_Line.value) return null
    const a = scope.track(curve.Value(curve.FirstParameter()))
    const b = scope.track(curve.Value(curve.LastParameter()))
    return [[a.X(), a.Y(), a.Z()], [b.X(), b.Y(), b.Z()]]
  }

  // The delete-face adapter on one group, with the names off (diff only).
  const deleteModifier = (
    scope: DisposeScope,
    part: OccShape,
    faces: OccShape[],
  ): { shape: OccShape; applied: boolean } => {
    const res = applyDeleteFacesWithLineage(occ, scope, part, faces)
    return { shape: res.shape, applied: res.applied }
  }

  it('a convex box fillet: the wedge is fused back and the box returns', () => {
    const scope = new DisposeScope()
    try {
      const base = makeBox(occ, scope, 20, 20, 10)
      const fil = applyFilletWithDiff(occ, scope, base, 3, [verticalEdges(scope, base)[0]])
      expect(fil.success).toBe(true)
      const shaped = scope.track(fil.shape)
      const picks = fil.diff.new_faces as OccShape[]
      expect(picks).toHaveLength(1)
      const ring = neighbourRing(occ, scope, shaped, picks)
      const plan = modifierWedge({ oc: occ, scope, part: shaped, groupFaces: picks, ring })
      expect(plan.corner).toBe('convex')
      expect(plan.action).toBe('fuse')
      expect(plan.volume).toBeGreaterThan(0)
      const tool = scope.track(plan.shape)
      const fused = scope.track(booleanWithDiff(occ, scope, shaped, tool, 'fuse').shape)
      expect(isValidShape(occ, scope, fused)).toBe(true)
      expect(exploreSolids(occ, scope, fused)).toHaveLength(1)
      expect(volumeOf(occ, scope, fused)).toBeCloseTo(4000, 2)
      expect(facesOf(scope, fused)).toHaveLength(6)
      // The adapter's own path reaches the same result through rung 1 today and
      // must keep doing so (the wedge is the fallback, not a replacement).
      const res = deleteModifier(scope, shaped, picks)
      expect(res.applied).toBe(true)
      expect(volumeOf(occ, scope, res.shape)).toBeCloseTo(4000, 2)
    } finally {
      scope.dispose()
    }
  })

  it('a chamfer on a box edge: the ruled band is fused back', () => {
    const scope = new DisposeScope()
    try {
      const base = makeBox(occ, scope, 20, 20, 10)
      const ch = applyChamferWithDiff(occ, scope, base, 2, [verticalEdges(scope, base)[0]], 'distance', 45)
      expect(ch.success).toBe(true)
      const shaped = scope.track(ch.shape)
      const picks = ch.diff.new_faces as OccShape[]
      const ring = neighbourRing(occ, scope, shaped, picks)
      const plan = modifierWedge({ oc: occ, scope, part: shaped, groupFaces: picks, ring })
      expect(plan.corner).toBe('convex')
      expect(plan.action).toBe('fuse')
    } finally {
      scope.dispose()
    }
  })

  it('a concave inner corner: the added wedge is cut away', () => {
    const scope = new DisposeScope()
    try {
      // An L-block: a 20x20x10 box with a 10x10x10 corner notch cut out, whose
      // inner vertical edge is concave. The fillet there ADDS material.
      const outer = makeBox(occ, scope, 20, 20, 10)
      const notch = makeBox(occ, scope, 10, 10, 10)
      const lBlock = scope.track(booleanWithDiff(occ, scope, outer, notch, 'cut').shape)
      const inner = verticalEdges(scope, lBlock).find((e) => {
        const g = edgeLine(scope, e)
        if (g === null) return false
        return Math.abs(g[0][0] - 10) < 1e-6 && Math.abs(g[0][1] - 10) < 1e-6
      })
      if (!inner) throw new Error('the L-block has no inner vertical edge')
      const fil = applyFilletWithDiff(occ, scope, lBlock, 2, [inner])
      expect(fil.success).toBe(true)
      const shaped = scope.track(fil.shape)
      const picks = fil.diff.new_faces as OccShape[]
      const ring = neighbourRing(occ, scope, shaped, picks)
      const plan = modifierWedge({ oc: occ, scope, part: shaped, groupFaces: picks, ring })
      expect(plan.corner).toBe('concave')
      expect(plan.action).toBe('cut')
      const before = volumeOf(occ, scope, shaped)
      const cut = scope.track(booleanWithDiff(occ, scope, shaped, scope.track(plan.shape), 'cut').shape)
      expect(isValidShape(occ, scope, cut)).toBe(true)
      expect(volumeOf(occ, scope, cut)).toBeLessThan(before)
      // The sharp L-block volume: 4000 (outer) minus the notch 1000, and the
      // fillet added (1 - pi/4) r^2 l back which the cut removes again.
      expect(volumeOf(occ, scope, cut)).toBeCloseTo(3000, 1)
    } finally {
      scope.dispose()
    }
  })

  it('a concave chamfer: the added strip is cut away', () => {
    const scope = new DisposeScope()
    try {
      const outer = makeBox(occ, scope, 20, 20, 10)
      const notch = makeBox(occ, scope, 10, 10, 10)
      const lBlock = scope.track(booleanWithDiff(occ, scope, outer, notch, 'cut').shape)
      const inner = verticalEdges(scope, lBlock).find((e) => {
        const g = edgeLine(scope, e)
        if (g === null) return false
        return Math.abs(g[0][0] - 10) < 1e-6 && Math.abs(g[0][1] - 10) < 1e-6
      })
      if (!inner) throw new Error('the L-block has no inner vertical edge')
      const ch = applyChamferWithDiff(occ, scope, lBlock, 2, [inner], 'distance', 45)
      expect(ch.success).toBe(true)
      const shaped = scope.track(ch.shape)
      const picks = ch.diff.new_faces as OccShape[]
      const ring = neighbourRing(occ, scope, shaped, picks)
      const plan = modifierWedge({ oc: occ, scope, part: shaped, groupFaces: picks, ring })
      expect(plan.corner).toBe('concave')
      expect(plan.action).toBe('cut')
      const cut = scope.track(booleanWithDiff(occ, scope, shaped, scope.track(plan.shape), 'cut').shape)
      expect(isValidShape(occ, scope, cut)).toBe(true)
      expect(volumeOf(occ, scope, cut)).toBeCloseTo(3000, 1)
    } finally {
      scope.dispose()
    }
  })

  // The circular edges of `solid` at height `z`.
  const circlesAt = (scope: DisposeScope, solid: OccShape, z: number): OccShape[] =>
    edgesOf(scope, solid).filter((e) => {
      const curve = scope.track(new occ.BRepAdaptor_Curve_2(e))
      if (curve.GetType().value !== occ.GeomAbs_CurveType.GeomAbs_Circle.value) return false
      const mid = scope.track(curve.Value((curve.FirstParameter() + curve.LastParameter()) / 2))
      return Math.abs(mid.Z() - z) < 1e-6
    })

  it('a cylinder-to-plane fillet (a closed rim, no end caps) heals back', () => {
    const scope = new DisposeScope()
    try {
      const base = makeBox(occ, scope, 20, 20, 10)
      const boss = scope.track(booleanWithDiff(
        occ, scope, base,
        makeCylinder(occ, scope, [10, 10, 10], [0, 0, 1], 5, 10),
        'fuse',
      ).shape)
      const rim = circlesAt(scope, boss, 10)[0]
      if (!rim) throw new Error('the boss has no base rim circle')
      const fil = applyFilletWithDiff(occ, scope, boss, 2, [rim])
      expect(fil.success).toBe(true)
      const shaped = scope.track(fil.shape)
      const picks = fil.diff.new_faces as OccShape[]
      const plan = modifierWedge({
        oc: occ, scope, part: shaped, groupFaces: picks, ring: neighbourRing(occ, scope, shaped, picks),
      })
      // The boss standing on a plate is a CONCAVE corner (material fills 270
      // degrees), so the fillet there added material and rung 2 cuts it again.
      expect(plan.corner).toBe('concave')
      const res = applyDeleteFacesWithLineage(occ, scope, shaped, picks)
      expect(res.applied, res.failedGroups[0]?.reason).toBe(true)
      expect(isValidShape(occ, scope, res.shape)).toBe(true)
      expect(volumeOf(occ, scope, res.shape)).toBeCloseTo(volumeOf(occ, scope, boss), 2)
    } finally {
      scope.dispose()
    }
  })

  // The fixture's plane-sphere corner without the slot: a sphere flattened by a
  // cut, then a fillet round the flat face's rim. This is the smallest body that
  // reproduces "a fillet on an intersection curve with a closed surface".
  it('a plane-sphere fillet around a flat spot heals back to the sphere', () => {
    const scope = new DisposeScope()
    try {
      const ball = scope.track(new occ.BRepPrimAPI_MakeSphere_5(
        scope.track(new occ.gp_Pnt_3(0, 0, 0)), 10,
      ).Shape())
      // Cut everything above z = 5: a flat cap with a circle rim.
      const capTool = scope.track(new occ.BRepPrimAPI_MakeBox_3(
        scope.track(new occ.gp_Pnt_3(-20, -20, 5)), 40, 40, 40,
      ).Shape())
      const flat = scope.track(booleanWithDiff(occ, scope, ball, capTool, 'cut').shape)
      expect(exploreSolids(occ, scope, flat)).toHaveLength(1)
      const rim = circlesAt(scope, flat, 5)[0]
      if (!rim) throw new Error('the flat spot has no rim circle')
      const fil = applyFilletWithDiff(occ, scope, flat, 1.5, [rim])
      expect(fil.success).toBe(true)
      const shaped = scope.track(fil.shape)
      const picks = fil.diff.new_faces as OccShape[]
      const plan = modifierWedge({
        oc: occ, scope, part: shaped, groupFaces: picks, ring: neighbourRing(occ, scope, shaped, picks),
      })
      expect(plan.corner).toBe('convex')
      const res = applyDeleteFacesWithLineage(occ, scope, shaped, picks)
      expect(res.applied).toBe(true)
      expect(isValidShape(occ, scope, res.shape)).toBe(true)
      // Restoring the sharp rim removes the fillet's ring: the flat spot's
      // volume comes back.
      expect(volumeOf(occ, scope, res.shape)).toBeCloseTo(volumeOf(occ, scope, flat), 2)
    } finally {
      scope.dispose()
    }
  })
})

// ─── the 2026-11-15 report document ───

const PART = 'body_ESrRWmJlIltOOJE-A1VbLhzR'
const CHAMFER_ID = 'BeXVLtIhoq94L87Qll4xewnr'
const CHAMFER_DELETE = 'GpyTc0jipDArcxEoOFcx_DBl'
const FILLET_DELETE = 'OtcaB1IDf8ybp7bHGwOri-JM'

type CellResult = 'pass' | 'fail' | 'not attempted'

/** The committed pass matrix for the fixture. Rung 1 is OCCT's defeaturing on
 *  the untouched body; rung 1b is the plan's pre-conditioned retry, which Step 0
 *  showed has nothing to convert (ring already Sphere/Plane/Plane, picks the
 *  only B-splines); rung 2 is our splitter wedge. A cell that changes updates
 *  this table in the same commit, after reviewing why. */
const MATRIX: Record<string, CellResult> = {
  'chamfer/rung 1': 'fail',
  'chamfer/rung 1b': 'not attempted',
  'chamfer/rung 2': 'pass',
  'fillet/rung 1': 'fail',
  'fillet/rung 1b': 'not attempted',
  'fillet/rung 2': 'pass',
}

describe.skipIf(!oc || !solveBytes || !topologyBytes)('delete face on the report document: modifier faces', () => {
  if (!oc || !solveBytes || !topologyBytes) return
  const occ = oc
  const h = new SharedHarness(occ)
  let live: DisposeScope
  let shape: OccShape
  let part: PartSolid
  let groups: OccShape[][]

  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes!)
    setSketchTopology(topologyBytes!)
    const features = fixture.features as Record<string, unknown>[]
    const firstDelete = features.findIndex((f) => f.id === CHAMFER_DELETE)
    const result = h.run({ features: features.slice(0, firstDelete), part_style: fixture.part_style })
    const snapshot: PartSolid | undefined = result._build_state.checkpoints[CHAMFER_ID]?.body_store_snapshot?.[PART]
    if (!snapshot) throw new Error('the fixture document has no body after the chamfer')
    part = snapshot
    live = new DisposeScope()
    const index = makeFaceIndexCache(occ, live, h.table)(part)
    const resolved = resolveFacesByQuery(
      occ, live, h.table, part, index,
      (fixture.picks as { query: string }[]).map((p) => p.query),
    )
    const picked = (fixture.picks as { query: string }[]).map((p) => {
      const face = resolved.get(p.query)
      if (!face) throw new Error(`pick did not resolve: ${p.query}`)
      return face
    })
    shape = h.table.get<OccShape>(part.shape!)
    // The picks come chamfer-first, fillet-second; since the seam re-seat each
    // modifier builds one face, so one pick is one group.
    groups = [picked.slice(0, 1), picked.slice(1, 2)]
  })

  afterAll(() => live?.dispose())

  // Rung 1 alone: OCCT's own verdict, so the matrix row is attributable.
  const rung1 = (scope: DisposeScope, picks: OccShape[]): CellResult => {
    const maker = scope.track(new occ.BRepAlgoAPI_Defeaturing())
    maker.SetShape(shape)
    for (const face of picks) maker.AddFaceToRemove(face)
    maker.SetToFillHistory(true)
    maker.Build(noProgress(occ))
    if (!maker.IsDone()) return 'fail'
    return picks.every((face) => {
      try {
        return maker.IsDeleted(face)
      } catch {
        return false
      }
    }) ? 'pass' : 'fail'
  }

  // Rung 2 alone: build the wedge, apply it, and run the plan's gate.
  const rung2 = (scope: DisposeScope, picks: OccShape[]): CellResult => {
    try {
      const plan = modifierWedge({
        oc: occ, scope, part: shape, groupFaces: picks, ring: neighbourRing(occ, scope, shape, picks),
      })
      const before = volumeOf(occ, scope, shape)
      const tool = scope.track(plan.shape)
      const res = booleanWithDiff(occ, scope, shape, tool, plan.action)
      const delta = volumeOf(occ, scope, res.shape) - before
      if (!shapeIsValid(occ, scope, res.shape)) return 'fail'
      if (exploreSolids(occ, scope, res.shape).length !== 1) return 'fail'
      if (plan.action === 'fuse' ? delta <= 0 : delta >= 0) return 'fail'
      if (Math.abs(delta - plan.volume) > 0.05 * plan.volume) return 'fail'
      return 'pass'
    } catch {
      return 'fail'
    }
  }

  it('pins which rung carries each modifier group', () => {
    const measured: Record<string, CellResult> = {}
    for (const [index, label] of [[0, 'chamfer'], [1, 'fillet']] as const) {
      const picks = groups[index]
      measured[`${label}/rung 1`] = rung1(live, picks)
      // Step 0's table: the ring is analytic and the picks are the only
      // B-spline faces, so there is no surface for a pre-condition to convert.
      measured[`${label}/rung 1b`] = 'not attempted'
      measured[`${label}/rung 2`] = rung2(live, picks)
    }
    expect(measured).toEqual(MATRIX)
  }, 300_000)

  it('both modifier groups delete in document order, restored edges regain their UUIDs', () => {
    const scope = new DisposeScope()
    try {
      let current = shape
      // The names the first deletion produced are the second deletion's input:
      // the body store's name arrays describe the original shape, not the
      // intermediate one.
      let currentNames: ReturnType<typeof readPartNames> = readPartNames(occ, scope, shape, part)
      for (const [index, featureId] of [[0, CHAMFER_DELETE], [1, FILLET_DELETE]] as const) {
        const picks = groups[index]
        const ring = neighbourRing(occ, scope, current, picks)
        const old = { createdBy: featureId, ...currentNames }
        // The two supports and the end cap of a modifier band, by surface class.
        const wall = ring.find((f) => {
          if (faceSurfaceType(occ, scope, f) !== 'flatface') return false
          const n = faceNormal(occ, scope, f)
          const c = faceCentroid(occ, scope, f)
          return Math.abs(n[0]) > 0.9 && Math.abs(c[0]) > 9
        })
        const sphere = ring.find((f) => faceSurfaceType(occ, scope, f) === 'sphereface')
        if (wall === undefined || sphere === undefined) throw new Error('the band ring lost its wall or sphere')
        const wallUuid = old.faceNames.get(wall as OccSubShape)
        const sphereUuid = old.faceNames.get(sphere as OccSubShape)
        if (wallUuid === undefined || sphereUuid === undefined) throw new Error('the support faces are unnamed')

        const res = applyDeleteFacesWithLineage(occ, scope, current, picks, old)
        expect(res.applied).toBe(true)
        expect(res.failedGroups).toEqual([])
        expect(res.names).not.toBeNull()
        const outNames = res.names!
        // The picked modifier faces are gone.
        for (const pick of picks) {
          const uuid = old.faceNames.get(pick as OccSubShape)
          expect(uuid).toBeDefined()
          expect([...outNames.faceNames.entries()].some(([, name]) => name === uuid)).toBe(false)
        }
        // The restored sharp edge is derived from the same face pair the fillet
        // or chamfer consumed, so it regains its pre-modifier UUID.
        const restored = deriveEdgeUuid(wallUuid, sphereUuid)
        expect([...outNames.edgeNames.entries()].some(([, name]) => name === restored)).toBe(true)
        current = scope.track(res.shape)
        currentNames = outNames
        expect(shapeIsValid(occ, scope, current)).toBe(true)
        expect(exploreSolids(occ, scope, current)).toHaveLength(1)
      }
      // Both modifiers removed: no B-spline band is left and the body regrew the
      // two corner wedges the modifiers had taken off (restoring sharp corners
      // adds material, so the volume grows).
      const left = canonicalFaces(occ, scope, current) as OccShape[]
      expect(left.some((f) => faceSurfaceType(occ, scope, f) === 'face')).toBe(false)
      expect(volumeOf(occ, scope, current)).toBeGreaterThan(55816.28838842761)
    } finally {
      scope.dispose()
    }
  }, 300_000)

  it('a slot wall heals before the modifiers and is guard-2 refused after them', () => {
    // The report's "delete face on what extrude 2 creates works": on the body
    // without the edge modifiers a slot wall heals through rung 1. With the
    // modifiers present the floor's ring holds their B-spline bands, so guard 2
    // (the hang pre-filter) refuses the group, and rung 2 has no band to close:
    // the refusal must name both.
    const features = fixture.features as Record<string, unknown>[]
    const filletIndex = features.findIndex((f) => f.id === 'e1Hi6Ty5NHzMKPHP-_M4WQvS')
    expect(filletIndex).toBeGreaterThan(0)
    const pre = h.run({ features: features.slice(0, filletIndex), part_style: fixture.part_style })
    const prePart: PartSolid | undefined = pre._build_state.checkpoints['yvwbBkwvs8_z6Ens36yxDiO8']?.body_store_snapshot?.[PART]
    if (!prePart) throw new Error('no body after extrude 2')
    const preShape = h.table.get<OccShape>(prePart.shape!)
    const scope = new DisposeScope()
    try {
      const wallOf = (s: OccShape): OccShape | undefined =>
        (canonicalFaces(occ, scope, s) as OccShape[]).find((f) => {
          if (faceSurfaceType(occ, scope, f) !== 'flatface') return false
          const n = faceNormal(occ, scope, f)
          const c = faceCentroid(occ, scope, f)
          return Math.abs(n[0]) > 0.9 && Math.abs(c[0] - 10) < 1
        })
      const preWall = wallOf(preShape)
      if (!preWall) throw new Error('the slot has no +x wall')
      const healed = applyDeleteFacesWithLineage(occ, scope, preShape, [preWall])
      expect(healed.applied).toBe(true)
      expect(shapeIsValid(occ, scope, healed.shape)).toBe(true)

      const floorOf = (s: OccShape): OccShape | undefined =>
        (canonicalFaces(occ, scope, s) as OccShape[]).find((f) => {
          if (faceSurfaceType(occ, scope, f) !== 'flatface') return false
          const n = faceNormal(occ, scope, f)
          const c = faceCentroid(occ, scope, f)
          return Math.abs(n[1]) > 0.9 && Math.abs(c[1] - 10) < 1
        })
      const floor = floorOf(shape)
      if (!floor) throw new Error('the fixtured slot has no floor')
      const refused = applyDeleteFacesWithLineage(occ, scope, shape, [floor])
      expect(refused.applied).toBe(false)
      const reason = refused.failedGroups[0].reason
      expect(reason).toContain('non-analytic')
      expect(reason).toContain(RUNG_WEDGE)
    } finally {
      scope.dispose()
    }
  }, 300_000)

  it('a refusal names every rung, including the unapplied pre-condition', () => {
    const scope = new DisposeScope()
    try {
      // A plain box top: the ring is analytic, so rung 1 runs and silently
      // no-ops, and there is no long/short band split for rung 2.
      const base = makeBox(occ, scope, 20, 20, 10)
      const top = (canonicalFaces(occ, scope, base) as OccShape[]).find((f) =>
        Math.abs(faceCentroid(occ, scope, f)[2] - 10) < 1e-6)
      if (!top) throw new Error('the box has no top face')
      const res = applyDeleteFacesWithLineage(occ, scope, base, [top])
      expect(res.applied).toBe(false)
      expect(res.failedGroups).toHaveLength(1)
      const reason = res.failedGroups[0].reason
      expect(reason).toMatch(/rung 1 .*rung 1b .*rung 2 /s)
      expect(reason).toContain('close the gap')
      expect(reason).toMatch(/rung 1b \(pre-conditioned OCCT defeaturing\): not attempted/)
      expect(reason).toContain(RUNG_WEDGE)
    } finally {
      scope.dispose()
    }
  }, 60_000)

  it('a B-spline-loft neighbour still pre-refuses OCCT, and rung 2 answers within budget', () => {
    const scope = new DisposeScope()
    try {
      // The defeatureReal hang case: a Bezier side extruded into a D prism. Its
      // top face's ring holds a non-analytic face, so guard 2 must fire BEFORE
      // OCCT (the reason says so); rung 2 then tries its splitter route and must
      // finish inside the plan's budget instead of leaving the call hanging.
      const p = (x: number, y: number): Vec3 => [x, y, 0]
      const wire = scope.track(makeWire(occ, scope, [
        makeLineEdge(occ, scope, p(1, 6), p(1, 14)),
        makeBezierEdge(occ, scope, [p(1, 14), p(12, 14), p(12, 6), p(1, 6)]),
      ], { requireClosed: true }))
      const face = scope.track(makeFaceFromWire(occ, scope, wire))
      const shape = scope.track(makePrism(occ, scope, face, [0, 0, 1], 10))
      const top = (canonicalFaces(occ, scope, shape) as OccShape[]).find((f) =>
        Math.abs(faceCentroid(occ, scope, f)[2] - 10) < 1e-6)
      if (!top) throw new Error('the D prism has no top face')
      const t0 = Date.now()
      const res = applyDeleteFacesWithLineage(occ, scope, shape, [top])
      const millis = Date.now() - t0
      expect(res.applied).toBe(false)
      expect(res.failedGroups).toHaveLength(1)
      expect(res.failedGroups[0].reason).toContain('non-analytic')
      expect(res.failedGroups[0].reason).toContain('the neighbour guard pre-refused the group before OCCT could hang')
      expect(millis).toBeLessThan(2000)
    } finally {
      scope.dispose()
    }
  }, 60_000)
})
