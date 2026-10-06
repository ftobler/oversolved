// @vitest-environment node
//
// Revolve axis-from-query resolution tests (real OCC + Rust solver). An edge
// query emitted by the build is fed back as a revolve `axis`, and the resolved
// axis direction is verified via the editing-handle tangent (perpendicular to
// the true axis). Edge queries carry @u| construction UUIDs for stable identity
// rather than @gde|/@gdf| geometry descriptors.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../sketch'
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
    const b = h.body(r0, 'body_ex1')
    const edges = (b.edges as Array<{ kind?: string; start?: number[]; end?: number[] }>) ?? []
    const eq = (b.edge_queries as string[]) ?? []
    // Find the bottom-front edge: along X (dir [+-1,0,0]) at y~0, z~0.
    const xAxisEdge = eq.find((_, i) => {
      const e = edges[i]
      if (!e || e.kind !== 'line') return false
      const s = e.start ?? [0, 0, 0]
      const en = e.end ?? [0, 0, 0]
      const dx = en[0] - s[0]; const dy = en[1] - s[1]; const dz = en[2] - s[2]
      const len = Math.hypot(dx, dy, dz)
      if (len < 1e-12) return false
      const xDir = Math.abs(dx / len) > 0.999 && Math.abs(dy / len) < 1e-6 && Math.abs(dz / len) < 1e-6
      return xDir && Math.abs(s[1]) < 1e-6 && Math.abs(s[2]) < 1e-6
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

  it('revolve axis survives extrude distance change (UUID identity)', () => {
    // A revolve axis query picked at extrude distance 5 must resolve
    // identically when the same body is rebuilt at distance 8. Since edge
    // queries carry @u| construction UUIDs (not geometry tokens), the same
    // edge by construction identity must produce the same revolve anchor
    // regardless of distance. Verified via the editing-handle anchor at 270
    // degrees (360 would rotate refPoint back to itself, hiding a wrong axis).
    const boxSpec = (d: number) => ({
      features: [rectSketch('sk1', 10, 10, 0, 0), {
        id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: d, direction: 'normal',
      }],
    })
    const r5 = h.run(boxSpec(5))
    const r8 = h.run(boxSpec(8))
    const eq5 = (h.body(r5, 'body_ex1').edge_queries as string[]) ?? []
    const eq8 = (h.body(r8, 'body_ex1').edge_queries as string[]) ?? []

    const uuidRe = /@u\|(e_[0-9a-f]{16})/
    const uuidMap5 = new Map<string, string>()
    for (const q of eq5) { const m = uuidRe.exec(q); if (m) uuidMap5.set(m[1], q) }
    const uuidMap8 = new Map<string, string>()
    for (const q of eq8) { const m = uuidRe.exec(q); if (m) uuidMap8.set(m[1], q) }

    const commonUuid = [...uuidMap5.keys()].find((k) => uuidMap8.has(k))
    expect(commonUuid).toBeDefined()
    if (!commonUuid) return

    const anchorOf = (edgeQ: string): number[] => {
      const spec = boxSpec(8) as { features: Record<string, unknown>[] }
      spec.features.push(rectSketch('sk2', 1, 1, 10.5, 1))
      spec.features.push({
        id: 'rev1', kind: 'revolve',
        revolve: { sketch: ['$sk2'], angle: 270, axis: edgeQ, operation: 'new' },
      })
      const r = h.run(spec)
      expect(h.res(r, 'rev1').status).toBe('ok')
      const handle = h.res(r, 'rev1').handle as { anchor: number[] } | undefined
      expect(handle).toBeDefined()
      return handle!.anchor
    }
    const a5 = anchorOf(uuidMap5.get(commonUuid)!)
    const a8 = anchorOf(uuidMap8.get(commonUuid)!)
    a5.forEach((v, i) => expect(v).toBeCloseTo(a8[i], 6))
  })

  it('an axis-less revolve fails the feature instead of sweeping about world Z', () => {
    // The end-to-end half of resolveRevolveAxis's required-axis guard: a
    // profile with no `axis` pick and no stored axis_direction used to build a
    // silent world-Z solid. It must surface as a red feature instead.
    const spec = { features: [
      rectSketch('sk1', 1, 1, 5, 1),
      { id: 'rev1', kind: 'revolve', label: 'Revolve',
        revolve: { sketch: ['$sk1'], angle: 360, operation: 'new' } },
    ]}
    const r = h.run(spec)
    expect(h.res(r, 'rev1').status).toBe('exception')
    expect(String(h.res(r, 'rev1').exception)).toMatch(/axis is required/)
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
