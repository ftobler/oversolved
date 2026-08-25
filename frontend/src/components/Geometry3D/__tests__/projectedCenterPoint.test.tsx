import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { Sketch, Entity } from '@/types/cad'
import { COLOR_PROJECTED, COLOR_INACTIVE, COLOR_HOVER, COLOR_SELECTED } from '@/components/Geometry3D/constants'
// Static imports on purpose: a cold dynamic import of the EntityLines module
// graph inside the first timed test intermittently exceeds the 5s testTimeout
// when other forks load the machine (seen in full-suite runs).
import { entityCenter } from '@/utils/geometry/sketchHelpers'
import { ProjectedEntities } from '@/components/Geometry3D/EntityLines'

vi.mock('@react-three/drei', () => ({
  Line: () => null,
}))

vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  useThree: () => ({ camera: {} }),
}))

const PROJECTED_CIRCLE = { center: [3, 4], radius: 2, projected: true, source: '?f=box/e=1' }
const PROJECTED_ARC = { center: [1, 2], radius: 2, angle_start: 0, angle_end: 1, start: [3, 2], end: [1, 4], projected: true, source: '?a' }
const PROJECTED_ELLIPSE = { center: [5, 6], a: 3, b: 1, theta: 0, projected: true, source: '?e' }
const PROJECTED_LINE = { start: [0, 0], end: [1, 0], projected: true, source: '?l' }
const PROJECTED_SPLINE = { p1: [0, 0], p2: [1, 1], p3: [2, 1], p4: [3, 0], projected: true, source: '?s' }

function resetStore(overrides: Record<string, unknown> = {}) {
  useSketchEditorStore.setState({
    normalSelection: new Set(),
    hoveredConstraintEntityIds: new Set(),
    hoveredSelectionId: null,
    hoveredVertexId: null,
    ...overrides,
  } as never)
}

beforeEach(() => resetStore())

/** Positions of every dot the render produced, as written to the DOM. */
function dotPositions(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll('mesh')].map(m => m.getAttribute('position'))
}

function dotColor(container: HTMLElement): string | null {
  return container.querySelector('meshbasicmaterial')?.getAttribute('color') ?? null
}

describe('entityCenter', () => {
  it('returns the center of the curves that have one', async () => {
    expect(entityCenter(PROJECTED_CIRCLE as unknown as Entity)).toEqual([3, 4])
    expect(entityCenter(PROJECTED_ARC as unknown as Entity)).toEqual([1, 2])
    expect(entityCenter(PROJECTED_ELLIPSE as unknown as Entity)).toEqual([5, 6])
  })

  it('returns null for curves with no center', async () => {
    expect(entityCenter(PROJECTED_LINE as unknown as Entity)).toBeNull()
    expect(entityCenter(PROJECTED_SPLINE as unknown as Entity)).toBeNull()
  })

  it('returns null when the center is not finite', async () => {
    const nan = { center: [NaN, 0], radius: 1, projected: true, source: '?c' }
    expect(entityCenter(nan as unknown as Entity)).toBeNull()
  })
})

describe('ProjectedEntities center dot', () => {
  it('draws a dot at the center of a projected circle', async () => {
    // Regression: the center was already a registered vertex (pickable and a
    // drag snap target) but nothing drew it, so it only appeared while dragging.
    const sketch = { c1: PROJECTED_CIRCLE } as unknown as Sketch
    const { container } = render(<ProjectedEntities sketch={sketch} featureId="sketch1" isEditing />)

    expect(dotPositions(container)).toEqual(['3,4,0'])
  })

  it('draws a dot at the center of a projected arc and ellipse', async () => {
    const sketch = { a1: PROJECTED_ARC, e1: PROJECTED_ELLIPSE } as unknown as Sketch
    const { container } = render(<ProjectedEntities sketch={sketch} featureId="sketch1" isEditing />)

    expect(dotPositions(container)).toEqual(['1,2,0', '5,6,0'])
  })

  it('draws no dot for a projected line or spline', async () => {
    const sketch = { l1: PROJECTED_LINE, s1: PROJECTED_SPLINE } as unknown as Sketch
    const { container } = render(<ProjectedEntities sketch={sketch} featureId="sketch1" isEditing />)

    expect(dotPositions(container)).toEqual([])
  })

  it('is the projected colour while editing and inactive grey otherwise', async () => {
    const sketch = { c1: PROJECTED_CIRCLE } as unknown as Sketch

    const editing = render(<ProjectedEntities sketch={sketch} featureId="sketch1" isEditing />)
    expect(dotColor(editing.container)).toBe(COLOR_PROJECTED)
    editing.unmount()

    const visible = render(<ProjectedEntities sketch={sketch} featureId="sketch1" isEditing={false} />)
    expect(dotColor(visible.container)).toBe(COLOR_INACTIVE)
  })

  it('hovers and selects on the vertex id the pick layer registers', async () => {
    // buildSketchVertices registers `vertex:<fid>:<eid>:center`, so the drawn dot
    // must answer to that id or render and pick disagree.
    const sketch = { c1: PROJECTED_CIRCLE } as unknown as Sketch
    const vertId = 'vertex:sketch1:c1:center'

    resetStore({ hoveredVertexId: vertId })
    const hovered = render(<ProjectedEntities sketch={sketch} featureId="sketch1" isEditing />)
    expect(dotColor(hovered.container)).toBe(COLOR_HOVER)
    hovered.unmount()

    resetStore({ normalSelection: new Set([vertId]) })
    const selected = render(<ProjectedEntities sketch={sketch} featureId="sketch1" isEditing />)
    expect(dotColor(selected.container)).toBe(COLOR_SELECTED)
  })
})
