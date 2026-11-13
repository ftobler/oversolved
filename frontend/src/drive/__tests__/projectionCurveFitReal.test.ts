// @vitest-environment node
//
// The real-kernel half of the sampled curve fit. Two sources exercise both
// lowering branches: a 270 degree sketch arc (a conic sweep, one cubic misses it
// by 1.6e-2 of its size) closed with its chord, and a closed body B-spline edge
// (the sampled `points` payload, the Resin_Mold loop) projected as it is. Each
// must solve clean and extrude a prism whose volume matches the analytic area of
// the true projected curve times the height. This is the path the area builder
// and OCC see: a C2 fit-spline chain edge, not a single cubic. Skips when OCC.js
// or the Rust solver is absent.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc, SketchFeature } from '@/types/cad'
import { runHeadless, selectHeadless, emptyDriveDoc } from '../headlessOps'
import { nonSketchProblems } from './buildProblems'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { sketchToWorld2d, worldToSketch2d } from '@/kernel/features/shared/planes'
import type { PlaneLike } from '@/kernel/features/shared/planes'
import { interpolateFitSpline, type Pt } from '@/utils/geometry/fitSpline'
import {
  CONIC_TRUTH_STEPS,
  curveScale,
  maxDeviationToFitSpline,
  PROJECTED_CURVE_FIT_TOL,
} from '@/utils/geometry/projectedCurveFit'
import type { ScriptStep } from '../scriptRunner'

function occInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('opencascade.js/dist/opencascade.wasm.js')
    return true
  } catch {
    return false
  }
}
const oc = occInstalled()
const solveBytes = loadSolver()
if (oc && solveBytes) {
  setOccLoader(loadOcc)
  setSketchSolver(solveBytes)
  setSketchTopology(loadTopology())
}
const ready = oc && solveBytes

/** A step carrying mutation fields the drive accepts but the Mutation union does
 *  not spell (a plane selector). */
const step = (mutation: Record<string, unknown>): ScriptStep => ({ mutation } as ScriptStep)

const RADIUS = 5
const SWEEP = (3 * Math.PI) / 2

/** The true projected arc in a sketch frame: the 3D source arc sampled densely
 *  and projected with the same frame the solve used. */
function projectedArc(frame: PlaneLike, steps = 2048): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i <= steps; i++) {
    const t = (SWEEP * i) / steps
    out.push(worldToSketch2d([RADIUS * Math.cos(t), RADIUS * Math.sin(t), 0], frame) as [number, number])
  }
  return out
}

/** Area enclosed by the true arc and its chord, by the shoelace formula. */
function projectedArea(frame: PlaneLike): number {
  const pts = projectedArc(frame)
  let twice = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    twice += a[0] * b[1] - b[0] * a[1]
  }
  return Math.abs(twice) / 2
}

function sketchOf(doc: PartDoc | null, id: string): SketchFeature | undefined {
  const feature = doc?.features?.find(candidate => candidate.id === id)
  return feature?.kind === 'sketch' ? feature : undefined
}

