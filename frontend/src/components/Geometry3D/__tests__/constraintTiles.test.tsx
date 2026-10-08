import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { Sketch, Constraints } from '@/types/cad'

vi.mock('@react-three/fiber', () => ({
  useThree: () => ({}),
}))

vi.mock('@react-three/drei', () => ({
  Html: ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => (
    <div data-testid="html-wrapper" style={style}>{children}</div>
  ),
}))

vi.mock('@/utils/geometry/sketchHelpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/geometry/sketchHelpers')>()
  return {
    ...actual,
    getIconUrl: (kind: string) => {
      if (kind.startsWith('symbol_')) return '/icons/' + kind + '.svg'
      return undefined
    },
  }
})

vi.mock('@/components/Geometry3D/dimensions/Linear', () => ({
  LinearDimension: () => <div data-testid="linear-dim" />,
}))

vi.mock('@/components/Geometry3D/dimensions/Radial', () => ({
  RadiusDimension: () => <div data-testid="radius-dim" />,
  DiameterDimension: () => <div data-testid="diameter-dim" />,
}))

vi.mock('@/components/Geometry3D/dimensions/Angle', () => ({
  AngleDimension: () => <div data-testid="angle-dim" />,
}))

vi.mock('@/components/Geometry3D/drawGeometry', () => ({
  findEntitiesAtPoint: () => ['entity1'],
}))

import { ConstraintOverlays } from '@/components/Geometry3D/Constraints'

beforeEach(() => {
  useSketchEditorStore.setState({ showConstraintTiles: true, drag: null, hoveredConstraintEntityIds: new Set() })
})

const mockSketch: Sketch = {
  line1: { start: [0, 0], end: [10, 0] } as Sketch[string],
}

const mockConstraints: Constraints = {
  c1: { render: { kind: 'symbol_horizontal', at: [5, 0] }, residual: 0 } as Constraints[string],
  c2: { render: { kind: 'symbol_vertical', at: [5, 0] }, residual: 0 } as Constraints[string],
}

function renderOverlays(constraints: Constraints = mockConstraints) {
  return render(
    <ConstraintOverlays
      constraints={constraints}
      sketch={mockSketch}
      extent={10}
      featureId="feat1"
      planeTransform={{ rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], origin: [0, 0, 0] }}
    />
  )
}

describe('ConstraintTile user-select', () => {
  it('ConstraintOverlays renders symbol tiles when showConstraintTiles is true', () => {
    useSketchEditorStore.setState({ showConstraintTiles: true })
    const { container } = renderOverlays()
    const imgs = container.querySelectorAll('img')
    expect(imgs.length).toBeGreaterThan(0)
  })

  it('ConstraintOverlays hides symbol tiles when showConstraintTiles is false', () => {
    useSketchEditorStore.setState({ showConstraintTiles: false })
    const { container } = renderOverlays()
    const imgs = container.querySelectorAll('img')
    expect(imgs.length).toBe(0)
  })

  it('renders dimension overlays regardless of showConstraintTiles', () => {
    useSketchEditorStore.setState({ showConstraintTiles: false })
    const dimConstraints: Constraints = {
      d1: { render: { kind: 'dim_linear', p1: [0, 0], p2: [10, 0], normal: [0, 1], value: 10 }, residual: 0 } as Constraints[string],
    }
    const { container } = renderOverlays(dimConstraints)
    const dims = container.querySelectorAll('[data-testid="linear-dim"]')
    expect(dims.length).toBeGreaterThan(0)
  })

  it('renders img elements with correct style containing user-select none', () => {
    useSketchEditorStore.setState({ showConstraintTiles: true })
    const { container } = renderOverlays()
    const imgs = container.querySelectorAll('img')
    expect(imgs.length).toBeGreaterThan(0)
    for (const img of Array.from(imgs)) {
      const parent = img.parentElement
      expect(parent).not.toBeNull()
      const style = parent!.getAttribute('style') ?? ''
      expect(style.toLowerCase()).toContain('user-select: none')
    }
  })
})

