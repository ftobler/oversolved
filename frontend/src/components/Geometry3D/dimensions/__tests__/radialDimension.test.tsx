import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { DragState } from '@/stores/sketchEditorStore'

/**
 * RadialDimension and DiameterDimension pick between the inside-circle and
 * outside-circle arrow arrangements from where the label sits, and derive the
 * arrow tip / diameter endpoints accordingly. These tests pin those coordinates
 * plus the R / diameter label prefixes and the diameter's non-selectable label.
 */

const spies = vi.hoisted(() => ({
  Line: vi.fn(),
  Arrowhead: vi.fn(),
  ArrowTail: vi.fn(),
  Label: vi.fn(),
}))

vi.mock('@react-three/fiber', () => ({
  useThree: () => ({ camera: { isOrthographicCamera: true, zoom: 1 } }),
  useFrame: vi.fn(),
}))
vi.mock('@react-three/drei', () => ({
  Line: (props: Record<string, unknown>) => { spies.Line(props); return null },
}))
vi.mock('../primitives', () => ({
  Arrowhead: (props: Record<string, unknown>) => { spies.Arrowhead(props); return null },
  ArrowTail: (props: Record<string, unknown>) => { spies.ArrowTail(props); return null },
}))
vi.mock('../DimensionLabel', () => ({
  DimensionLabel: (props: Record<string, unknown>) => { spies.Label(props); return null },
}))
vi.mock('@/picking/useDimensionLabelIdRegistration', () => ({
  useDimensionLabelIdRegistration: vi.fn(),
}))

import { RadiusDimension, DiameterDimension } from '../Radial'

type RadiusDim = React.ComponentProps<typeof RadiusDimension>['dim']
type DiameterDim = React.ComponentProps<typeof DiameterDimension>['dim']
type Interaction = NonNullable<React.ComponentProps<typeof RadiusDimension>['interaction']>

const INTERACTION: Interaction = {
  featureId: 'S1', entityId: 'C1', constraintId: 'c1', promptLabel: 'Radius',
}

function lastLinePoints(): unknown {
  return spies.Line.mock.calls.at(-1)![0].points
}

beforeEach(() => {
  for (const s of Object.values(spies)) s.mockClear()
  useSketchEditorStore.setState({
    drag: null, dragPending: null, dragStartClient: null, isPointerDown: false,
    normalSelection: new Set(), hoveredConstraintEntityIds: new Set(), pendingDialog: null,
  })
})

describe('RadiusDimension inside arrangement', () => {
  const DIM: RadiusDim = { kind: 'dim_radius', p1: [0, 0], p2: [10, 0], value: 10 }

  it('defaults to a 10 degree offset, a mid-radius label and an outward arrow at the edge', () => {
    render(<RadiusDimension cid="c1" dim={DIM} />)

    // Rotating (10, 0) by 10 degrees: (9.8481, 1.7365); label at the midpoint.
    const tip = lastLinePoints() as number[][]
    expect(tip[0]).toEqual([0, 0, 0])
    expect(tip[1][0]).toBeCloseTo(9.8481, 3)
    expect(tip[1][1]).toBeCloseTo(1.7365, 3)
    const arrow = spies.Arrowhead.mock.calls.at(-1)![0]
    expect(arrow.from).toEqual([0, 0])
    expect(arrow.tip[0]).toBeCloseTo(9.8481, 3)
    expect(arrow.tip[1]).toBeCloseTo(1.7365, 3)
    expect(spies.ArrowTail).not.toHaveBeenCalled()

    const label = spies.Label.mock.calls.at(-1)![0]
    expect(label.label).toBe('R10')
    expect(label.x).toBeCloseTo(4.924, 3)
    expect(label.y).toBeCloseTo(0.868, 3)
  })

  it('places the tip on the circle along the label direction and draws an inverted arrow when outside', () => {
    render(<RadiusDimension cid="c1" dim={{ ...DIM, pos: [20, 0] }} />)

    expect(lastLinePoints()).toEqual([[0, 0, 0], [20, 0, 0]])
    const arrow = spies.Arrowhead.mock.calls.at(-1)![0]
    expect(arrow).toEqual({ tip: [10, 0], from: [20, 0], color: expect.any(String) })
    expect(spies.ArrowTail.mock.calls.at(-1)![0]).toEqual({ origin: [10, 0], dir: [1, 0], color: expect.any(String) })
    expect(spies.Label.mock.calls.at(-1)![0]).toMatchObject({ x: 20, y: 0 })
  })

  it('falls back to the stored edge point when the label sits exactly at the center', () => {
    render(<RadiusDimension cid="c1" dim={{ ...DIM, pos: [0, 0] }} />)

    expect(spies.Arrowhead.mock.calls.at(-1)![0]).toEqual({ tip: [10, 0], from: [0, 0], color: expect.any(String) })
  })

  it('collapses the arrow tail direction to zero on a zero-radius circle without dividing by zero', () => {
    render(<RadiusDimension cid="c1" dim={{ kind: 'dim_radius', p1: [0, 0], p2: [0, 0], value: 0, pos: [5, 0] }} />)

    // r = 0 -> tip sits at the center, so the tail direction is the safe 0,0.
    expect(spies.ArrowTail.mock.calls.at(-1)![0]).toEqual({ origin: [0, 0], dir: [0, 0], color: expect.any(String) })
  })
})

