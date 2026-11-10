// @vitest-environment node
//
// Gated real-OCC feature-level sweep tests using the full build pipeline
// (OCC.js + Rust WASM sketch solver). Ports all sweep scenarios from
// test_sweep.py.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { DisposeScope } from '../../occ/disposeScope'
import { HandleTable } from '../../occ/handleTable'
import { SharedHarness } from '../../occ/sharedHarness'
import { Repository } from '../../query'
import { solveSweep } from '../sweep'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { volumeOf, surfaceAreaOf } from '../../occ/volume'
import { shapeBbox } from '../../occ/faceBounds'
import { countSolids } from '../../occ/booleans'
import { fitSplineFromParams } from '@/utils/geometry/fitSpline'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import type { OccShape } from '../../occ/occTypes'
import type { Body } from '../../types3d'
const oc = await loadOcc()
const solveBytes = loadSolver()

function rectSketch(sketchId: string, w: number, h: number, plane = '@builtin_plane_front') {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane,
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: {
      bottom: [0, 0, w, 0],
      right: [w, 0, w, h],
      top: [w, h, 0, h],
      left: [0, h, 0, 0],
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
      { id: 'c9', kind: 'length' as const, target: { entity: 'bottom' }, value: w },
      { id: 'c10', kind: 'length' as const, target: { entity: 'left' }, value: h },
    ],
  }
}

function linePathSketch(sketchId: string, segments: number[], plane = '@builtin_plane_top') {
  // segments: flat array [x0,y0,x1,y1, x1,y1,x2,y2, ...]
  const entities: Array<{ id: string; kind: string }> = []
  const initial: Record<string, number[]> = {}
  const constraints: Array<Record<string, unknown>> = []
  let ci = 0
  for (let i = 0; i < segments.length - 3; i += 4) {
    const eid = 'e' + i
    entities.push({ id: eid, kind: 'line' })
    initial[eid] = [segments[i], segments[i + 1], segments[i + 2], segments[i + 3]]
    if (i > 0) {
      constraints.push({ id: 'cc' + (++ci), kind: 'coincident' as const,
        a: { entity: eid, point: 'start' }, b: { entity: 'e' + (i - 4), point: 'end' } })
    }
  }
  return { id: sketchId, kind: 'sketch' as const, label: 'Path', plane,
    entities, initial, constraints }
}

function arcPathSketch(sketchId: string, cx: number, cy: number, r: number, a0: number, a1: number, plane = '@builtin_plane_top') {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Path', plane,
    entities: [{ id: 'arc0', kind: 'arc' }],
    initial: { arc0: [cx, cy, r, a0, a1] },
    constraints: [],
  }
}

// A circle profile centred on the plane origin (so it sits ON the path start).
function circleSketch(sketchId: string, r: number, plane = '@builtin_plane_right') {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Profile', plane,
    entities: [{ id: 'c0', kind: 'circle' as const }],
    initial: { c0: [0, 0, r] },
    constraints: [],
  }
}

// A circle profile at an explicit sketch (cx, cy), so it anchors an offset
// spine start (the ellipse-arc path starts at a rim point, not the origin).
function circleAtSketch(sketchId: string, r: number, cx: number, cy: number, plane: string) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Profile', plane,
    entities: [{ id: 'c0', kind: 'circle' as const }],
    initial: { c0: [cx, cy, r] },
    constraints: [],
  }
}

// One open cubic Bezier path edge on the top plane: (0,0) -> (4,0) bowing to
// local y=-3 (world +z), so the swept body bulges to z ~ +2.25 while its
// straight chord stays at z=0. The pre-fix spine built that chord.
function splinePathSketch(sketchId: string) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Path', plane: '@builtin_plane_top',
    entities: [{ id: 'sp0', kind: 'spline' }],
    initial: { sp0: [0, 0, 0, -3, 4, -3, 4, 0] },
    constraints: [],
  }
}