describe.skipIf(!ready)('projected sampled curve fit (real OCC + Rust solver)', () => {
  it('extrudes a profile closed through a 270 degree projected arc', async () => {
    const built = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        step({ type: 'add_sketch', featureId: 'sk1', label: 'Source', plane: '@builtin_plane_front' }),
        // A 270 degree arc of radius 5 about the sketch origin.
        step({ type: 'add_entity', featureId: 'sk1', kind: 'arc', params: [0, 0, RADIUS, 0, 270], entityId: 'a0' }),
        // A plane through the source centre, tilted 30 degrees off the source
        // plane about world X: the arc projects to a squeezed ellipse arc.
        step({
          type: 'add_plane', featureId: 'p1', label: 'Tilted', definition: {
            mode: 'origin_rotation', plane: '@builtin_plane_front', origin: [0, 0, 0],
            rotation_axis: 'x', rotation_angle: 30,
          },
        }),
        step({ type: 'add_sketch', featureId: 'sk2', label: 'Projected', plane: '@p1' }),
        step({
          type: 'add_projected_entity', featureId: 'sk2', kind: 'arc',
          source: '@sk1/a0', entityId: 'pa',
        }),
      ],
      frames: 'all',
    })
    expect(built.ok).toBe(true)
    const frame = built.frames?.sk2
    expect(frame).toBeDefined()

    // The projection resolved as a fit spline, and its first and last fit
    // points are the projected source ends.
    expect(sketchOf(built.doc, 'sk2')?.entities?.find(e => e.id === 'pa')?.kind).toBe('fit_spline')
    const params = sketchOf(built.doc, 'sk2')?.initial?.pa ?? []
    expect(params.length).toBeGreaterThan(8)
    const start: [number, number] = [params[0], params[1]]
    const end: [number, number] = [params[params.length - 2], params[params.length - 1]]
    const truth = projectedArc(frame!)
    expect(Math.hypot(start[0] - truth[0][0], start[1] - truth[0][1])).toBeLessThan(1e-5)
    expect(Math.hypot(
      end[0] - truth[truth.length - 1][0], end[1] - truth[truth.length - 1][1],
    )).toBeLessThan(1e-5)

    const area = projectedArea(frame!)
    const height = 2
    const closed = await runHeadless({
      doc: structuredClone(built.doc!),
      steps: [
        // The chord closes the loop; the two joints pin the line to the
        // projected curve's ends, so the sketch solves fully constrained.
        step({
          type: 'add_entity', featureId: 'sk2', kind: 'line',
          params: [end[0], end[1], start[0], start[1]], entityId: 'pl',
        }),
        step({
          type: 'add_constraint', featureId: 'sk2', kind: 'coincident',
          targets: ['vertex:sk2:pa:start', 'vertex:sk2:pl:end'],
        }),
        step({
          type: 'add_constraint', featureId: 'sk2', kind: 'coincident',
          targets: ['vertex:sk2:pa:end', 'vertex:sk2:pl:start'],
        }),
        step({
          type: 'add_extrude', featureId: 'ex1', label: 'Prism',
          sketchQuery: '$sk2', distance: height, operation: 'new',
        }),
      ],
    })
    expect(closed.ok).toBe(true)
    expect(nonSketchProblems(closed.features)).toEqual([])
    // The extrude built: it exposes no problem row of its own. A refused
    // B-spline chain would surface here by name.
    expect(closed.features.find(problem => problem.id === 'ex1')).toBeUndefined()
    expect(closed.featureDeltas?.find(entry => entry.id === 'sk2')?.status).toBe('fully_constrained')
    const volume = closed.featureDeltas?.find(entry => entry.id === 'ex1')?.volumeDelta
    expect(volume).toBeDefined()
    // The volume budget: the fit follows the true arc to its 1.5e-3 rung, but
    // the measured error is 9e-5 relative, so 1e-3 leaves an order of magnitude
    // of room for OCC's integration on a different build. OCC integrates the
    // B-spline chain exactly; there is no chord approximation on its side.
    expect(Math.abs(volume! - area * height) / (area * height)).toBeLessThan(1e-3)
  }, 240_000)

  it('projects a closed body spline edge as a closed fit spline', async () => {
    // The Resin_Mold shape: a profile closed by a B-spline loop. The extruded
    // body's cap edge carries a sampled polyline (kind spline, points), which is
    // the `kindH === 'spline'` path, and it comes back bit-identically closed.
    const loop: number[] = []
    for (let k = 0; k < 8; k++) {
      loop.push(3 * Math.cos((2 * Math.PI * k) / 8), 3 * Math.sin((2 * Math.PI * k) / 8))
    }
    loop.push(loop[0], loop[1])

    const solid = await runHeadless({
      doc: emptyDriveDoc(),
      steps: [
        step({ type: 'add_sketch', featureId: 'sk1', label: 'Loop', plane: '@builtin_plane_top' }),
        step({ type: 'add_entity', featureId: 'sk1', kind: 'fit_spline', params: loop, entityId: 'sp0' }),
        step({
          type: 'add_extrude', featureId: 'ex0', label: 'Column',
          sketchQuery: '$sk1', distance: 5, operation: 'new',
        }),
      ],
      frames: 'all',
    })
    expect(solid.ok).toBe(true)
    expect(nonSketchProblems(solid.features)).toEqual([])

    // The upper cap's boundary is the closed B-spline edge; the lower one is at
    // y = 0, so the extreme-y selector picks the far cap.
    const picked = await selectHeadless(solid.doc!, {
      kind: 'edge',
      where: { and: [{ type: 'spline' }, { extreme: { axis: 'y', side: 'max' } }] },
    })
    expect(picked?.items).toHaveLength(1)
    const cap = picked!.items[0]
    // A closed B-spline tessellates to far more samples than the conic grid, so
    // this test really exercises the decimation branch; the lowering is what
    // keeps a re-solve from scaling with the payload.
    expect((cap.geometry as { point_count?: number }).point_count)
      .toBeGreaterThan(CONIC_TRUTH_STEPS + 1)

    const projected = await runHeadless({
      doc: structuredClone(solid.doc!),
      steps: [
        step({
          type: 'add_plane', featureId: 'p1', label: 'Tilted', definition: {
            mode: 'origin_rotation', plane: '@builtin_plane_top', origin: [0, 0, 0],
            rotation_axis: 'x', rotation_angle: 30,
          },
        }),
        step({ type: 'add_sketch', featureId: 'sk2', label: 'Projected', plane: '@p1' }),
        step({
          type: 'add_projected_entity', featureId: 'sk2', kind: 'spline',
          source: cap.query, entityId: 'pc',
        }),
      ],
      frames: 'all',
    })
    expect(projected.ok).toBe(true)
    expect(nonSketchProblems(projected.features)).toEqual([])
    expect(JSON.stringify(projected.features)).not.toContain('curve fit stopped')

    const params = sketchOf(projected.doc, 'sk2')?.initial?.pc ?? []
    expect(params.length).toBeGreaterThan(4)
    const start: Pt = [params[0], params[1]]
    const end: Pt = [params[params.length - 2], params[params.length - 1]]
    expect(end).toEqual(start)

    // The true projected loop: the authored fit spline evaluated densely,
    // lifted to the far cap plane (the extrude runs 5 along the sketch normal)
    // and projected into the tilted frame.
    const sourceFrame = solid.frames!.sk1
    const sourceCurve = interpolateFitSpline(loopPoints(loop))
    const sourceEnd = sourceCurve.knots[sourceCurve.knots.length - 1]
    const truth: Pt[] = []
    for (let i = 0; i <= 2048; i++) {
      const at = sourceCurve.eval((sourceEnd * i) / 2048)
      const world = sketchToWorld2d(at, sourceFrame)
      const onCap = [
        world[0] + sourceFrame.normal[0] * 5,
        world[1] + sourceFrame.normal[1] * 5,
        world[2] + sourceFrame.normal[2] * 5,
      ]
      truth.push(worldToSketch2d(onCap, projected.frames!.sk2) as Pt)
    }
    const fitted: Pt[] = []
    for (let i = 0; i < params.length; i += 2) fitted.push([params[i], params[i + 1]])
    // The lowering judges its rung against the payload's own samples; against
    // the dense source curve this closed loop lands at 1.1e-3 of its size, so
    // the same rung is a fair ceiling here.
    const deviation = maxDeviationToFitSpline(truth, fitted)
    expect(deviation).toBeLessThanOrEqual(PROJECTED_CURVE_FIT_TOL * curveScale(truth))

    // The closed fit spline alone bounds the profile: no closing line needed.
    const area = shoelaceArea(truth)
    const height = 2
    const prism = await runHeadless({
      doc: structuredClone(projected.doc!),
      steps: [
        step({
          type: 'add_extrude', featureId: 'ex1', label: 'Prism',
          sketchQuery: '$sk2', distance: height, operation: 'new',
        }),
      ],
    })
    expect(prism.ok).toBe(true)
    expect(nonSketchProblems(prism.features)).toEqual([])
    expect(prism.features.find(problem => problem.id === 'ex1')).toBeUndefined()
    const volume = prism.featureDeltas?.find(entry => entry.id === 'ex1')?.volumeDelta
    expect(volume).toBeDefined()
    // Measured 1.4e-4 relative at 13 fit points; 1e-3 keeps an order of
    // magnitude for OCC's volume read on another build.
    expect(Math.abs(volume! - area * height) / (area * height)).toBeLessThan(1e-3)
  }, 240_000)
})

/** The authored fit points as pairs. */
function loopPoints(flat: readonly number[]): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]])
  return out
}

/** Area of a closed 2D loop, by the shoelace formula. */
function shoelaceArea(points: readonly Pt[]): number {
  let twice = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    twice += a[0] * b[1] - b[0] * a[1]
  }
  return Math.abs(twice) / 2
}
