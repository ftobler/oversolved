// @vitest-environment node
//
// Revolve axis-from-query resolution tests (real OCC + Rust solver). Mirrors
// the fillet build-level query suite: an edge query emitted by the build is
// fed back as a revolve `axis`, and the resolved axis direction is verified
// via the editing-handle tangent (perpendicular to the true axis).
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../occ/loadOcc'
import { SharedHarness } from '../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from './sketch'
import { makeAncestryQuery, parseAncestry } from '../query'
import { parseGeomDescriptorId } from '../geomDescriptor'
import { loadSolver } from '@/wasm-kernel/loadSolver'
const oc = await loadOcc()
const solveBytes = loadSolver()

function rectSketch(
  sketchId: string,
  w: number,
  h: number,
  offsetX = 0,
  offsetY = 0,
  plane = '@builtin_plane_front',
) {
  return {
    id: sketchId, kind: 'sketch' as const, label: 'Rectangle', plane,
    entities: [
      { id: 'bottom', kind: 'line' as const }, { id: 'right', kind: 'line' as const },
      { id: 'top', kind: 'line' as const }, { id: 'left', kind: 'line' as const },
    ],
    initial: {
      bottom: [offsetX, offsetY, offsetX + w, offsetY],
      right: [offsetX + w, offsetY, offsetX + w, offsetY + h],
      top: [offsetX + w, offsetY + h, offsetX, offsetY + h],
      left: [offsetX, offsetY + h, offsetX, offsetY],
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

/** Extract the unit direction and representative point from an edge query's
 *  @gde| descriptor token; null when the query carries no descriptor. */
function edgeGeom(q: string): { dir: number[]; point: number[] } | null {
  const tok = parseAncestry(q)[0].find((i) => i.startsWith('@gde|'))
  if (!tok) return null
  const d = parseGeomDescriptorId(tok)
  if (!d || d.kind !== 'edge') return null
  const [x, y, z] = d.axis
  const len = Math.hypot(x, y, z)
  if (len < 1e-12) return null
  return { dir: [x / len, y / len, z / len], point: d.point }
}

describe.skipIf(!oc || !solveBytes)('revolve axis from query (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    if (solveBytes) { resetSketchSolver(); setSketchSolver(solveBytes) }
  })

  it('revolve axis resolves from a body straight-edge query', () => {
    // Box offset from the world origin so the default axis
    // (origin [0,0,0] + direction [0,0,1]) is clearly distinct from any box
    // edge axis. Rect at x in [10,12], y in [0,1]; extruded along Z by 5.
    const spec: { features: Array<Record<string, unknown>> } = { features: [
      rectSketch('sk1', 2, 1, 10, 0),
      { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 5, direction: 'normal', operation: 'new' },
    ]}
    const r0 = h.run(spec)
    const eq = (h.body(r0, 'body_ex1').edge_queries as string[]) ?? []
    // Find the bottom-front edge: along X (dir [+-1,0,0]) at y~0, z~0.
    const xAxisEdge = eq.find((q) => {
      const g = edgeGeom(q)
      if (!g) return false
      const xDir = Math.abs(g.dir[0]) > 0.999 && Math.abs(g.dir[1]) < 1e-6 && Math.abs(g.dir[2]) < 1e-6
      return xDir && Math.abs(g.point[1]) < 1e-6 && Math.abs(g.point[2]) < 1e-6
    })
    expect(xAxisEdge).toBeDefined()
    if (!xAxisEdge) return

    // Profile in the Front (XY, z=0) plane offset in +Y from the X-axis edge:
    // rect at x in [10.5,11.5], y in [1,2]. Revolving 360 around the
    // X-direction edge yields a ring. The editing handle's tangent is
    // perpendicular to the resolved axis, so handle.direction[0] ~ 0 iff the
    // axis resolved to the X-direction edge. With the silent default
    // ([0,0,1]) the tangent would have a non-zero X component.
    spec.features.push(rectSketch('sk2', 1, 1, 10.5, 1))
    spec.features.push({
      id: 'rev1', kind: 'revolve', label: 'Revolve',
      revolve: { sketch: ['$sk2'], angle: 360, axis: xAxisEdge, operation: 'new' },
    })
    const r = h.run(spec)
    expect(h.res(r, 'rev1').status).toBe('ok')
    const handle = h.res(r, 'rev1').handle as { direction: number[] } | undefined
    expect(handle).toBeDefined()
    if (handle) {
      expect(Math.abs(handle.direction[0])).toBeLessThan(1e-6)
    }
  })

  it('revolve axis survives extrude distance change (stale geometry token)', () => {
    // The bugreport scenario mirrored from fillet: a revolve axis picked at
    // one extrude distance must still resolve after the distance changes,
    // even though every moved edge gets a new geometry token. The stale
    // query must land on the edge whose stable ancestry matches, verified
    // via the editing-handle anchor (270deg so the anchor is axis-sensitive).
    const box = (w: number, h: number, d: number): { features: Array<Record<string, unknown>> } => ({
      features: [rectSketch('sk1', w, h, 0, 0), {
        id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: d, direction: 'normal', operation: 'new',
      }],
    })
    const eq5 = (h.body(h.run(box(10, 10, 5)), 'body_ex1').edge_queries as string[]) ?? []
    const eq8 = (h.body(h.run(box(10, 10, 8)), 'body_ex1').edge_queries as string[]) ?? []
    const geomTokenOf = (q: string): string | undefined =>
      parseAncestry(q)[0].find((i) => i.startsWith('@gde|'))
    const sigOf = (q: string): string => {
      const [ids, tr] = parseAncestry(q)
      return makeAncestryQuery(ids.filter((i) => !i.startsWith('@gde|')), tr)
    }
    // A d=5 vertical edge that moved: geomToken matches no d=8 edge, but
    // exactly one d=8 query carries the same stable-token signature.
    const freshTokens = new Set(eq8.map(geomTokenOf))
    const pair = eq5
      .filter((q) => geomTokenOf(q) !== undefined && !freshTokens.has(geomTokenOf(q)))
      .map((q) => ({ stale: q, fresh: eq8.find((f) => sigOf(f) === sigOf(q)) }))
      .find((p) => p.fresh !== undefined)
    expect(pair).toBeDefined()
    if (!pair) return

    // Profile in the Front (XY) plane offset from the world origin so the
    // default axis (Z through [0,0,0]) gives a clearly different anchor than
    // a corner edge axis. 270deg makes the anchor axis-sensitive (a 360
    // sweep rotates refPoint back to itself, hiding a wrong axis).
    const anchorOf = (edgeQ: string): number[] => {
      const s = box(10, 10, 8)
      s.features.push(rectSketch('sk2', 1, 1, 10.5, 1))
      s.features.push({
        id: 'rev1', kind: 'revolve', label: 'Revolve',
        revolve: { sketch: ['$sk2'], angle: 270, axis: edgeQ, operation: 'new' },
      })
      const r = h.run(s)
      expect(h.res(r, 'rev1').status).toBe('ok')
      const handle = h.res(r, 'rev1').handle as { anchor: number[] } | undefined
      expect(handle).toBeDefined()
      return handle!.anchor
    }
    const stale = anchorOf(pair!.stale)
    const fresh = anchorOf(pair!.fresh!)
    stale.forEach((v, i) => expect(v).toBeCloseTo(fresh[i], 6))
  })

  it('revolve axis resolves from a sketch line entity query', () => {
    // The entity-pick path: picking a sketch line in the viewport stores
    // `@<sketchId>/<entityId>` (resolveAxisQuery's entity: branch). Branch B
    // of resolveRevolveAxis reads the slash-registered external_params and
    // lifts them to world coords via the sketch's _pt_<id> plane frame. If
    // the plane lookup fails the axis silently falls back to the default.
    //
    // sk1: a rect whose 'left' edge is the axis line (x=5, y 0->5).
    // sk2: a small rect profile offset in +X from that axis.
    const spec: { features: Array<Record<string, unknown>> } = { features: [
      rectSketch('sk1', 1, 5, 5, 0),
      rectSketch('sk2', 1, 1, 5.5, 1),
      {
        id: 'rev1', kind: 'revolve', label: 'Revolve',
        revolve: { sketch: ['$sk2'], angle: 360, axis: '@sk1/left', operation: 'new' },
      },
    ]}
    const r = h.run(spec)
    expect(h.res(r, 'rev1').status).toBe('ok')
    const handle = h.res(r, 'rev1').handle as { direction: number[] } | undefined
    expect(handle).toBeDefined()
    if (handle) {
      // Correct axis is vertical (Y-direction); the handle tangent is
      // horizontal-perpendicular -> direction[2] (Z component) is non-zero.
      // The silent default ([0,0,1]) yields a tangent in the XY plane ->
      // direction[2] ~ 0.
      expect(Math.abs(handle.direction[2])).toBeGreaterThan(0.5)
    }
  })
})