// An ellipse (a=5, b=3) sliced by a line through the rim points (5,0) and
// (0,3): the topology emits two ellipse_arc edges that together close the
// full ellipse. Picking the ellipse entity selects both arcs, so the spine is
// the exact closed ellipse, not the (5,0)->(0,3) chord the line carries.
function ellipseArcPathSketch(sketchId: string) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Path', plane: '@builtin_plane_top',
    entities: [{ id: 'el0', kind: 'ellipse' }, { id: 'ln0', kind: 'line' }],
    initial: {
      el0: [0, 0, 5, 3, 0],
      ln0: [5, 0, 0, 3],
    },
    constraints: [],
  }
}

// The real corpus path (sketch 1): line -> tangent arc -> line on builtin_plane_top.
// `segs` chooses how many path entities to include (2 = line+arc, 3 = line+arc+line).
// The 3-segment spine is the case that used to fail; collectPathEdges' joint-snap is
// what makes it assemble. Geometry reproduces a real user's failing model.
const CORPUS_LN0 = [0, 0, -10, 0]                      // [x0,y0,x1,y1]
const CORPUS_ARC = [-10, -5, 5, 90, -211.456]          // [cx,cy,r,a0deg,a1deg]
const CORPUS_LN1 = [-14.265, -2.391, -19.484, -10.921]
function corpusPathSketch(sketchId: string, segs: 2 | 3, plane = '@builtin_plane_top') {
  const entities: Array<{ id: string; kind: string }> = [
    { id: 'ln0', kind: 'line' }, { id: 'arc0', kind: 'arc' },
  ]
  const initial: Record<string, number[]> = { ln0: CORPUS_LN0, arc0: CORPUS_ARC }
  const constraints: Array<Record<string, unknown>> = [
    { id: 'cc1', kind: 'coincident' as const,
      a: { entity: 'arc0', point: 'start' }, b: { entity: 'ln0', point: 'end' } },
  ]
  if (segs === 3) {
    entities.push({ id: 'ln1', kind: 'line' })
    initial.ln1 = CORPUS_LN1
    constraints.push({ id: 'cc2', kind: 'coincident' as const,
      a: { entity: 'ln1', point: 'start' }, b: { entity: 'arc0', point: 'end' } })
  }
  return { id: sketchId, kind: 'sketch' as const, label: 'Path', plane, entities, initial, constraints }
}

function sweepSpec(sweepId: string, profileId: string, pathId: string, opts: { operation?: string; mergeTarget?: string } = {}) {
  const spec: Record<string, unknown> = {
    id: sweepId, kind: 'sweep', label: 'Sweep',
    sweep: { sketch: ['$' + profileId], path: '$' + pathId, operation: opts.operation ?? 'new' },
  }
  if (opts.mergeTarget) spec.sweep = { ...spec.sweep as Record<string, unknown>, merge_target: opts.mergeTarget }
  return spec
}

type Dict = Record<string, unknown>

/** A closed square boundary in sketch coords, centred on (cx, cy). */
function squareSurface(cx: number, cy: number, half: number, prefix = 's'): Dict[] {
  const c: [number, number][] = [
    [cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half], [cx - half, cy + half],
  ]
  return c.map((p, i) => ({
    id: prefix + (i + 1), kind: 'line', start: p, end: c[(i + 1) % 4],
  }))
}

/** A seeded one-profile sweep: the profile sits on the Front plane and the
 *  path is one Top-plane line, so no Rust sketch solve is needed. */
function seedOneProfileRepo(
  profile: Dict[],
  pathSegments: [number, number, number, number][] = [[0, 0, 0, 10]],
): Repository {
  const repo = new Repository()
  repo.register('_pt_prof', { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] })
  repo.register('_topo_prof', { surfaces: [{ boundary: profile }] })
  repo.register('_pt_path', { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 0, -1], normal: [0, 1, 0] })
  repo.register('_topo_path', {
    edges: pathSegments.map((p, i) => ({
      entity_id: 'p' + i, edge_index: i, kind: 'line',
      start: [p[0], p[1]], end: [p[2], p[3]],
    })),
  })
  return repo
}

