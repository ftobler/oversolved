// @vitest-environment node
//
// The real-kernel half of the sampled curve fit: a 270 degree sketch arc is
// projected onto a plane tilted 30 degrees to its own, so it lowers to a
// fit_spline (one cubic misses it by 1.6e-2 of its size). The projected curve is
// closed with its chord, the sketch must solve clean, and the extruded volume
// must match the analytic area of the true projected curve times the height.
// This is the path the area builder and OCC see: a C2 fit-spline chain edge,
// not a single cubic. Skips when OCC.js or the Rust solver is absent.

import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import type { PartDoc, SketchFeature } from '@/types/cad'
import { runHeadless, emptyDriveDoc } from '../headlessOps'
import { nonSketchProblems } from './buildProblems'
import { loadOcc } from '@/kernel/occ/loadOcc'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { loadTopology } from '@/wasm-kernel/loadTopology'
import { setOccLoader } from '@/kernel/solveLocally'
import { setSketchSolver, setSketchTopology } from '@/kernel/features/sketch'
import { worldToSketch2d } from '@/kernel/features/shared/planes'
import type { PlaneLike } from '@/kernel/features/shared/planes'
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
    expect(JSON.stringify(closed.features)).not.toContain('make_bspline')
    expect(closed.featureDeltas?.find(entry => entry.id === 'sk2')?.status).toBe('fully_constrained')
    const volume = closed.featureDeltas?.find(entry => entry.id === 'ex1')?.volumeDelta
    expect(volume).toBeDefined()
    // The fit follows the true arc to 1.5e-3 of its size, so the prism's volume
    // is the analytic area to well under a percent; OCC integrates the B-spline
    // chain exactly, there is no chord approximation on its side.
    expect(Math.abs(volume! - area * height) / (area * height)).toBeLessThan(1e-2)
  }, 240_000)
})
