// @vitest-environment node
//
// Step 0 probe for sweep-multisection: does the SHIPPED OCCT 7.4 WASM build
// build the build123d handle example through BRepOffsetAPI_MakePipeShell with
// one Add_1 per section? The plan measured 7.9 in OCP; this file pins what 7.4
// actually does, because every decision below (Generated() coverage, cap
// shapes, the round transition, the 8/4 failure) depends on it.
//
// Raw OCC on purpose: no solveSweep, no schema. The handle's spine is two cubic
// Beziers and its sections are circles at both ends with rounded rectangles
// between them. The expected volume is build123d's 94.7736; our two-edge spine
// measured 94.7809 in 7.9.
//
// Skips when opencascade.js is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope, drainList } from '../disposeScope'
import { volumeOf } from '../volume'
import { sketchLoopsToFace } from '../prismProfile'
import { healWire, faceNormal, makeBezierEdge, makeLineEdge, makeWire, type Vec3 } from '../primitives'
import type { OccModule, OccOrientableShape, OccShape, OccPipeShellBuilder } from '../occTypes'
import type { PlaneLike } from '../../features/shared/planes'
import type { LoopEdge } from '../../profileLoops'

const oc = await loadOcc()

/** Station P and in-plane normal N from the plan's section 7 table, plus the
 *  spine tangent T. The path lies on the Front plane, so 2D (x, y) -> world
 *  (x, y, 0) and N is the section plane's local x axis. */
type Station = { p: [number, number]; n: [number, number]; t: [number, number] }
const STATIONS: Station[] = [
  { p: [-10, 0], n: [1, 0], t: [0, 1] },
  { p: [-8.428892, 3.8503], n: [0.600653, -0.79951], t: [0.79951, 0.600653] },
  { p: [-4.320748, 4.978977], n: [0.053869, -0.998548], t: [0.998548, 0.053869] },
  { p: [0, 5], n: [0, 1], t: [1, 0] },
  { p: [4.320748, 4.978977], n: [-0.053869, -0.998548], t: [0.998548, -0.053869] },
  { p: [8.428892, 3.8503], n: [-0.600653, -0.79951], t: [0.79951, -0.600653] },
  { p: [10, 0], n: [-1, 0], t: [0, -1] },
]

// The spine's two cubic Bezier edges, from the plan's measured build123d path
// (given there in build123d (x, z); Front-plane y is that z).
const BEZIER_A: Vec3[] = [
  [-10, 0, 0],
  [-10, 5.590169943749474, 0],
  [-5, 5, 0],
  [0, 5, 0],
]
const BEZIER_B: Vec3[] = [
  [0, 5, 0],
  [5, 5, 0],
  [10, 5.590169943749474, 0],
  [10, 0, 0],
]

function sectionPlane(st: Station): PlaneLike {
  const x: Vec3 = [st.n[0], st.n[1], 0]
  const y: Vec3 = [0, 0, 1]
  return {
    origin: [st.p[0], st.p[1], 0],
    x_axis: x,
    y_axis: y,
    // cross(x, y): the plane's own normal, which is parallel to the tangent.
    normal: [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]],
  }
}

/** The shipped `@builtin_plane_top`: sketch y is -world z, normal +world y. The
 *  end circles live on this plane in the real build, and the circle seam
 *  follows the frame's x axis. Probing them on a station frame with y = +world z
 *  moves the seam, which splits two extra lateral faces: the same handle reads
 *  20 faces here against the shipped 22. So the probe builds them the shipped
 *  way, and its face-count pin covers the real build. */
const TOP: PlaneLike = {
  origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 0, -1], normal: [0, 1, 0],
}

/** A rounded rectangle loop in sketch coords: w along local x, h along local y,
 *  radius r at each corner. Straight edges first so the edge count is 8. */