function assertMeshValid(mesh: Record<string, unknown>): void {
  const verts = mesh.vertices as number[][] | undefined
  const faces = mesh.faces as number[][] | undefined
  if (!verts || !faces) throw new Error('mesh missing vertices or faces')
  const n = verts.length
  if (n === 0) throw new Error('mesh has no vertices')
  if (faces.length === 0) throw new Error('mesh has no faces')
  for (let i = 0; i < faces.length; i++) {
    const [a, b, c] = faces[i]
    if (a < 0 || a >= n) throw new Error(`face ${i}: vertex a=${a} out of range [0,${n})`)
    if (b < 0 || b >= n) throw new Error(`face ${i}: vertex b=${b} out of range [0,${n})`)
    if (c < 0 || c >= n) throw new Error(`face ${i}: vertex c=${c} out of range [0,${n})`)
    if (a === b || b === c || a === c) throw new Error(`face ${i} is degenerate: (${a},${b},${c})`)
  }
}

describe.skipIf(!oc || !solveBytes)('sweep feature (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) }
  })

  it('basic sweep produces a valid body with mesh', () => {
    // A rectangle profile swept along a straight path produces a valid body.
    const result = h.run({
      features: [
        rectSketch('prof', 2, 3, '@builtin_plane_front'),
        linePathSketch('pth', [0, 0, 0, 5]),
        sweepSpec('sw1', 'prof', 'pth'),
      ],
    })
    expect(h.res(result, 'sw1').status).toBe('ok')
    expect(result.bodies).toHaveProperty('body_sw1')
    const mesh = h.body(result, 'body_sw1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshValid(mesh)
  })

  it('straight sweep bbox is correct box dimensions', () => {
    /**
     * A 2x3 profile on the front plane swept 5 units along the Top-plane path (running along
     * world -z) produces a box spanning x[0,2] y[0,3] z[-5,0].
     */
    const result = h.run({
      features: [
        rectSketch('prof', 2, 3, '@builtin_plane_front'),
        linePathSketch('pth', [0, 0, 0, 5]),
        sweepSpec('sw1', 'prof', 'pth'),
      ],
    })
    expect(h.res(result, 'sw1').status).toBe('ok')
    const mesh = h.body(result, 'body_sw1').mesh as { vertices: number[][] } | undefined
    expect(mesh).toBeDefined()
    if (mesh) {
      const xs = mesh.vertices.map((v) => v[0])
      const ys = mesh.vertices.map((v) => v[1])
      const zs = mesh.vertices.map((v) => v[2])
      expect(Math.min(...xs)).toBeCloseTo(0, 0)
      expect(Math.max(...xs)).toBeCloseTo(2, 0)
      expect(Math.min(...ys)).toBeCloseTo(0, 0)
      expect(Math.max(...ys)).toBeCloseTo(3, 0)
      expect(Math.min(...zs)).toBeCloseTo(-5, 0)
      expect(Math.max(...zs)).toBeCloseTo(0, 0)
    }
  })

  it('polyline path sweeps without error', () => {
    // An L-shaped two-segment path sweeps without error.
    const result = h.run({
      features: [
        rectSketch('prof', 1, 1, '@builtin_plane_front'),
        linePathSketch('pth', [0, 0, 0, 4, 0, 4, 3, 4]),
        sweepSpec('sw1', 'prof', 'pth'),
      ],
    })
    expect(h.res(result, 'sw1').status).toBe('ok')
    const mesh = h.body(result, 'body_sw1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshValid(mesh)
  })

  it('arc path sweeps without error', () => {
    /**
     * A quarter-circle arc path (<=180 deg) sweeps without error. Profile on Right plane so its
     * normal lines up with the arc's starting tangent.
     */
    const result = h.run({
      features: [
        rectSketch('prof', 1, 1, '@builtin_plane_right'),
        arcPathSketch('pth', 0, 5, 5, -90, 0),
        sweepSpec('sw1', 'prof', 'pth'),
      ],
    })
    expect(h.res(result, 'sw1').status).toBe('ok')
    const mesh = h.body(result, 'body_sw1').mesh as Record<string, unknown> | undefined
    expect(mesh).toBeDefined()
    if (mesh) assertMeshValid(mesh)
  })

  function bbox(mesh: { vertices: number[][] }): { min: number[]; max: number[] } {
    const min = [Infinity, Infinity, Infinity]
    const max = [-Infinity, -Infinity, -Infinity]
    for (const v of mesh.vertices) for (let i = 0; i < 3; i++) {
      if (v[i] < min[i]) min[i] = v[i]
      if (v[i] > max[i]) max[i] = v[i]
    }
    return { min, max }
  }

  it('corpus path: 2 segments (line+arc) sweeps to a valid body', () => {
    const result = h.run({
      features: [
        circleSketch('prof', 1.7, '@builtin_plane_right'),
        corpusPathSketch('pth', 2),
        sweepSpec('sw1', 'prof', 'pth'),
      ],
    })
    const r = h.res(result, 'sw1')
    const mesh = h.body(result, 'body_sw1').mesh as { vertices: number[][] } | undefined
    expect(r.status).toBe('ok')
    expect(mesh).toBeDefined()
    if (mesh) assertMeshValid(mesh)
  })

  it('corpus path: 3 segments (line+arc+line) sweeps to the correct shape', () => {
    const result = h.run({
      features: [
        circleSketch('prof', 1.7, '@builtin_plane_right'),
        corpusPathSketch('pth', 3),
        sweepSpec('sw1', 'prof', 'pth'),
      ],
    })
    const r = h.res(result, 'sw1')
    const mesh = h.body(result, 'body_sw1').mesh as { vertices: number[][] } | undefined
    expect(r.status).toBe('ok')
    expect(mesh).toBeDefined()
    if (mesh) {
      assertMeshValid(mesh)
      const bb = bbox(mesh)
      // The third line ends at world x=-19.48, z=10.92. A correct sweep must
      // reach there; a broken/backward third segment or a collapsed wire would
      // not extend the body past the arc end (~x=-14, z=2.4).
      expect(bb.min[0]).toBeLessThan(-18)   // reaches x ~ -19.5
      expect(bb.max[2]).toBeGreaterThan(9)  // reaches z ~ +10.9
    }
  })

  it('cut sweep removes volume from existing body', () => {
    // A cut sweep subtracts material from an existing body.
    const result = h.run({
      features: [
        rectSketch('base', 6, 6, '@builtin_plane_front'),
        { id: 'ext0', kind: 'extrude', label: 'Base',
          extrude: { sketch: ['$base'], distance: -6, operation: 'new' } },
        rectSketch('prof', 2, 2, '@builtin_plane_front'),
        linePathSketch('pth', [0, 0, 0, 6]),
        sweepSpec('sw1', 'prof', 'pth', { operation: 'cut' }),
      ],
    })
    expect(h.res(result, 'sw1').status).toBe('ok')
    expect(h.res(result, 'sw1').operation).toBe('cut')
  })

  it('spline spine sweeps along the real curve, not its chord (H14)', () => {
    // A circular profile swept along one cubic Bezier: the body must bulge to
    // z ~ +2.25 where the straight chord between the spline's endpoints sits at
    // z=0, so the pre-fix chord spine could never reach the bbox this asserts.
    const result = h.run({
      features: [
        circleSketch('prof', 0.5, '@builtin_plane_front'),
        splinePathSketch('pth'),
        sweepSpec('sw1', 'prof', 'pth'),
      ],
    })
    expect(h.res(result, 'sw1').status).toBe('ok')
    const mesh = h.body(result, 'body_sw1').mesh as { vertices: number[][] } | undefined
    expect(mesh).toBeDefined()
    if (mesh) {
      assertMeshValid(mesh)
      const bb = bbox(mesh)
      // The spline's apex is at world z ~ +2.25; the chord maxes at z=+0.5
      // (the profile radius alone). A chord-spine body fails this by ~1.75.
      expect(bb.max[2]).toBeGreaterThan(2)
    }
  })

  it('elliptical-arc spine sweeps the arc, not the chord (H14)', () => {
    // A circular profile swept along a sliced ellipse: the spine is the exact
    // closed ellipse (quarter arcs), so the tube dips to z ~ -3.5 at the
    // ellipse's bottom. The pre-fix chord spine (the (5,0)->(0,3) line doubled)
    // collapses the sweep and never reaches z=-3.
    const result = h.run({
      features: [
        circleAtSketch('prof', 0.5, 5, 0, '@builtin_plane_front'),
        ellipseArcPathSketch('pth'),
        { id: 'sw1', kind: 'sweep', label: 'Sweep',
          sweep: { sketch: ['$prof'], path: 'entity:pth:el0', operation: 'new' } },
      ],
    })
    expect(h.res(result, 'sw1').status).toBe('ok')
    const mesh = h.body(result, 'body_sw1').mesh as { vertices: number[][] } | undefined
    expect(mesh).toBeDefined()
    if (mesh) {
      assertMeshValid(mesh)
      const bb = bbox(mesh)
      // The ellipse's bottom rim (0,0,-3) is off-chord: the chord between the
      // arc endpoints runs to z=-1.5 only, so a chord-spine body stays above.
      expect(bb.min[2]).toBeLessThan(-3)
      // And the tube extends past the rim by the profile radius.
      expect(bb.max[0]).toBeGreaterThan(5)
    }
  })

  it('refuses a closed ellipse path entity by name through the real pipeline (H14)', () => {
    // The Rust area builder never emits a full `ellipse` edge into topo.edges
    // (a standalone ellipse appears only as a surface), so drive solveSweep
    // against a hand-seeded repo: the new pathRefWorldEdges guard must refuse
    // the closed curve by name instead of a raw TypeError.
    const scope = new DisposeScope()
    const table = new HandleTable()
    const repo = new Repository()
    const FRONT = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }
    const TOP = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 0, -1], normal: [0, 1, 0] }
    repo.register('_pt_skP', FRONT)
    repo.register('_topo_skP', {
      surfaces: [{
        boundary: [
          { kind: 'line', start: [0, 0], end: [2, 0] },
          { kind: 'line', start: [2, 0], end: [2, 3] },
          { kind: 'line', start: [2, 3], end: [0, 3] },
          { kind: 'line', start: [0, 3], end: [0, 0] },
        ],
      }],
    })
    repo.register('_pt_skPath', TOP)
    repo.register('_topo_skPath', {
      edges: [{ entity_id: 'E1', edge_index: 0, kind: 'ellipse', center: [0, 0], a: 5, b: 3, theta: 0 }],
    })
    try {
      expect(() =>
        solveSweep(oc!, scope, table, { id: 'sw1', sweep: { sketch: ['$skP'], path: '$skPath' } }, repo, {}),
      ).toThrow(/closed ellipse/)
    } finally {
      scope.dispose()
    }
  })

  it('refuses a one-profile path that misses the profile, naming the distance', () => {
    // Before the station rule this built a displaced body with status ok: the
    // path starts at the origin and the profile sits 5 mm to the side.
    const scope = new DisposeScope()
    const table = new HandleTable()
    const repo = seedOneProfileRepo(squareSurface(5, 0, 1))
    let message = ''
    try {
      try {
        solveSweep(oc!, scope, table, {
          id: 'sw1', kind: 'sweep',
          sweep: { sketch: ['$prof'], path: '$path', operation: 'new' },
        }, repo, {})
      } catch (exc) {
        message = (exc as Error).message
      }
    } finally {
      table.disposeAll()
      scope.dispose()
    }
    expect(message).toBe(
      "sweep: the profile is too far from the path: the nearest crossing is 4 mm outside it " +
      "(the band is the profile's own size) (path '$path')",
    )
  })

  it('builds a one-profile sweep whose crossing is inside the profile', () => {
    const scope = new DisposeScope()
    const table = new HandleTable()
    const bodyStore: Record<string, Body> = {}
    const repo = seedOneProfileRepo(squareSurface(0, 0, 1))
    try {
      const result = solveSweep(oc!, scope, table, {
        id: 'sw1', kind: 'sweep',
        sweep: { sketch: ['$prof'], path: '$path', operation: 'new' },
      }, repo, bodyStore)
      expect(result.status).toBe('ok')
      const body = bodyStore['body_sw1']
      expect(body).toBeDefined()
      const volume = volumeOf(oc!, scope, table.get<OccShape>(body.shape!))
      expect(volume).toBeCloseTo(40, 2)
    } finally {
      table.disposeAll()
      scope.dispose()
    }
  })

  it('refuses a profile lying along the path as a shallow angle', () => {
    // The torus reduced to one line: the whole path lies in the profile plane,
    // so the crossing exists but has no component across the plane.
    const scope = new DisposeScope()
    const table = new HandleTable()
    const repo = seedOneProfileRepo(squareSurface(0, 0, 1), [[0, 0, 10, 0]])
    try {
      expect(() =>
        solveSweep(oc!, scope, table, {
          id: 'sw1', kind: 'sweep',
          sweep: { sketch: ['$prof'], path: '$path', operation: 'new' },
        }, repo, {}),
      ).toThrow('sweep: the profile meets the path at a shallow angle; draw the profile square to the path')
    } finally {
      table.disposeAll()
      scope.dispose()
    }
  })

  it('keeps a profile on the path start and refuses the same profile moved across it', () => {
    // The bottle half: the intended thread sits on the helix start side; the
    // same profile on the other side of the neck is not pierced and must not
    // build as a displaced body.
    const solve = (cx: number): { status?: string; body?: Body; error?: string } => {
      const scope = new DisposeScope()
      const table = new HandleTable()
      const bodyStore: Record<string, Body> = {}
      try {
        try {
          const result = solveSweep(oc!, scope, table, {
            id: 'sw1', kind: 'sweep',
            sweep: { sketch: ['$prof'], path: '$path', operation: 'new' },
          }, seedOneProfileRepo(squareSurface(cx, 0, 1)), bodyStore)
          return { status: result.status, body: bodyStore['body_sw1'] }
        } catch (exc) {
          return { error: (exc as Error).message }
        }
      } finally {
        table.disposeAll()
        scope.dispose()
      }
    }
    const onStart = solve(0)
    expect(onStart.status).toBe('ok')
    expect(onStart.body).toBeDefined()
    const moved = solve(6)
    expect(moved.error).toBe(
      "sweep: the profile is too far from the path: the nearest crossing is 5 mm outside it " +
      "(the band is the profile's own size) (path '$path')",
    )
  })

  it('builds a square offset beside a straight path, the same prism as the centred square', () => {
    // The one-profile form carries the profile from the path start as drawn, so
    // a profile beside the path keeps its offset in the moving frame instead of
    // being refused: the band is the profile's own size.
    const build = (cx: number): { status?: string; volume?: number; error?: string } => {
      const scope = new DisposeScope()
      const table = new HandleTable()
      const bodyStore: Record<string, Body> = {}
      try {
        try {
          const result = solveSweep(oc!, scope, table, {
            id: 'sw1', kind: 'sweep',
            sweep: { sketch: ['$prof'], path: '$path', operation: 'new' },
          }, seedOneProfileRepo(squareSurface(cx, 0, 1)), bodyStore)
          const body = bodyStore['body_sw1']
          return {
            status: result.status,
            volume: body?.shape == null ? undefined : volumeOf(oc!, scope, table.get<OccShape>(body.shape)),
          }
        } catch (exc) {
          return { error: (exc as Error).message }
        }
      } finally {
        table.disposeAll()
        scope.dispose()
      }
    }
    const centred = build(0)
    expect(centred.status).toBe('ok')
    expect(centred.volume).toBeCloseTo(40, 6)
    // The 2x2 square spans x 1..3, so its nearest edge is 1 from the crossing
    // and its own diagonal is 2.83: inside the band. The offset sweep is a
    // translated prism, so the volume is unchanged.
    const offset = build(2)
    expect(offset.error).toBeUndefined()
    expect(offset.status).toBe('ok')
    expect(offset.volume).toBeCloseTo(centred.volume!, 6)
  })
})

