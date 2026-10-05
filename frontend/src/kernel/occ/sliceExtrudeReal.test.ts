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
import { detectTopology, topologyAvailable } from '../topologyTestUtil'
import { extractProfileLoops } from '../features/shared/profileLoops'
import type { PlaneLike } from '../features/shared/planes'
import { loopSignedArea, type LoopEdge } from '../profileLoops'

const oc = await loadOcc()
const XY: PlaneLike = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }

type Geom = Record<string, unknown>
const loopsOf = (s: Geom): LoopEdge[][] => [
  s.boundary as LoopEdge[],
  ...(((s.holes as LoopEdge[][]) ?? [])),
]

describe.skipIf(!oc || !topologyAvailable)('sliced-curve profile extrude (real OCC)', () => {
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
    // Concentric ellipses now make two areas: the ring (with the inner as a
    // hole) and the inner disk. Extrude the ring to get the washer solid.
    expect(topo.surfaces).toHaveLength(2)
    const ring = topo.surfaces.find((s) => ((s as Geom).holes as unknown[] ?? []).length > 0)!
    expect((ring as Geom).holes as unknown[]).toHaveLength(1)
    const h = 2
    const { solid } = extrudeProfileWithLineage(oc!, scope, loopsOf(ring as Geom), XY, [0, 0, 1], h, 'sk')
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

  it('occ-extrude-big-crescent-minus-venn: a centre-to-centre chord must not leave a sliver', () => {
    // Bug report bug-report-1788364894806: a line joining the two circle centres
    // dangles into both crescents. The area builder used to carry that dangling
    // segment back and forth as a zero-width slit, so OCC extruded the picked
    // "big circle minus the venn" area as a thin plane. The chord splits only the
    // lens; each crescent must stay a clean closed loop the prism accepts.
    const scope = new DisposeScope()
    const topo = detectTopology(
      {
        A: { kind: 'circle', center: [0, 0], radius: 9.5 },
        B: { kind: 'circle', center: [0, 10], radius: 4 },
        V: { kind: 'line', start: [0, 10], end: [0, 0] },
      },
      'sk',
    )
    expect(topo.surfaces).toHaveLength(4)
    // The two crescents are the faces the dangling chord must not touch; the two
    // lens halves (and only those) carry the line in their boundary.
    const crescents = topo.surfaces.filter(
      (s) => !(s.boundary as LoopEdge[]).some((e) => e.id === 'V'),
    )
    expect(crescents).toHaveLength(2)
    const big = crescents.reduce((a, b) =>
      Math.abs(loopSignedArea(a.boundary as LoopEdge[])) > Math.abs(loopSignedArea(b.boundary as LoopEdge[]))
        ? a
        : b,
    )
    const { solid } = extrudeProfileWithLineage(oc!, scope, [big.boundary as LoopEdge[]], XY, [0, 0, 1], 10, 'sk')
    const vol = volumeOf(oc!, scope, solid)
    // Big crescent = big disk (pi*9.5^2 ~= 283.5) minus the lens (~19.0): ~264.5
    // area, times height 10 ~= 2645. A thin sliver would be orders below this.
    expect(vol).toBeGreaterThan(2500)
    expect(vol).toBeLessThan(2800)
    scope.dispose()
  })
})
