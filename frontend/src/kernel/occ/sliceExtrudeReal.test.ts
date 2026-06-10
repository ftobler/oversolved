// @vitest-environment node
//
// Real-OCC guard for the arbitrary area builder: a sliced ellipse (elliptical-arc
// boundary edges) and a donut (outer + inner hole) extrude into correct solids.
// Drives the full pipeline detectTopology -> profile loops -> trimmed-ellipse /
// face-with-hole wire -> prism. Skips when opencascade.js is absent.
import { describe, it, expect } from 'vitest'
import { loadOcc } from './loadOcc'
import { DisposeScope } from './disposeScope'
import { volumeOf } from './booleans'
import { extrudeProfileWithLineage } from './prismLineage'
import { detectTopology } from '../topology'
import { extractProfileLoops, type PlaneLike } from '../features/shared'
import type { LoopEdge } from '../profileLoops'

const oc = await loadOcc()
const XY: PlaneLike = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }

type Geom = Record<string, unknown>
const loopsOf = (s: Geom): LoopEdge[][] => [
  s.boundary as LoopEdge[],
  ...(((s.holes as LoopEdge[][]) ?? [])),
]

describe.skipIf(!oc)('sliced-curve profile extrude (real OCC)', () => {
  it('vanilla full ellipse extrudes through extractProfileLoops to a part', () => {
    // Regression: a standalone full-ellipse surface (single self-closed `ellipse`
    // edge, null endpoints) must survive extractProfileLoops and extrude.
    const scope = new DisposeScope()
    const topo = detectTopology({ e1: { kind: 'ellipse', center: [0, 0], a: 5, b: 2.5, theta: 0 } }, 'sk')
    expect(topo.surfaces).toHaveLength(1)
    const loops = extractProfileLoops(topo.surfaces as Geom[]) as LoopEdge[][]
    expect(loops).toHaveLength(1)
    const { solid } = extrudeProfileWithLineage(oc!, scope, loops, XY, [0, 0, 1], 10, 'sk')
    const vol = volumeOf(oc!, scope, solid)
    expect(vol).toBeGreaterThan(Math.PI * 5 * 2.5 * 10 * 0.9)  // ~= 392.7
    expect(vol).toBeLessThan(Math.PI * 5 * 2.5 * 10 * 1.05)
    scope.dispose()
  })

  it('occ-extrude-half-ellipse: a minor-axis-sliced half ellipse ~= half the prism', () => {
    const scope = new DisposeScope()
    const topo = detectTopology(
      { e1: { kind: 'ellipse', center: [0, 0], a: 5, b: 2.5, theta: 0 }, l1: { start: [0, 2.5], end: [0, -2.5] } },
      'sk',
    )
    expect(topo.surfaces).toHaveLength(2)
    const h = 3
    const { solid } = extrudeProfileWithLineage(oc!, scope, loopsOf(topo.surfaces[0] as Geom), XY, [0, 0, 1], h, 'sk')
    const vol = volumeOf(oc!, scope, solid)
    // half ellipse area = pi*a*b/2 = 19.635; * h=3 => ~58.9.
    expect(vol).toBeGreaterThan(54)
    expect(vol).toBeLessThan(64)
    scope.dispose()
  })

  it('occ-extrude-elliptical-donut: concentric ellipses extrude to a washer with a hole', () => {
    const scope = new DisposeScope()
    const topo = detectTopology(
      {
        e1: { kind: 'ellipse', center: [0, 0], a: 5, b: 2.5, theta: 0 },
        e2: { kind: 'ellipse', center: [0, 0], a: 3, b: 1.5, theta: 0 },
      },
      'sk',
    )
    expect(topo.surfaces).toHaveLength(1)
    expect((topo.surfaces[0] as Geom).holes as unknown[]).toHaveLength(1)
    const h = 2
    const { solid } = extrudeProfileWithLineage(oc!, scope, loopsOf(topo.surfaces[0] as Geom), XY, [0, 0, 1], h, 'sk')
    const vol = volumeOf(oc!, scope, solid)
    // (outer - inner) area * h = pi*(5*2.5 - 3*1.5)*2 = pi*8.75*2 ~= 54.98.
    expect(vol).toBeGreaterThan(50)
    expect(vol).toBeLessThan(60)
    scope.dispose()
  })

  it('occ-extrude-spline-sliced-ellipse: a spline-slashed ellipse half is a valid solid', () => {
    const scope = new DisposeScope()
    const topo = detectTopology(
      {
        e1: { kind: 'ellipse', center: [0, 0], a: 5, b: 2.5, theta: 0 },
        s1: {
          kind: 'spline',
          start: [-2.174095, 5.807216],
          c1: [-2.79044, -3.801748],
          c2: [2.539267, 4.22838],
          end: [1.686274, -4.632326],
        },
      },
      'sk',
    )
    expect(topo.surfaces.length).toBeGreaterThanOrEqual(2)
    const { solid } = extrudeProfileWithLineage(oc!, scope, loopsOf(topo.surfaces[0] as Geom), XY, [0, 0, 1], 2, 'sk')
    const vol = volumeOf(oc!, scope, solid)
    expect(vol).toBeGreaterThan(0)
    expect(vol).toBeLessThan(Math.PI * 5 * 2.5 * 2)  // less than the whole prism
    scope.dispose()
  })
})
