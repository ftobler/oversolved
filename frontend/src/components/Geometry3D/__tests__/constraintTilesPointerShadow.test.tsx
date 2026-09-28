import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { Sketch, Constraints } from '@/types/cad'

// Reproduces the "hover a vertex dot, nothing highlights" report. A tile
// group's drei <Html> is a DOM sibling of the canvas, laid over it. drei puts
// the `style` prop on the absolutely positioned div whose top-left corner IS
// the projected anchor, and the tiles sit inside it offset by marginLeft 20 /
// marginTop -8. With pointerEvents 'auto' on that div, its transparent box
// covers [anchor, anchor + 20 + groupWidth] x [anchor, anchor + 14]: the lower
// right quadrant of the vertex dot, center pixel included, for every symbol
// anchored on a vertex (coincident, tangent, normal, fixed, concentric...).
// Pointer events there target the div, not the canvas, so the ID-buffer
// dispatcher (listening on the canvas) never resolves a hover or a click.
// jsdom has no layout, so the test asserts the style contract that decides it:
// only the visible tiles may take pointer events, never the anchor wrapper.

vi.mock('@react-three/fiber', () => ({
  useThree: () => ({}),
}))

// Mirrors drei's non-transform Html: `style` lands on the div anchored at the
// projected point.
vi.mock('@react-three/drei', () => ({
  Html: ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
    <div data-testid="html-anchor" style={{ position: 'absolute', ...style }}>{children}</div>
  ),
}))

vi.mock('@/utils/geometry/sketchHelpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/geometry/sketchHelpers')>()
  return { ...actual, getIconUrl: (kind: string) => (kind.startsWith('symbol_') ? `/icons/${kind}.svg` : undefined) }
})

vi.mock('@/components/Geometry3D/drawGeometry', () => ({
  findEntitiesAtPoint: () => ['line1', 'line2'],
}))

import { ConstraintOverlays } from '@/components/Geometry3D/Constraints'

const sketch: Sketch = {
  line1: { kind: 'lineSegment', start: [0, 0], end: [10, 0] } as never,
  line2: { kind: 'lineSegment', start: [10, 0], end: [10, 10] } as never,
}

// A corner coincident: the tile group is anchored exactly on the shared vertex.
const constraints: Constraints = {
  c1: { render: { kind: 'symbol_coincident', at: [10, 0], entities: ['line1', 'line2'] }, residual: 0 } as Constraints[string],
}

beforeEach(() => {
  useSketchEditorStore.setState({ showConstraintTiles: true, drag: null, hoveredConstraintEntityIds: new Set() })
})

function renderCorner() {
  return render(
    <ConstraintOverlays
      constraints={constraints}
      sketch={sketch}
      extent={10}
      featureId="feat1"
      planeTransform={{ rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], origin: [0, 0, 0] }}
    />,
  )
}

describe('constraint tile pointer shadow over the anchored vertex', () => {
  it('lays the tile group out offset from the anchor, so the anchor wrapper box is transparent there', () => {
    // Precondition of the shadow: the tiles do not cover the anchor themselves,
    // so whatever captures the anchor pixel is the invisible wrapper.
    const { getByTestId } = renderCorner()
    const group = getByTestId('html-anchor').firstElementChild as HTMLElement
    expect(parseFloat(group.style.marginLeft)).toBeGreaterThan(0)
  })

  it('does not let the invisible anchor wrapper capture pointer events over the vertex', () => {
    const { getByTestId } = renderCorner()
    const anchor = getByTestId('html-anchor')
    expect(anchor.style.pointerEvents).toBe('none')
    // pointer-events inherits, so the visible tile has to opt back in or the
    // fix would make the tiles themselves unclickable.
    const tile = anchor.querySelector('img')!.parentElement as HTMLElement
    expect(tile.style.pointerEvents).toBe('auto')
  })
})