function roundedRectLoop(w: number, h: number, r: number): LoopEdge[] {
  const hx = w / 2
  const hy = h / 2
  const line = (a: [number, number], b: [number, number]): LoopEdge =>
    ({ kind: 'line', start: a, end: b }) as LoopEdge
  const arc = (c: [number, number], a0: number, a1: number): LoopEdge => {
    const rad = (deg: number): number => (deg * Math.PI) / 180
    return {
      kind: 'arc',
      center: c,
      radius: r,
      angle_start_deg: a0,
      angle_end_deg: a1,
      ccw: true,
      start: [c[0] + r * Math.cos(rad(a0)), c[1] + r * Math.sin(rad(a0))],
      end: [c[0] + r * Math.cos(rad(a1)), c[1] + r * Math.sin(rad(a1))],
    } as LoopEdge
  }
  return [
    line([-hx + r, -hy], [hx - r, -hy]),
    arc([hx - r, -hy + r], -90, 0),
    line([hx, -hy + r], [hx, hy - r]),
    arc([hx - r, hy - r], 0, 90),
    line([hx - r, hy], [-hx + r, hy]),
    arc([-hx + r, hy - r], 90, 180),
    line([-hx, hy - r], [-hx, -hy + r]),
    arc([-hx + r, -hy + r], 180, 270),
  ]
}

/** A sharp square loop, for the 8/4 alternation probe. `shift` rotates the
 *  edge list so the wire starts at a different corner (same geometry). */
function squareLoop(w: number, shift = 0): LoopEdge[] {
  const h = w / 2
  const corners: [number, number][] = [[-h, -h], [h, -h], [h, h], [-h, h]]
  const out: LoopEdge[] = []
  for (let i = 0; i < 4; i++) {
    out.push({ kind: 'line', start: corners[i], end: corners[(i + 1) % 4] })
  }
  const k = ((shift % 4) + 4) % 4
  return [...out.slice(k), ...out.slice(0, k)]
}

/** A full circle as the two half arcs the sketch topology emits (the profile
 *  builder collapses them back to one closed circle edge). */
function circleLoop(r: number, cx = 0, cy = 0): LoopEdge[] {
  const arc = (a0: number, a1: number): LoopEdge => {
    const rad = (deg: number): number => (deg * Math.PI) / 180
    return {
      kind: 'arc',
      center: [cx, cy],
      radius: r,
      angle_start_deg: a0,
      angle_end_deg: a1,
      ccw: true,
      start: [cx + r * Math.cos(rad(a0)), cy + r * Math.sin(rad(a0))],
      end: [cx + r * Math.cos(rad(a1)), cy + r * Math.sin(rad(a1))],
    } as LoopEdge
  }
  return [arc(0, 180), arc(180, 360)]
}

/** The healed outer wire of a section face, oriented so its face normal agrees
 *  with the spine tangent at the station (the shipped rule in
 *  `sweepSections.prepareSection`). */
function sectionWire(
  occ: OccModule,
  scope: DisposeScope,
  loop: LoopEdge[],
  plane: PlaneLike,
  tangent: Vec3,
): OccShape {
  const face = scope.track(sketchLoopsToFace(occ, scope, [loop], plane))
  const raw = scope.track(occ.BRepTools.OuterWire(face))
  const healed = scope.track(healWire(occ, scope, raw))
  scope.release(raw)
  // Agree with the tangent: a section whose face points the other way is
  // flipped, the way the shipped build orients its wires.
  const normal = faceNormal(occ, scope, face)
  scope.release(face)
  const dot = normal[0] * tangent[0] + normal[1] * tangent[1] + normal[2] * tangent[2]
  if (dot >= 0) return healed
  const flipped = scope.track((healed as unknown as OccOrientableShape).Reversed())
  scope.release(healed)
  return flipped
}

/** Build the handle's section wires in station order. The end circles sit on
 *  the shipped `@builtin_plane_top` frame, so their seam matches the real
 *  build; the five rounded rectangles sit on their own station planes. */