describe('RadiusDimension placement override', () => {
  it('uses the live drag position relative to the center', () => {
    const DIM: RadiusDim = { kind: 'dim_radius', p1: [0, 0], p2: [10, 0], value: 10, pos: [20, 0] }
    render(<RadiusDimension cid="c1" dim={DIM} interaction={INTERACTION} />)

    act(() => {
      const drag: DragState = {
        type: 'dim_label', constraintId: 'c1', featureId: 'S1',
        anchorWorld: [0, 0], startWorld: [20, 0], currentWorld: [0, 3],
      }
      useSketchEditorStore.getState().setDrag(drag)
    })

    expect(spies.Label.mock.calls.at(-1)![0]).toMatchObject({ x: 0, y: 3 })
    expect(lastLinePoints()).toEqual([[0, 0, 0], [0, 10, 0]])
  })
})

describe('RadiusDimension label text', () => {
  it('prefixes R and trims integer values, keeping two decimals otherwise', () => {
    const { unmount } = render(<RadiusDimension cid="c1" dim={{ kind: 'dim_radius', p1: [0, 0], p2: [5, 0], value: 5 }} />)
    expect(spies.Label.mock.calls.at(-1)![0].label).toBe('R5')
    unmount()

    render(<RadiusDimension cid="c1" dim={{ kind: 'dim_radius', p1: [0, 0], p2: [5.5, 0], value: 5.5 }} />)
    expect(spies.Label.mock.calls.at(-1)![0].label).toBe('R5.50')
  })
})

describe('DiameterDimension', () => {
  const DIM: DiameterDim = { kind: 'dim_diameter', p1: [-10, 0], p2: [10, 0], value: 20 }

  it('defaults to the stored diameter with the label 30 percent along it', () => {
    render(<DiameterDimension cid="c1" dim={DIM} />)

    expect(lastLinePoints()).toEqual([[-10, 0, 0], [10, 0, 0]])
    expect(spies.Arrowhead.mock.calls.map(c => c[0].tip)).toEqual([[-10, 0], [10, 0]])
    expect(spies.Label.mock.calls.at(-1)![0]).toMatchObject({ x: -4, y: 0, label: 'Ø20', selectable: false })
  })

  it('outside: rotates the arrows inward and leads from an endpoint to the label', () => {
    render(<DiameterDimension cid="c1" dim={{ ...DIM, pos: [20, 0] }} />)

    expect(spies.Line.mock.calls[0][0].points).toEqual([[-10, 0, 0], [10, 0, 0]])
    expect(lastLinePoints()).toEqual([[-10, 0, 0], [20, 0, 0]])
    expect(spies.Arrowhead.mock.calls.map(c => c[0])).toEqual([
      { tip: [-10, 0], from: [-11, 0], color: expect.any(String) },
      { tip: [10, 0], from: [11, 0], color: expect.any(String) },
    ])
  })

  it('uses the live drag position to rotate the diameter and place the label', () => {
    render(<DiameterDimension cid="c1" dim={{ ...DIM, pos: [20, 0] }} interaction={INTERACTION} />)

    act(() => {
      const drag: DragState = {
        type: 'dim_label', constraintId: 'c1', featureId: 'S1',
        anchorWorld: [0, 0], startWorld: [20, 0], currentWorld: [0, 5],
      }
      useSketchEditorStore.getState().setDrag(drag)
    })

    // pos +Y -> 90 degrees: the diameter becomes vertical and the label lands
    // inside the circle at (0, 5).
    const pts = spies.Line.mock.calls.at(-1)![0].points as number[][]
    expect(pts[0][1]).toBeCloseTo(-10, 6)
    expect(pts[1][1]).toBeCloseTo(10, 6)
    expect(spies.Label.mock.calls.at(-1)![0]).toMatchObject({ x: 0, y: 5 })
  })

  it('places the diameter along a placement offset direction', () => {
    render(<DiameterDimension cid="c1" dim={{ ...DIM, pos: [0, 20] }} />)

    // pos +Y -> 90 degrees: the diameter becomes vertical (cos(90) is not
    // exactly zero, so compare the x coordinates as near-zero).
    const pts = spies.Line.mock.calls[0][0].points as number[][]
    expect(pts[0][1]).toBeCloseTo(-10, 6)
    expect(pts[1][1]).toBeCloseTo(10, 6)
    expect(pts[0][0]).toBeCloseTo(0, 6)
    expect(pts[1][0]).toBeCloseTo(0, 6)
    expect(spies.Label.mock.calls.at(-1)![0]).toMatchObject({ x: 0, y: 20 })
  })

  it('treats a zero-length diameter as inside without dividing by zero', () => {
    render(<DiameterDimension cid="c1" dim={{ kind: 'dim_diameter', p1: [0, 0], p2: [0, 0], value: 0 }} />)

    expect(spies.Line.mock.calls.at(-1)![0].points).toEqual([[0, 0, 0], [0, 0, 0]])
    expect(spies.Arrowhead.mock.calls.map(c => c[0].tip)).toEqual([[0, 0], [0, 0]])
  })

  it('prefixes the diameter symbol and keeps two decimals for a fractional value', () => {
    render(<DiameterDimension cid="c1" dim={{ ...DIM, value: 7.5 }} />)

    expect(spies.Label.mock.calls.at(-1)![0].label).toBe('Ø7.50')
  })
})
