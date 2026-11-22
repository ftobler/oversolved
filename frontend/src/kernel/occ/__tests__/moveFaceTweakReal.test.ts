// @vitest-environment node
//
// Real-OCC tests for the direct B-rep move-face (occ/moveFaceTweak.ts). The
// construction moves the picked surfaces, re-intersects the touching edges and
// vertices, rebuilds the changed faces, assembles the shell and hands it to the
// cleanup layer. Volumes are exact analytic values; a construction that moves a
// volume fails here.
//
// The UUID lineage and the leaf route are pinned by
// features/__tests__/moveFaceReal.test.ts; these tests are the geometry.
//
// Skips when OCC is absent (and the report-document test also without the Rust
// solver).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadOcc } from '../loadOcc'
import { noProgress } from '../defaultArgs'
import { DisposeScope } from '../disposeScope'
import { volumeOf } from '../volume'
import { canonicalFaces, canonicalEdges } from '../partNames'
import {
  faceCentroid,
  faceNormal,
  makeBox,
  makeFaceFromWire,
  makeLineEdge,
  makePrism,
  makeWire,
  type Vec3,
} from '../primitives'
import { applyMoveFaces } from '../moveFaceTweak'
import { SharedHarness } from '../sharedHarness'
import { makeFaceIndexCache, resolveFacesByQuery } from '../../features/shared/faceResolution'
import { setSketchSolver, resetSketchSolver } from '../../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { partSpecFromText } from '@/utils/partExport'
import type { OccShape } from '../occTypes'
import type { PartSolid } from '../../types3d'

const oc = await loadOcc()
const solveBytes = loadSolver()

const PI = Math.PI
const coneV = (r: number, h: number): number => (PI * r * r * h) / 3

const REPORT_RECIPE = readFileSync(
  join(process.cwd(), 'regressions', 'move-face-legacy-cap', 'recipe.yaml'),
  'utf8',
)
const REPORT_DOC = partSpecFromText(REPORT_RECIPE)

function cylinderSolid(scope: DisposeScope, x: number, y: number, z: number, r: number, h: number): OccShape {
  const ax2 = scope.track(new oc!.gp_Ax2_4(
    scope.track(new oc!.gp_Pnt_3(x, y, z)),
    scope.track(new oc!.gp_Dir_5(0, 0, 1)),
  ))
  return scope.track(new oc!.BRepPrimAPI_MakeCylinder_3(ax2, r, h).Shape())
}

function coneSolid(scope: DisposeScope, r1: number, r2: number, h: number): OccShape {
  const ax2 = scope.track(new oc!.gp_Ax2_4(
    scope.track(new oc!.gp_Pnt_3(0, 0, 0)),
    scope.track(new oc!.gp_Dir_5(0, 0, 1)),
  ))
  return scope.track(new oc!.BRepPrimAPI_MakeCone_3(ax2, r1, r2, h).Shape())
}

function sphereSolid(scope: DisposeScope, r: number): OccShape {
  return scope.track(new oc!.BRepPrimAPI_MakeSphere_5(scope.track(new oc!.gp_Pnt_3(0, 0, 0)), r).Shape())
}

function torusSolid(scope: DisposeScope, major: number, minor: number): OccShape {
  const frame = scope.track(new oc!.gp_Ax2_4(
    scope.track(new oc!.gp_Pnt_3(0, 0, 0)),
    scope.track(new oc!.gp_Dir_5(0, 0, 1)),
  ))
  return scope.track(new oc!.BRepPrimAPI_MakeTorus_5(frame, major, minor).Shape())
}

function boolParts(scope: DisposeScope, a: OccShape, b: OccShape, op: 'fuse' | 'cut'): OccShape {
  const algo = scope.track(op === 'fuse' ? new oc!.BRepAlgoAPI_Fuse_1() : new oc!.BRepAlgoAPI_Cut_1())
  const args = scope.track(new oc!.TopTools_ListOfShape_1())
  args.Append_1(a)
  const tools = scope.track(new oc!.TopTools_ListOfShape_1())
  tools.Append_1(b)
  algo.SetArguments(args)
  algo.SetTools(tools)
  algo.Build(noProgress(oc!))
  return scope.track(algo.Shape())
}

/** A prism of a closed XZ profile extruded along +Y by `depth`. */
function prismProfile(scope: DisposeScope, points: [number, number][], depth: number): OccShape {
  const xz = (p: [number, number]): Vec3 => [p[0], 0, p[1]]
  const edges = points.map((p, i) => {
    const a = xz(p)
    const b = xz(points[(i + 1) % points.length])
    return scope.track(makeLineEdge(oc!, scope, a, b))
  })
  const wire = scope.track(makeWire(oc!, scope, edges, { requireClosed: true }))
  const face = scope.track(makeFaceFromWire(oc!, scope, wire))
  return scope.track(makePrism(oc!, scope, face, [0, 1, 0], depth))
}