function handleSections(occ: OccModule, scope: DisposeScope): OccShape[] {
  return STATIONS.map((st, i) => {
    const end = i === 0 || i === STATIONS.length - 1
    // The end circle's centre is the station point on world z = 0, and TOP's
    // sketch v is -world z, so the loop's local y is 0.
    return sectionWire(
      occ,
      scope,
      end ? circleLoop(1, st.p[0], 0) : roundedRectLoop(1.25, 3, 0.2),
      end ? TOP : sectionPlane(st),
      [st.t[0], st.t[1], 0],
    )
  })
}

function spineWire(occ: OccModule, scope: DisposeScope): OccShape {
  const a = scope.track(makeBezierEdge(occ, scope, BEZIER_A))
  const b = scope.track(makeBezierEdge(occ, scope, BEZIER_B))
  const raw = scope.track(makeWire(occ, scope, [a, b]))
  const healed = scope.track(healWire(occ, scope, raw))
  scope.release(a)
  scope.release(b)
  scope.release(raw)
  return healed
}

/** One pipe-shell attempt: Add_1 once per section, in the given order. */
function pipeSweep(
  occ: OccModule,
  scope: DisposeScope,
  spine: OccShape,
  wires: OccShape[],
  mode: 'right' | 'round' = 'right',
): { done: boolean; solid: OccShape | null; builder: OccPipeShellBuilder; error: string | null } {
  const builder = scope.track(new occ.BRepOffsetAPI_MakePipeShell(spine)) as OccPipeShellBuilder
  try {
    const tm = occ.BRepBuilderAPI_TransitionMode
    builder.SetTransitionMode(
      mode === 'round' ? tm.BRepBuilderAPI_RoundCorner : tm.BRepBuilderAPI_RightCorner,
    )
    for (const w of wires) builder.Add_1(w, false, false)
    builder.Build()
    const done = builder.IsDone() && builder.MakeSolid()
    return { done, solid: done ? scope.track(builder.Shape()) : null, builder, error: null }
  } catch (e) {
    return { done: false, solid: null, builder, error: (e as Error).message }
  }
}

