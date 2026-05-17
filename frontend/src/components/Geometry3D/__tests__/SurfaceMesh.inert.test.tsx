/**
 * Tests for sketch area mesh inertness (pick-avoidance).
 *
 * User invariant (solver_arch.agent.md §Priority stack):
 *   Sketch areas are decoration only and MUST NOT intercept pointer events
 *   while the sketch is being edited. Sketch geometry (lines, vertices) must
 *   receive drag and hover events even when they lie inside a filled area.
 *
 * As of 267.6 the `noOpRaycast` raycaster-level shim is removed. Area
 * inertness is now guaranteed by the ID buffer: sketch areas are never
 * registered in any ID layer, so the dispatcher never returns them as
 * picked. The SurfaceMesh component continues to have R3F event handlers
 * for hover/click but these are only enabled for non-editing sketches.
 */
import { describe, it, expect } from 'vitest'

describe('SurfaceMesh inertness (post-267.6)', () => {
  it('Surfaces.tsx no longer exports noOpRaycast', async () => {
    const mod = await import('@/components/Geometry3D/Surfaces')
    expect('noOpRaycast' in mod).toBe(false)
  })

  it('sketch geometry renderOrder exceeds area mesh renderOrder while editing', async () => {
    const { RENDER_ORDER_EDITING } = await import('@/utils/partColors')
    const AREA_MESH_RENDER_ORDER = 0
    expect(RENDER_ORDER_EDITING).toBeGreaterThan(AREA_MESH_RENDER_ORDER)
  })
})