const pickMaxZ = (scope: DisposeScope, part: OccShape): OccShape => {
  let best = canonicalFaces(oc!, scope, part)[0] as OccShape
  for (const f of canonicalFaces(oc!, scope, part)) {
    if (faceCentroid(oc!, scope, f as OccShape)[2] > faceCentroid(oc!, scope, best)[2]) best = f as OccShape
  }
  return best
}
const pickMinZ = (scope: DisposeScope, part: OccShape): OccShape => {
  let best = canonicalFaces(oc!, scope, part)[0] as OccShape
  for (const f of canonicalFaces(oc!, scope, part)) {
    if (faceCentroid(oc!, scope, f as OccShape)[2] < faceCentroid(oc!, scope, best)[2]) best = f as OccShape
  }
  return best
}
function pickByNormal(scope: DisposeScope, part: OccShape, want: Vec3, at?: (c: Vec3) => boolean): OccShape {
  for (const f of canonicalFaces(oc!, scope, part)) {
    const n = faceNormal(oc!, scope, f as OccShape)
    if (Math.abs(n[0] - want[0]) > 1e-6 || Math.abs(n[1] - want[1]) > 1e-6 || Math.abs(n[2] - want[2]) > 1e-6) continue
    if (at !== undefined) {
      const c = faceCentroid(oc!, scope, f as OccShape)
      if (!at(c)) continue
    }
    return f as OccShape
  }
  throw new Error(`no face matched the normal ${want.join(',')}`)
}

function pickCylinder(scope: DisposeScope, part: OccShape, at: (c: Vec3) => boolean): OccShape {
  for (const f of canonicalFaces(oc!, scope, part)) {
    const adaptor = scope.track(new oc!.BRepAdaptor_Surface_2(f as OccShape, true))
    if (adaptor.GetType().value !== oc!.GeomAbs_SurfaceType.GeomAbs_Cylinder.value) continue
    const c = faceCentroid(oc!, scope, f as OccShape)
    if (at(c)) return f as OccShape
  }
  throw new Error('no cylinder face matched the position')
}

const moved = (scope: DisposeScope, part: OccShape, picks: { face: OccShape; distance: number }[]): OccShape =>
  applyMoveFaces(oc!, scope, part, picks).shape

function expectVolume(scope: DisposeScope, shape: OccShape, expected: number): void {
  const got = volumeOf(oc!, scope, shape)
  expect(Math.abs(got - expected), `volume ${got} vs ${expected}`).toBeLessThan(Math.max(1e-6, 1e-6 * Math.abs(expected)))
}

function expectValid(scope: DisposeScope, shape: OccShape): void {
  const analyzer = scope.track(new oc!.BRepCheck_Analyzer(shape, true, false, false))
  expect(analyzer.IsValid_2()).toBe(true)
}