// An idle tile must not hide the geometry under it (the user aims at vertices
// behind tiles); only hover and selection paint a fill.
describe('ConstraintTile see-through background', () => {
  function tileStyle(container: HTMLElement): CSSStyleDeclaration {
    return container.querySelector('img')!.parentElement!.style
  }

  it('an idle tile has a transparent background', () => {
    useSketchEditorStore.setState({ normalSelection: new Set() })
    const { container } = renderOverlays()
    expect(tileStyle(container).background).toBe('transparent')
  })

  it('a superfluous tile is transparent and keeps its outline marker', () => {
    useSketchEditorStore.setState({ normalSelection: new Set() })
    const constraints: Constraints = {
      c1: { render: { kind: 'symbol_horizontal', at: [5, 0] }, residual: 0, superfluous: true } as Constraints[string],
    }
    const { container } = renderOverlays(constraints)
    const style = tileStyle(container)
    expect(style.background).toBe('transparent')
    expect(style.outline).toContain('solid')
  })

  it('hovering a tile still paints a fill', () => {
    useSketchEditorStore.setState({ normalSelection: new Set() })
    const { container } = renderOverlays()
    fireEvent.mouseEnter(container.querySelector('img')!.parentElement!)
    expect(tileStyle(container).background).not.toBe('transparent')
  })
})

// Hovering a symbol tile highlights the geometry the constraint actually
// targets, which differs by constraint shape. These are the three branches the
// overlay derives before informing the store.
describe('ConstraintTile hover highlight targets', () => {
  function hoverFirstTile(container: HTMLElement) {
    const img = container.querySelector('img')!
    fireEvent.mouseEnter(img.parentElement!)
  }

  it('a vertex-targeted constraint highlights only that vertex', () => {
    const constraints: Constraints = {
      c1: { render: { kind: 'symbol_fixed', entity: 'line1', point: 'start' }, residual: 0 } as Constraints[string],
    }
    const { container } = renderOverlays(constraints)
    hoverFirstTile(container)
    expect(useSketchEditorStore.getState().hoveredConstraintEntityIds).toEqual(new Set(['line1:start']))
  })

  it('a multi-entity constraint highlights every involved entity', () => {
    const constraints: Constraints = {
      c1: { render: { kind: 'symbol_parallel', entities: ['line1', 'line2'], at: [5, 0] }, residual: 0 } as Constraints[string],
    }
    const { container } = renderOverlays(constraints)
    hoverFirstTile(container)
    expect(useSketchEditorStore.getState().hoveredConstraintEntityIds).toEqual(new Set(['line1', 'line2']))
  })

  it('a positional-only constraint falls back to entities at the anchor point', () => {
    const constraints: Constraints = {
      c1: { render: { kind: 'symbol_coincident', at: [5, 0] }, residual: 0 } as Constraints[string],
    }
    const { container } = renderOverlays(constraints)
    hoverFirstTile(container)
    // findEntitiesAtPoint is mocked to return ['entity1'].
    expect(useSketchEditorStore.getState().hoveredConstraintEntityIds).toEqual(new Set(['entity1']))
  })

  it('leaving the tile clears the constraint highlight', () => {
    const constraints: Constraints = {
      c1: { render: { kind: 'symbol_parallel', entities: ['line1', 'line2'], at: [5, 0] }, residual: 0 } as Constraints[string],
    }
    const { container } = renderOverlays(constraints)
    const tile = container.querySelector('img')!.parentElement!
    fireEvent.mouseEnter(tile)
    fireEvent.mouseLeave(tile)
    expect(useSketchEditorStore.getState().hoveredConstraintEntityIds).toEqual(new Set())
  })
})

describe('ConstraintTile click selection and unmount cleanup', () => {
  it('clicking a tile selects its composite constraint id', () => {
    useSketchEditorStore.setState({ normalSelection: new Set() })
    const { container } = renderOverlays()
    fireEvent.click(container.querySelector('img')!.parentElement!)
    expect(useSketchEditorStore.getState().normalSelection.has('constraint:feat1:c1')).toBe(true)
  })

  it('unmounting a hovered tile clears the constraint highlight', () => {
    const { container, unmount } = renderOverlays()
    const tile = container.querySelector('img')!.parentElement!
    fireEvent.mouseEnter(tile)
    expect(useSketchEditorStore.getState().hoveredConstraintEntityIds.size).toBeGreaterThan(0)
    unmount()
    expect(useSketchEditorStore.getState().hoveredConstraintEntityIds).toEqual(new Set())
  })
})