// ─── swept off the profile plane ───

// The builtin top plane: sketch (u, v) -> world (u, 0, -v).
const TOP = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 0, -1], normal: [0, 1, 0] }

// A standalone circle boundary: a full ellipse edge is its own closed loop.
const CIRCLE_BOUNDARY: Dict[] = [{ kind: 'ellipse', id: 'c0', center: [0, 0], a: 1, b: 1, theta: 0 }]

/** The Front plane, moved to z. */
function frontPlaneAt(z: number): Dict {
  return { origin: [0, 0, z], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }
}

/** A Front circle profile and a Top fit_spline path through `points` (sketch
 *  coords). The poles come from the same interpolation the sketch topology
 *  carries, so the seeded path is the curve the solver would emit. */
function seedFitPathRepo(profilePlane: Dict, points: [number, number][]): Repository {
  const curve = fitSplineFromParams(points.flat())
  const poles = curve.poles()
  const repo = new Repository()
  repo.register('_pt_prof', profilePlane)
  repo.register('_topo_prof', { surfaces: [{ boundary: CIRCLE_BOUNDARY }] })
  repo.register('_pt_path', TOP)
  repo.register('_topo_path', {
    edges: [{
      entity_id: 'p0', edge_index: 0, kind: 'fit_spline',
      start: poles[0], end: poles[poles.length - 1],
      poles, knots: curve.knots,
    }],
  })
  return repo
}

