import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * #266 drag-math-plane-audit acceptance: no invisible mesh exists in the
 * scene purely to serve as a collision surface for dragging.
 *
 * Pinned structurally because the alternative (mounting the full sketch
 * tree under a Canvas in vitest+jsdom) is heavyweight and brittle. If
 * someone reintroduces a planeGeometry inside `DragPlane`, this test
 * fails immediately.
 */
describe('Dragging.tsx (math-plane invariants)', () => {
  const SRC = readFileSync(
    join(__dirname, '..', 'Dragging.tsx'),
    'utf8',
  )

  it('does not mount a <mesh> or planeGeometry inside DragPlane', () => {
    // Limit the scan to the DragPlane function body. Everything outside
    // (DragSnapIndicator etc.) is allowed to render scene objects.
    const start = SRC.indexOf('export function DragPlane')
    const next = SRC.indexOf('export function ', start + 1)
    const body = SRC.slice(start, next === -1 ? SRC.length : next)
    expect(body).not.toMatch(/<mesh\b/)
    expect(body).not.toMatch(/planeGeometry/)
    expect(body).not.toMatch(/meshBasicMaterial/)
  })

  it('uses THREE.Plane math via the projectCursorToSketchPlane helper', () => {
    expect(SRC).toMatch(/projectCursorToSketchPlane/)
    // No mesh-based intersectObject call inside DragPlane.
    expect(SRC).not.toMatch(/intersectObject\(\s*mesh/)
  })

  it('the math-plane helper uses Ray.intersectPlane, not Raycaster.intersectObject', () => {
    const helper = readFileSync(
      join(__dirname, '..', 'dragMathPlane.ts'),
      'utf8',
    )
    expect(helper).toMatch(/intersectPlane/)
    expect(helper).not.toMatch(/intersectObject/)
  })
})
