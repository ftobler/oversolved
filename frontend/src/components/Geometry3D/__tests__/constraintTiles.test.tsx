import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
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

vi.mock('@/components/sketch/sketch_helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/sketch/sketch_helpers')>()
  return {
    ...actual,
    getIconUrl: (kind: string) => {
      if (kind.startsWith('symbol_')) return '/icons/' + kind + '.svg'
      return undefined
    },
  }
})

vi.mock('@/components/Geometry3D/dimensions', () => ({
  LinearDimension: () => <div data-testid="linear-dim" />,
  RadiusDimension: () => <div data-testid="radius-dim" />,
  DiameterDimension: () => <div data-testid="diameter-dim" />,
  AngleDimension: () => <div data-testid="angle-dim" />,
}))

vi.mock('@/components/Geometry3D/drawGeometry', () => ({
  findEntitiesAtPoint: () => ['entity1'],
}))

import { ConstraintOverlays } from '@/components/Geometry3D/Constraints'

beforeEach(() => {
  useSketchEditorStore.setState({ showConstraintTiles: true, drag: null })
})

const mockSketch: Sketch = {
  line1: { kind: 'lineSegment', start: [0, 0], end: [10, 0] } as never,
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