type SeededBuild = {
  status?: string
  volume?: number
  area?: number
  // [xmin, ymin, zmin, xmax, ymax, zmax], the measure path's exact box.
  bbox?: number[]
  solids?: number
  error?: string
}

/** Solve one seeded repo through solveSweep and read the built body's mass
 *  properties before the scope drains. */
function solveSeeded(repo: Repository): SeededBuild {
  const scope = new DisposeScope()
  const table = new HandleTable()
  const bodyStore: Record<string, Body> = {}
  try {
    try {
      const result = solveSweep(oc!, scope, table, {
        id: 'sw1', kind: 'sweep',
        sweep: { sketch: ['$prof'], path: '$path', operation: 'new' },
      }, repo, bodyStore)
      const body = bodyStore['body_sw1']
      if (body?.shape == null) return { status: result.status }
      const solid = table.get<OccShape>(body.shape)
      return {
        status: result.status,
        volume: volumeOf(oc!, scope, solid),
        area: surfaceAreaOf(oc!, scope, solid),
        bbox: shapeBbox(oc!, scope, solid),
        solids: countSolids(oc!, scope, solid),
      }
    } catch (exc) {
      return { error: (exc as Error).message }
    }
  } finally {
    table.disposeAll()
    scope.dispose()
  }
}