describe.skipIf(!oc)('moveFaceTweak (real OCC)', () => {
  const occ = oc!

  it('box, all six faces +2: the grown box, six faces', () => {
    const scope = new DisposeScope()
    try {
      const part = scope.track(makeBox(occ, scope, 10, 10, 10))
      const picks = (canonicalFaces(occ, scope, part) as OccShape[]).map((face) => ({ face, distance: 2 }))
      const out = moved(scope, part, picks)
      expectVolume(scope, out, 14 ** 3)
      expect(canonicalFaces(occ, scope, out)).toHaveLength(6)
      expect(canonicalEdges(occ, scope, out)).toHaveLength(12)
      expectValid(scope, out)
    } finally { scope.dispose() }
  })

  it('box top +2: the sides grow, the box is 10 x 10 x 12', () => {
    const scope = new DisposeScope()
    try {
      const part = scope.track(makeBox(occ, scope, 10, 10, 10))
      const out = moved(scope, part, [{ face: pickMaxZ(scope, part), distance: 2 }])
      expectVolume(scope, out, 1200)
      expect(canonicalFaces(occ, scope, out)).toHaveLength(6)
      expectValid(scope, out)
    } finally { scope.dispose() }
  })

  it('the report document (5 picks, d = 2) builds the 26013 box', () => {
    if (!solveBytes) return
    const h = new SharedHarness(occ)
    resetSketchSolver()
    setSketchSolver(solveBytes)
    const baseDoc = structuredClone(REPORT_DOC) as { features: Record<string, unknown>[] }
    baseDoc.features.pop()
    const base = h.run(baseDoc)
    const part = base._build_state.checkpoints['ItndFzj0p5ptXDPqsLWTaKPm']
      ?.body_store_snapshot?.['body_ItndFzj0p5ptXDPqsLWTaKPm'] as PartSolid | undefined
    if (!part) throw new Error('the report document has no body after the extrude')
    const stored = ((structuredClone(REPORT_DOC) as { features: Record<string, unknown>[] })
      .features.find((f) => f.id === 'Pqa8cKOIZ02jshDxVx8typkI')!
      .move_face as { faces: string[] }).faces
    const run = (queries: string[]): { volume: number; faces: number; edges: number } => {
      const scope = new DisposeScope()
      try {
        const index = makeFaceIndexCache(occ, scope, h.table)(part)
        const faces = queries.map((q) => {
          const face = resolveFacesByQuery(occ, scope, h.table, part, index, [q]).get(q)
          if (!face) throw new Error(`the report pick did not resolve: ${q}`)
          return face
        })
        const shape = h.table.get<OccShape>(part.shape!)
        const out = moved(scope, shape, faces.map((face) => ({ face, distance: 2 })))
        expectValid(scope, out)
        return {
          volume: volumeOf(occ, scope, out),
          faces: canonicalFaces(occ, scope, out).length,
          edges: canonicalEdges(occ, scope, out).length,
        }
      } finally { scope.dispose() }
    }
    const forward = run(stored)
    expect(forward.volume, 'report volume').toBeCloseTo(26013, 2)
    expect(forward.faces).toBe(6)
    expect(forward.edges).toBe(12)
    const reverse = run([...stored].reverse())
    expect(reverse.volume).toBeCloseTo(forward.volume, 6)
    expect(reverse.faces).toBe(forward.faces)
  }, 120_000)

  it('two adjacent faces +2 and one face -1: the exact mixed volume', () => {
    const scope = new DisposeScope()
    try {
      const part = scope.track(makeBox(occ, scope, 10, 10, 10))
      const xp = pickByNormal(scope, part, [1, 0, 0])
      const zp = pickMaxZ(scope, part)
      const zn = pickMinZ(scope, part)
      const out = moved(scope, part, [
        { face: xp, distance: 2 },
        { face: zp, distance: 2 },
        { face: zn, distance: -1 },
      ])
      // x 0..12, y 0..10, z 1..12 (the bottom -1 moves up into the material).
      expectVolume(scope, out, 12 * 10 * 11)
      expectValid(scope, out)
    } finally { scope.dispose() }
  })

  it('cone base +5: the slanted face follows to the larger cone', () => {
    // The full cone exercises the degenerate apex edge; the frustum is the
    // same plane-cone intersection without it.
    for (const [r1, apex] of [[10, true], [10, false]] as const) {
      const scope = new DisposeScope()
      try {
        const part = scope.track(coneSolid(scope, r1, apex ? 0 : 4, 20))
        const out = moved(scope, part, [{ face: pickMinZ(scope, part), distance: 5 }])
        if (apex) {
          expectVolume(scope, out, coneV(12.5, 25))
        } else {
          const r = 10 + 5 * 0.3
          expectVolume(scope, out, (PI * 25 / 3) * (r * r + r * 4 + 16))
        }
        expectValid(scope, out)
      } finally { scope.dispose() }
    }
  })

  it('cylinder boss wall +1 and bore wall -1 follow the curved offset law', () => {
    {
      const scope = new DisposeScope()
      try {
        const box = scope.track(makeBox(occ, scope, 40, 40, 10))
        const boss = scope.track(cylinderSolid(scope, 20, 20, 10, 5, 10))
        const part = scope.track(boolParts(scope, box, boss, 'fuse'))
        const wall = pickCylinder(scope, part, (c) => Math.abs(c[2] - 15) < 1e-6)
        const out = moved(scope, part, [{ face: wall, distance: 1 }])
        expectVolume(scope, out, 40 * 40 * 10 + PI * 36 * 10)
        expectValid(scope, out)
      } finally { scope.dispose() }
    }
    {
      const scope = new DisposeScope()
      try {
        const plate = scope.track(makeBox(occ, scope, 40, 40, 10))
        const bore = scope.track(cylinderSolid(scope, 20, 20, -5, 5, 20))
        const part = scope.track(boolParts(scope, plate, bore, 'cut'))
        // The bore wall's outward normal points at the axis.
        const wall = pickCylinder(scope, part, (c) => Math.abs(c[2] - 5) < 1e-6)
        const out = moved(scope, part, [{ face: wall, distance: -1 }])
        expectVolume(scope, out, (40 * 40 - PI * 36) * 10)
        expectValid(scope, out)
      } finally { scope.dispose() }
    }
  })

  it('sphere +0.5 and torus minor +1: the closed faces have no edges', () => {
    {
      const scope = new DisposeScope()
      try {
        const part = scope.track(sphereSolid(scope, 10))
        const out = moved(scope, part, [{ face: pickMaxZ(scope, part), distance: 0.5 }])
        expectVolume(scope, out, (4 / 3) * PI * 10.5 ** 3)
        expect(canonicalFaces(occ, scope, out)).toHaveLength(1)
        expectValid(scope, out)
      } finally { scope.dispose() }
    }
    {
      const scope = new DisposeScope()
      try {
        const part = scope.track(torusSolid(scope, 20, 5))
        const out = moved(scope, part, [{ face: pickMaxZ(scope, part), distance: 1 }])
        expectVolume(scope, out, 2 * PI * PI * 20 * 36)
        expect(canonicalFaces(occ, scope, out)).toHaveLength(1)
        expectValid(scope, out)
      } finally { scope.dispose() }
    }
  })

  it('a hole mouth on a moved top face: the wall shortens, it is not notched', () => {
    const scope = new DisposeScope()
    try {
      const plate = scope.track(makeBox(occ, scope, 40, 30, 10))
      const bore = scope.track(cylinderSolid(scope, 20, 15, -5, 5, 20))
      const part = scope.track(boolParts(scope, plate, bore, 'cut'))
      const top = pickByNormal(scope, part, [0, 0, 1], (c) => Math.abs(c[2] - 10) < 1e-6)
      const out = moved(scope, part, [{ face: top, distance: -2 }])
      expectVolume(scope, out, 40 * 30 * 8 - PI * 25 * 8)
      expect(canonicalFaces(occ, scope, out)).toHaveLength(7)
      expectValid(scope, out)
    } finally { scope.dispose() }
  })

  it('the +X plate side cuts through the top hole and boss (the user case)', () => {
    /** 100 x 60 x 10 plate, a through hole at x = 85 and a boss at x = 65. */
    const make = (scope: DisposeScope): OccShape => {
      const plate = scope.track(makeBox(occ, scope, 100, 60, 10))
      const hole = scope.track(cylinderSolid(scope, 85, 30, -5, 5, 20))
      const boss = scope.track(cylinderSolid(scope, 65, 30, 10, 5, 8))
      return scope.track(boolParts(scope, boolParts(scope, plate, hole, 'cut'), boss, 'fuse'))
    }
    const side = (scope: DisposeScope, part: OccShape): OccShape =>
      pickByNormal(scope, part, [1, 0, 0], (c) => Math.abs(c[2] - 5) < 1e-6)
    // -15: the cutter crosses the hole on its axis, which becomes an open
    // half-moon notch. (The plan wrote -10, but a d10 hole 15 from the edge is
    // exactly tangent to a -10 cutter; -15 crosses it, which is the geometry
    // the plan describes. Reported as a fixture deviation.)
    {
      const scope = new DisposeScope()
      try {
        const part = make(scope)
        const out = moved(scope, part, [{ face: side(scope, part), distance: -15 }])
        expectVolume(scope, out, 85 * 60 * 10 - (PI * 25 * 10) / 2 + PI * 25 * 8)
        expectValid(scope, out)
      } finally { scope.dispose() }
    }
    // -35: the cutter crosses the boss axis; the boss is a half boss flush with
    // the new side and the hole is gone.
    {
      const scope = new DisposeScope()
      try {
        const part = make(scope)
        const out = moved(scope, part, [{ face: side(scope, part), distance: -35 }])
        expectVolume(scope, out, 65 * 60 * 10 + (PI * 25 * 8) / 2)
        expectValid(scope, out)
      } finally { scope.dispose() }
    }
    // -45: both features are swallowed; a plain 55 x 60 x 10 plate remains.
    {
      const scope = new DisposeScope()
      try {
        const part = make(scope)
        const out = moved(scope, part, [{ face: side(scope, part), distance: -45 }])
        expectVolume(scope, out, 55 * 60 * 10)
        expect(canonicalFaces(occ, scope, out)).toHaveLength(6)
        expectValid(scope, out)
      } finally { scope.dispose() }
    }
    // +5 outward: the top face extends, the features stay.
    {
      const scope = new DisposeScope()
      try {
        const part = make(scope)
        const out = moved(scope, part, [{ face: side(scope, part), distance: 5 }])
        expectVolume(scope, out, 105 * 60 * 10 - PI * 25 * 10 + PI * 25 * 8)
        expectValid(scope, out)
      } finally { scope.dispose() }
    }
  })

  it('the wedge tip vanishes at +10 and stays the same body at +30', () => {
    // Back face 20 high at x=0, tip face 4 high at x=40, top and bottom
    // converge at x=50 (z=10).
    const wedge = (scope: DisposeScope): OccShape =>
      prismProfile(scope, [[0, 0], [40, 8], [40, 12], [0, 20]], 10)
    const tip = (scope: DisposeScope, part: OccShape): OccShape =>
      pickByNormal(scope, part, [1, 0, 0])
    {
      const scope = new DisposeScope()
      try {
        const part = wedge(scope)
        expectVolume(scope, part, 4800)
        const out = moved(scope, part, [{ face: tip(scope, part), distance: 5 }])
        expectVolume(scope, out, 4950)
        expect(canonicalFaces(occ, scope, out)).toHaveLength(6)
        expectValid(scope, out)
      } finally { scope.dispose() }
    }
    let plus10: { volume: number; faces: number; edges: number } | null = null
    {
      const scope = new DisposeScope()
      try {
        const part = wedge(scope)
        const out = moved(scope, part, [{ face: tip(scope, part), distance: 10 }])
        expectVolume(scope, out, 5000)
        expect(canonicalFaces(occ, scope, out)).toHaveLength(5)
        expectValid(scope, out)
        plus10 = {
          volume: volumeOf(occ, scope, out),
          faces: canonicalFaces(occ, scope, out).length,
          edges: canonicalEdges(occ, scope, out).length,
        }
      } finally { scope.dispose() }
    }
    {
      const scope = new DisposeScope()
      try {
        const part = wedge(scope)
        const out = moved(scope, part, [{ face: tip(scope, part), distance: 30 }])
        // The stability invariant: moving further than the collapse point gives
        // the same sharp wedge.
        expect(plus10).not.toBeNull()
        expect(volumeOf(occ, scope, out)).toBeCloseTo(plus10!.volume, 6)
        expect(canonicalFaces(occ, scope, out)).toHaveLength(plus10!.faces)
        expect(canonicalEdges(occ, scope, out)).toHaveLength(plus10!.edges)
        expectValid(scope, out)
      } finally { scope.dispose() }
    }
  })

  it('a moved boss top lands on the box top and the cleanup merges them', () => {
    const scope = new DisposeScope()
    try {
      const box = scope.track(makeBox(occ, scope, 10, 10, 10))
      const boss = scope.track(cylinderSolid(scope, 5, 5, 10, 3, 2))
      const part = scope.track(boolParts(scope, box, boss, 'fuse'))
      const bossTop = pickByNormal(scope, part, [0, 0, 1], (c) => Math.abs(c[2] - 12) < 1e-6)
      const out = moved(scope, part, [{ face: bossTop, distance: -2 }])
      // The boss is gone and its top has merged into the box top.
      expectVolume(scope, out, 1000)
      expect(canonicalFaces(occ, scope, out)).toHaveLength(6)
      expectValid(scope, out)
    } finally { scope.dispose() }
  })

  it('the unbounded inward cutter crosses a disconnected lobe (the open point)', () => {
    // The L bracket: a horizontal leg x 0..40, z 0..10 and a vertical leg
    // x 0..10, z 0..40, depth 10. The vertical leg's inner face at x=10 faces
    // +X into the notch; moving it -5 puts the cutter at x=5.
    //
    // OPEN QUESTION, pinned by the literal unbounded reading the user left
    // unsettled: the moved surface is boundaryless, so its infinite plane cuts
    // the horizontal leg too. The result is the x <= 5 slab of the whole L
    // (volume 5 * 40 * 10), not just the part of the vertical leg connected to
    // the moved face. If the user later decides only connected material is
    // meant to go, this expectation changes, not the implementation silently.
    const scope = new DisposeScope()
    try {
      const part = scope.track(prismProfile(scope, [[0, 0], [40, 0], [40, 10], [10, 10], [10, 40], [0, 40]], 10))
      expectVolume(scope, part, 40 * 10 * 10 + 10 * 30 * 10)
      const inner = pickByNormal(scope, part, [1, 0, 0], (c) => Math.abs(c[0] - 10) < 1e-6)
      const out = moved(scope, part, [{ face: inner, distance: -5 }])
      expectVolume(scope, out, 5 * 40 * 10)
      expectValid(scope, out)
    } finally { scope.dispose() }
  })
})