function faceCount(occ: OccModule, scope: DisposeScope, shape: OccShape): number {
  const E = occ.TopAbs_ShapeEnum
  const exp = scope.track(new occ.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  let n = 0
  for (; exp.More(); exp.Next()) n++
  return n
}

/** How many faces each edge of `wire` generated through the builder. */
function generatedSizes(occ: OccModule, scope: DisposeScope, builder: OccPipeShellBuilder, wire: OccShape): number[] {
  const E = occ.TopAbs_ShapeEnum
  const exp = scope.track(new occ.TopExp_Explorer_2(wire, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  const sizes: number[] = []
  for (; exp.More(); exp.Next()) {
    const raw = scope.track(exp.Current())
    const edge = scope.track(occ.TopoDS.Edge_1(raw))
    const gen = drainList(scope, builder.Generated(edge))
    let faces = 0
    for (const g of gen) {
      const gexp = scope.track(new occ.TopExp_Explorer_2(g, E.TopAbs_FACE, E.TopAbs_SHAPE))
      for (; gexp.More(); gexp.Next()) faces++
    }
    sizes.push(faces)
  }
  return sizes
}

describe.skipIf(!oc)('sweep multisection probe (real OCC 7.4)', () => {
  let occ: OccModule
  beforeAll(() => {
    if (!oc) throw new Error('unreachable: skipIf guards this')
    occ = oc
  })

  it('builds the handle from circles plus five rounded-rectangle sections', () => {
    const scope = new DisposeScope()
    try {
      const spine = spineWire(occ, scope)
      const { done, solid, error } = pipeSweep(occ, scope, spine, handleSections(occ, scope))
      expect(error).toBeNull()
      expect(done).toBe(true)
      if (!solid) throw new Error('no solid')
      const volume = volumeOf(occ, scope, solid)
      console.log('probe handle volume:', volume)
      // build123d's assert: 94.7736. The two-edge spine measured 94.7809 in 7.9
      // and 94.7809299 in the shipped 7.4; the plan's band is 0.05.
      expect(Math.abs(volume - 94.7736)).toBeLessThan(0.05)
      expect(volume).toBeCloseTo(94.7809299, 3)
      // 22, the same count the shipped build and the handle regression pin: the
      // end circles are on the shipped TOP frame, so the probe's seam is the
      // real one. (With y = +z on the end sections the seam moves and the same
      // handle reads 20.)
      expect(faceCount(occ, scope, solid)).toBe(22)
    } finally {
      scope.dispose()
    }
  }, 60_000)

  it('reports Generated() coverage for every section edge in 7.4', () => {
    const scope = new DisposeScope()
    try {
      const spine = spineWire(occ, scope)
      const wires = handleSections(occ, scope)
      const { done, builder } = pipeSweep(occ, scope, spine, wires)
      expect(done).toBe(true)
      const perSection = wires.map((w) => generatedSizes(occ, scope, builder, w))
      console.log('probe Generated sizes per section:', JSON.stringify(perSection))
      expect(perSection).toHaveLength(STATIONS.length)
      // The circle sections collapse to one edge; the rectangles keep 8.
      expect(perSection[0]).toHaveLength(1)
      for (let i = 1; i < perSection.length - 1; i++) expect(perSection[i]).toHaveLength(8)
      // The plan requires at least the FIRST section to answer in 7.4.
      expect(perSection[0].some((n) => n > 0)).toBe(true)
      // And every section must answer: a section with a zero Generated size is
      // one whose walls no entity could name, which is the whole point of
      // asking per section.
      for (let i = 0; i < perSection.length; i++) {
        expect(perSection[i].length).toBeGreaterThan(0)
        expect(perSection[i].every((n) => n > 0)).toBe(true)
      }
    } finally {
      scope.dispose()
    }
  }, 60_000)

  it('reports FirstShape/LastShape types', () => {
    const scope = new DisposeScope()
    try {
      const spine = spineWire(occ, scope)
      const { done, builder } = pipeSweep(occ, scope, spine, handleSections(occ, scope))
      expect(done).toBe(true)
      const count = (s: OccShape | undefined): number => {
        if (!s) return 0
        return faceCount(occ, scope, scope.track(s))
      }
      const first = builder.FirstShape?.()
      const last = builder.LastShape?.()
      const caps = { firstFaces: count(first), lastFaces: count(last) }
      console.log('probe caps:', JSON.stringify(caps))
      expect(caps.firstFaces).toBeGreaterThan(0)
      expect(caps.lastFaces).toBeGreaterThan(0)
    } finally {
      scope.dispose()
    }
  }, 60_000)

  it('fails the 8/4 alternation instead of crashing', () => {
    // Measured in 7.4: OCC does NOT throw where 7.9 threw NCollection_DataMap::Find.
    // It builds a valid 28-face solid with volume 60.87, which no bound in the
    // plan catches. This is why the shipped feature refuses a mismatched
    // neighbouring edge count itself (both sections more than one edge) instead
    // of relying on OCC to fail: the named error is the only reliable signal.
    const scope = new DisposeScope()
    try {
      const spine = spineWire(occ, scope)
      const wires = STATIONS.map((st, i) =>
        sectionWire(
          occ,
          scope,
          i === 0 || i === STATIONS.length - 1
            ? circleLoop(1)
            : i % 2 === 0
              ? roundedRectLoop(1.25, 3, 0.2)
              : squareLoop(1.25),
          sectionPlane(st),
          [st.t[0], st.t[1], 0],
        ),
      )
      const { done, solid, error } = pipeSweep(occ, scope, spine, wires)
      const diag = {
        done,
        error,
        volume: solid ? volumeOf(occ, scope, solid) : null,
        faces: solid ? faceCount(occ, scope, solid) : null,
        valid: solid ? scope.track(new occ.BRepCheck_Analyzer(solid, true)).IsValid_2() : null,
      }
      console.log('probe 8/4 alternation:', JSON.stringify(diag))
      expect(error).toBeNull()
      expect(done).toBe(true)
      expect(diag.faces).toBe(28)
      expect(diag.valid).toBe(true)
      expect(diag.volume).toBeCloseTo(60.8691, 3)
    } finally {
      scope.dispose()
    }
  }, 60_000)

  it('builds the handle with the round transition', () => {
    const scope = new DisposeScope()
    try {
      const spine = spineWire(occ, scope)
      const { done, solid, error } = pipeSweep(occ, scope, spine, handleSections(occ, scope), 'round')
      console.log('probe round:', JSON.stringify({ done, error, volume: solid ? volumeOf(occ, scope, solid) : null }))
      expect(error).toBeNull()
      expect(done).toBe(true)
      // Measured: the round transition builds the same handle volume, so the
      // field is kept and passed through instead of being refused.
      expect(solid ? volumeOf(occ, scope, solid) : 0).toBeCloseTo(94.7809299, 3)
    } finally {
      scope.dispose()
    }
  }, 60_000)

  it('is invariant to section order', () => {
    const scope = new DisposeScope()
    try {
      const spine = spineWire(occ, scope)
      const forward = handleSections(occ, scope)
      const vForward = volumeOf(occ, scope, pipeSweep(occ, scope, spine, forward).solid as OccShape)
      const vReversed = volumeOf(
        occ,
        scope,
        pipeSweep(occ, scope, spine, [...forward].reverse()).solid as OccShape,
      )
      expect(vReversed).toBeCloseTo(vForward, 6)
    } finally {
      scope.dispose()
    }
  }, 120_000)

  it('is invariant to a square start shift and a reversed section', () => {
    const scope = new DisposeScope()
    try {
      // A straight 10 mm spine along world z with two equal 2x2 squares.
      const line = scope.track(makeLineEdge(occ, scope, [0, 0, 0], [0, 0, 10]))
      const spine = scope.track(healWire(occ, scope, scope.track(makeWire(occ, scope, [line]))))
      scope.release(line)
      const base: PlaneLike = {
        origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1],
      }
      const top: PlaneLike = {
        origin: [0, 0, 10], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1],
      }
      // The spine runs +z, so [0, 0, 1] agrees with both planes and no section
      // is flipped: a dot of zero (what an in-plane tangent gives) reverses
      // nothing.
      const plain = [
        sectionWire(occ, scope, squareLoop(2), base, [0, 0, 1]),
        sectionWire(occ, scope, squareLoop(2), top, [0, 0, 1]),
      ]
      const vPlain = volumeOf(occ, scope, pipeSweep(occ, scope, spine, plain).solid as OccShape)
      const shifted = [
        sectionWire(occ, scope, squareLoop(2, 2), base, [0, 0, 1]),
        sectionWire(occ, scope, squareLoop(2, 1), top, [0, 0, 1]),
      ]
      const vShifted = volumeOf(occ, scope, pipeSweep(occ, scope, spine, shifted).solid as OccShape)
      // A genuinely reversed section: the tangent points down the spine, so the
      // top section's face disagrees with it and sectionWire reverses the wire.
      const reversed = [
        sectionWire(occ, scope, squareLoop(2), base, [0, 0, 1]),
        sectionWire(occ, scope, squareLoop(2), top, [0, 0, -1]),
      ]
      const vReversed = volumeOf(occ, scope, pipeSweep(occ, scope, spine, reversed).solid as OccShape)
      console.log('probe square shift:', JSON.stringify({ vPlain, vShifted, vReversed }))
      expect(vShifted).toBeCloseTo(vPlain, 6)
      expect(vReversed).toBeCloseTo(vPlain, 6)
      // 2x2 over 10 mm is 40.
      expect(vPlain).toBeCloseTo(40, 6)
      expect(vReversed).toBeCloseTo(40, 6)
    } finally {
      scope.dispose()
    }
  })
})