// Seeded repos, so only OCC gates it; CI has no OCC binary and must skip.
describe.skipIf(!oc)('sweep profile off its plane, carried from the path start (Ex023)', () => {
  // A Top fit_spline through sketch (0,-1), (1,-2), (2,-4): world (0,0,1),
  // (1,0,2), (2,0,4). It starts 1 above the z=0 plane, moving away from it.
  const PATH_POINTS: [number, number][] = [[0, -1], [1, -2], [2, -4]]

  it('builds the circle swept by a path that starts off its plane', () => {
    const built = solveSeeded(seedFitPathRepo(frontPlaneAt(0), PATH_POINTS))
    expect(built.error).toBeUndefined()
    expect(built.status).toBe('ok')
    expect(built.solids).toBe(1)
  })

  it('keeps the start cap on the plane the circle was drawn on', () => {
    // The path starts at z=1; a build that moved the profile to the start would
    // put the cap there instead of on z=0, where the circle was drawn.
    const built = solveSeeded(seedFitPathRepo(frontPlaneAt(0), PATH_POINTS))
    expect(built.bbox).toBeDefined()
    expect(built.bbox![2]).toBeCloseTo(0, 6)
  })

  it('is not the profile moved to the path start', () => {
    const offPlane = solveSeeded(seedFitPathRepo(frontPlaneAt(0), PATH_POINTS))
    const onStart = solveSeeded(seedFitPathRepo(frontPlaneAt(1), PATH_POINTS))
    expect(offPlane.error).toBeUndefined()
    expect(onStart.error).toBeUndefined()
    // The section area is the same wherever it is drawn, so the volumes agree.
    expect(Math.abs(offPlane.volume! - onStart.volume!)).toBeLessThanOrEqual(onStart.volume! * 1e-9)
    // But the bodies differ: the offset is carried in the moving frame, so the
    // surface area is visibly different.
    expect(Math.abs(offPlane.area! - onStart.area!)).toBeGreaterThan(1)
  })

  it('matches CadQuery 2.8 with its default CorrectedFrenet trihedron', () => {
    // CadQuery's default sweep is isFrenet=False, which is MakePipeShell's own
    // default mode (no binormal), the one this path takes.
    const built = solveSeeded(seedFitPathRepo(frontPlaneAt(0), PATH_POINTS))
    expect(built.error).toBeUndefined()
    expect(Math.abs(built.volume! - 7.117723893)).toBeLessThan(7.117723893 * 1e-5)
    expect(Math.abs(built.area! - 27.07766965)).toBeLessThan(27.07766965 * 1e-5)
    expect(built.bbox![0]).toBeCloseTo(-1, 4)
    expect(built.bbox![1]).toBeCloseTo(-1, 4)
    expect(built.bbox![2]).toBeCloseTo(0, 4)
    expect(built.bbox![3]).toBeCloseTo(3.39650, 4)
    expect(built.bbox![4]).toBeCloseTo(1, 4)
    expect(built.bbox![5]).toBeCloseTo(3.77686, 4)
  })

  it('refuses a start farther off the plane than the profile size, naming the gap', () => {
    // Shifted 9 down in sketch v, i.e. 9 up in world z: the start is 10 above
    // the z=0 plane, past the circle's own 2.83 diagonal.
    const far = seedFitPathRepo(frontPlaneAt(0), [[0, -10], [1, -11], [2, -13]])
    const refused = solveSeeded(far)
    expect(refused.error).toBe(
      "sweep: the profile is too far from the path: the path never crosses its plane and starts 10 mm from it " +
      "(the band is the profile's own size) (path '$path')",
    )
  })

  it('refuses a path that starts parallel to the profile plane', () => {
    // A straight Top line at world z=1, parallel to the z=0 plane and 1 above
    // it: inside the band, but the profile would sweep edge-on.
    const repo = new Repository()
    repo.register('_pt_prof', frontPlaneAt(0))
    repo.register('_topo_prof', { surfaces: [{ boundary: CIRCLE_BOUNDARY }] })
    repo.register('_pt_path', TOP)
    repo.register('_topo_path', {
      edges: [{ entity_id: 'p0', edge_index: 0, kind: 'line', start: [0, -1], end: [5, -1] }],
    })
    const refused = solveSeeded(repo)
    expect(refused.error).toBe(
      'sweep: the profile meets the path at a shallow angle; draw the profile square to the path',
    )
  })
})
