import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, createEvent } from '@testing-library/react'
import { useSketchUiStore, useSketchEditorStore } from '@/stores/sketchEditorStore'
import { useEditorState } from '@/hooks/useEditorState'
import type { Sketch, Constraints } from '@/types/cad'

// A constraint tile is a DOM overlay, so the canvas right-click listener never
// sees its event. The tile has to claim the event itself and hand the page the
// picked constraint, or a projection tile has no way to open the freeze menu.

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

const sketch: Sketch = {
  line1: { start: [0, 0], end: [10, 0] } as Sketch[string],
}

const constraints: Constraints = {
  proj_face: { render: { kind: 'symbol_coincident', at: [5, 0] }, residual: 0 } as Constraints[string],
}

describe('ConstraintTile right-click', () => {
  beforeEach(() => {
    useEditorState.setState({ normalSelection: new Set() })
    useSketchUiStore.setState({ showConstraintTiles: true })
  })

  it('claims the event, selects the tile and hands the page its constraint id', () => {
    const onSelectionContextMenu = vi.fn()
    const { container } = render(
      <ConstraintOverlays
        constraints={constraints}
        sketch={sketch}
        extent={10}
        featureId="sketch2"
        onSelectionContextMenu={onSelectionContextMenu}
      />,
    )

    const tile = container.querySelector('img')!.parentElement!
    const event = createEvent.contextMenu(tile, { clientX: 42, clientY: 24 })
    fireEvent(tile, event)

    expect(event.defaultPrevented).toBe(true)
    expect(useSketchEditorStore.getState().normalSelection.has('constraint:sketch2:proj_face')).toBe(true)
    expect(onSelectionContextMenu).toHaveBeenCalledWith('constraint:sketch2:proj_face', [42, 24])
  })
})
