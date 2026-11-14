import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { useSketchEditorStore, useSketchUiStore } from '@/stores/sketchEditorStore'
import { COLOR_ERROR, COLOR_ERROR_DEEP } from '@/components/Geometry3D/constants'
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

vi.mock('@/utils/geometry/drawGeometry', () => ({
  findEntitiesAtPoint: () => ['entity1'],
}))

import { ConstraintOverlays } from '@/components/Geometry3D/Constraints'
import { useEditorState } from '@/hooks/useEditorState'
import { computeConstraintRender } from '@/utils/geometry/geometryMapping'
import type { PartConstraint } from '@/types/cad'

beforeEach(() => {
  useEditorState.setState({
    drag: null,
    hoveredConstraintEntityIds: new Set(),
  })
  useSketchUiStore.setState({
    showConstraintTiles: true,
  })
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
    useSketchUiStore.setState({
    showConstraintTiles: true,
  })
    const { container } = renderOverlays()
    const imgs = container.querySelectorAll('img')
    expect(imgs.length).toBeGreaterThan(0)
  })

  it('ConstraintOverlays hides symbol tiles when showConstraintTiles is false', () => {
    useSketchUiStore.setState({
    showConstraintTiles: false,
  })
    const { container } = renderOverlays()
    const imgs = container.querySelectorAll('img')
    expect(imgs.length).toBe(0)
  })

  it('renders dimension overlays regardless of showConstraintTiles', () => {
    useSketchUiStore.setState({
    showConstraintTiles: false,
  })
    const dimConstraints: Constraints = {
      d1: { render: { kind: 'dim_linear', p1: [0, 0], p2: [10, 0], normal: [0, 1], value: 10 }, residual: 0 } as Constraints[string],
    }
    const { container } = renderOverlays(dimConstraints)
    const dims = container.querySelectorAll('[data-testid="linear-dim"]')
    expect(dims.length).toBeGreaterThan(0)
  })

  it('renders img elements with correct style containing user-select none', () => {
    useSketchUiStore.setState({
    showConstraintTiles: true,
  })
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
    useEditorState.setState({
    normalSelection: new Set(),
  })
    const { container } = renderOverlays()
    expect(tileStyle(container).background).toBe('transparent')
  })

  it('a superfluous tile is transparent and keeps its outline marker', () => {
    useEditorState.setState({
    normalSelection: new Set(),
  })
    const constraints: Constraints = {
      c1: { render: { kind: 'symbol_horizontal', at: [5, 0] }, residual: 0, superfluous: true } as Constraints[string],
    }
    const { container } = renderOverlays(constraints)
    const style = tileStyle(container)
    expect(style.background).toBe('transparent')
    expect(style.outline).toContain('solid')
  })

  it('a culprit tile carries the deeper error red outline', () => {
    // On an unsatisfied solve every entity already paints red; the tile of a
    // constraint the solve blamed must stand out inside that, in the one
    // darker red the scene language reserves for culprits.
    useEditorState.setState({
    normalSelection: new Set(),
  })
    const constraints: Constraints = {
      c1: { render: { kind: 'symbol_horizontal', at: [5, 0] }, residual: 0.5, culprit: true } as Constraints[string],
    }
    const { container } = renderOverlays(constraints)
    const style = tileStyle(container)
    expect(style.background).toBe('transparent')
    expect(style.outline).toContain(COLOR_ERROR_DEEP)
    expect(style.outline).not.toContain(COLOR_ERROR)
  })

  it('hovering a tile still paints a fill', () => {
    useEditorState.setState({
    normalSelection: new Set(),
  })
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

// A constraint the solve could not use has no solved render, so it had no tile:
// the tree warned about an id the user could not find or delete from the canvas.
// It draws one red tile where its surviving local operand is, and Delete takes it
// through the ordinary constraint-selection path.
describe('a dropped constraint is a red, selectable tile', () => {
  const dropped = [{ id: 'c_dead', kind: 'coincident', reason: 'stale reference' }]
  const authored = [{
    id: 'c_dead', kind: 'coincident',
    a: '$line1start', b: '@sk1/otherSketchLine',
  }] as unknown as import('@/types/cad').PartConstraint[]

  it('renders at the local operand with the warning sentence and a red outline', () => {
    useSketchUiStore.setState({ showConstraintTiles: false })
    const { container } = render(
      <ConstraintOverlays
        constraints={{}}
        sketch={mockSketch}
        extent={10}
        featureId="feat1"
        droppedConstraints={dropped}
        authoredConstraints={authored}
      />
    )
    // One tile even though the user hid the ordinary symbols: this one is an
    // error marker, not decoration.
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    const tile = img!.parentElement!
    expect(tile.title).toBe(
      'constraint c_dead (coincident) names operands it cannot use (stale reference) and was ignored.',
    )
    expect(tile.style.outline).toContain(COLOR_ERROR_DEEP)
  })

  it('selects as the ordinary constraint id so Delete removes it', () => {
    useEditorState.setState({ normalSelection: new Set() })
    const { container } = render(
      <ConstraintOverlays
        constraints={{}}
        sketch={mockSketch}
        extent={10}
        featureId="feat1"
        droppedConstraints={dropped}
        authoredConstraints={authored}
      />
    )
    fireEvent.click(container.querySelector('img')!.parentElement!)
    expect(useSketchEditorStore.getState().normalSelection.has('constraint:feat1:c_dead')).toBe(true)
  })

  it('anchors at the sketch origin when no operand resolves any more', () => {
    useSketchUiStore.setState({ showConstraintTiles: true })
    const { container } = render(
      <ConstraintOverlays
        constraints={{}}
        sketch={{}}
        extent={10}
        featureId="feat1"
        droppedConstraints={dropped}
        authoredConstraints={[{
          id: 'c_dead', kind: 'coincident', a: '$gone1', b: '@sk1/other',
        }] as unknown as import('@/types/cad').PartConstraint[]}
      />
    )
    expect(container.querySelector('img')).not.toBeNull()
  })

  it('draws no tile for a dropped id the document no longer holds', () => {
    const { container } = render(
      <ConstraintOverlays
        constraints={{}}
        sketch={mockSketch}
        extent={10}
        featureId="feat1"
        droppedConstraints={dropped}
        authoredConstraints={[]}
      />
    )
    expect(container.querySelector('img')).toBeNull()
  })
})

describe('ConstraintTile group', () => {
  const twoLineSketch: Sketch = {
    l1: { start: [0, 0], end: [10, 0] } as Sketch[string],
    l2: { start: [0, 2], end: [10, 2] } as Sketch[string],
  }

  function groupRender() {
    const constraint: PartConstraint = { id: 'g1', kind: 'group', refs: ['$l1', '$l2'] }
    return computeConstraintRender(constraint, twoLineSketch)
  }

  it('renders one tile per group at the anchor and names the member count', () => {
    const constraints: Constraints = {
      g1: { render: groupRender(), residual: 0 } as Constraints[string],
    }
    const { container } = render(
      <ConstraintOverlays
        constraints={constraints}
        sketch={twoLineSketch}
        extent={10}
        featureId="feat1"
      />,
    )
    const imgs = container.querySelectorAll('img')
    expect(imgs).toHaveLength(1)
    // The anchor is the first member (l1), and the tile names the set size.
    expect(imgs[0].parentElement!.title).toBe('Group (2 entities)')
    expect((constraints.g1.render as { at: [number, number] }).at).toEqual([0, 0])
  })

  it('hovering the group tile highlights every member', () => {
    const constraints: Constraints = {
      g1: { render: groupRender(), residual: 0 } as Constraints[string],
    }
    const { container } = render(
      <ConstraintOverlays
        constraints={constraints}
        sketch={twoLineSketch}
        extent={10}
        featureId="feat1"
      />,
    )
    fireEvent.mouseEnter(container.querySelector('img')!.parentElement!)
    expect(useSketchEditorStore.getState().hoveredConstraintEntityIds).toEqual(new Set(['l1', 'l2']))
  })

  it('names both counts and highlights a point member marker', () => {
    const constraint: PartConstraint = { id: 'g1', kind: 'group', refs: ['$l1start', '$l2'] }
    const constraints: Constraints = {
      g1: { render: computeConstraintRender(constraint, twoLineSketch), residual: 0 } as Constraints[string],
    }
    const { container } = render(
      <ConstraintOverlays
        constraints={constraints}
        sketch={twoLineSketch}
        extent={10}
        featureId="feat1"
      />,
    )
    expect(container.querySelector('img')!.parentElement!.title).toBe('Group (1 entity, 1 point)')
    fireEvent.mouseEnter(container.querySelector('img')!.parentElement!)
    // The held endpoint is a vertex marker, not its whole line.
    expect(useSketchEditorStore.getState().hoveredConstraintEntityIds).toEqual(new Set(['l1:start', 'l2']))
  })
})

describe('ConstraintTile click selection and unmount cleanup', () => {
  it('clicking a tile selects its composite constraint id', () => {
    useEditorState.setState({
    normalSelection: new Set(),
  })
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
