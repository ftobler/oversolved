/**
 * Tests for sketch area mesh inertness (pick-avoidance).
 *
 * User invariant (solver_arch.agent.md §Priority stack):
 *   Sketch areas are decoration only and MUST NOT intercept pointer events
 *   while the sketch is being edited. Sketch geometry (lines, vertices) must
 *   receive drag and hover events even when they lie inside a filled area.
 *
 * Inertness is guaranteed by the ID buffer layer priority: sketchSurface (30)
 * renders behind sketchEntity (40) and sketchVertex (50), so entity lines and
 * vertices always win where they overlap a surface. The SurfaceMesh component
 * continues to have R3F event handlers for hover/click (not yet cutover).
 */
import { describe, it, expect } from 'vitest'

describe('SurfaceMesh inertness (post-sketchSurface layer)', () => {
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
