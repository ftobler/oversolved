import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'
import type { DragState } from '@/stores/sketchEditorStore'

/**
 * AngleDimension wraps the pure computeAngleDimension geometry in JSX: which
 * arc endpoints the tangent arrowheads hang off, when the radial witness lines
 * are needed, how a supplement-quadrant label shows (and encodes) 180 - theta,
 * and how a live drag re-anchors around the vertex. Assertions pin the
 * coordinates and the label text, not just the component tree.
 */

const spies = vi.hoisted(() => ({
  Line: vi.fn(),
  Arrowhead: vi.fn(),
  ExtensionLine: vi.fn(),
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
  ExtensionLine: (props: Record<string, unknown>) => { spies.ExtensionLine(props); return null },
}))
vi.mock('../DimensionLabel', () => ({
  DimensionLabel: (props: Record<string, unknown>) => { spies.Label(props); return null },
}))
vi.mock('@/picking/useDimensionLabelIdRegistration', () => ({
  useDimensionLabelIdRegistration: vi.fn(),
}))

import { AngleDimension } from '../Angle'

type Dim = React.ComponentProps<typeof AngleDimension>['dim']
type Interaction = NonNullable<React.ComponentProps<typeof AngleDimension>['interaction']>

const INTERACTION: Interaction = {
  featureId: 'S1', entityId: 'L1', constraintId: 'c1', promptLabel: 'angle in degrees',
}

// Two perpendicular rays from the origin: line A along +X, line B along +Y.
const RIGHT_ANGLE: Dim = {
  kind: 'dim_angle', p1: [0, 0], p2: [10, 0], p3: [0, 0], p4: [0, 10], value: 90,
}

function lastLabel() {
  return spies.Label.mock.calls.at(-1)![0] as { x: number; y: number; label: string; onDoubleClick: (e: unknown) => void }
}

beforeEach(() => {
  for (const s of Object.values(spies)) s.mockClear()
  useSketchEditorStore.setState({
    drag: null, dragPending: null, dragStartClient: null, isPointerDown: false,
    normalSelection: new Set(), hoveredConstraintEntityIds: new Set(), pendingDialog: null,
  })
  setSketchCallback('onMutation', null)
})

describe('AngleDimension arc and arrows', () => {
  it('draws the arc at the default radius with tangent arrows pointing into the span ends', () => {
    render(<AngleDimension cid="c1" dim={RIGHT_ANGLE} />)

    const arc = spies.Line.mock.calls[0][0].points as number[][]
    // Vertex (0,0), default arc radius 5, spanning 0 to 90 degrees.
    expect(arc[0][0]).toBeCloseTo(5, 6)
    expect(arc[0][1]).toBeCloseTo(0, 6)
    const end = arc[arc.length - 1]
    expect(end[0]).toBeCloseTo(0, 6)
    expect(end[1]).toBeCloseTo(5, 6)

    // Start arrow: tip at (5,0), tangent points +Y into the span.
    const first = spies.Arrowhead.mock.calls[0][0]
    expect(first.tip[0]).toBeCloseTo(5, 6)
    expect(first.tip[1]).toBeCloseTo(0, 6)
    expect(first.from[0]).toBeCloseTo(5, 6)
    expect(first.from[1]).toBeCloseTo(1, 6)
    expect(lastLabel()).toMatchObject({ label: '90°' })
  })

  it('draws no radial witness lines when the arc already sits on the measured segments', () => {
    render(<AngleDimension cid="c1" dim={RIGHT_ANGLE} />)

    expect(spies.ExtensionLine).not.toHaveBeenCalled()
  })

  it('formats a fractional angle to one decimal place', () => {
    render(<AngleDimension cid="c1" dim={{ ...RIGHT_ANGLE, value: 90.5 }} />)

    expect(lastLabel()).toMatchObject({ label: '90.5°' })
  })

  it('adds radial witness lines when the arc radius falls short of the measured segments', () => {
    render(<AngleDimension cid="c1" dim={{
      kind: 'dim_angle', p1: [5, 0], p2: [15, 0], p3: [0, 5], p4: [0, 15], value: 90, pos: [3, 0],
    }} />)

    const witnesses = spies.ExtensionLine.mock.calls.map(c => c[0]) as { start: number[]; end: number[] }[]
    expect(witnesses).toHaveLength(2)
    expect(witnesses[0].start[0]).toBeCloseTo(5, 6)
    expect(witnesses[0].start[1]).toBeCloseTo(0, 6)
    expect(witnesses[0].end[0]).toBeCloseTo(3, 6)
    expect(witnesses[0].end[1]).toBeCloseTo(0, 6)
    expect(witnesses[1].start[0]).toBeCloseTo(0, 6)
    expect(witnesses[1].start[1]).toBeCloseTo(5, 6)
    expect(witnesses[1].end[0]).toBeCloseTo(0, 6)
    expect(witnesses[1].end[1]).toBeCloseTo(3, 6)
  })
})

describe('AngleDimension supplement label', () => {
  // Target 135 degrees lands in a supplement wedge, so the label shows 60 for a
  // stored value of 120.
  const SUPPLEMENT: Dim = { ...RIGHT_ANGLE, value: 120, pos: [-7, 7] }

  it('displays 180 - value in a supplement quadrant', () => {
    render(<AngleDimension cid="c1" dim={SUPPLEMENT} />)

    expect(lastLabel()).toMatchObject({ label: '60°' })
  })

  it('encodes the edited display value back to the stored value on confirm', () => {
    const onMutation = vi.fn()
    setSketchCallback('onMutation', onMutation)
    render(<AngleDimension cid="c1" dim={SUPPLEMENT} interaction={INTERACTION} />)

    act(() => lastLabel().onDoubleClick({ stopPropagation: () => {}, clientX: 0, clientY: 0 }))
    const dialog = useSketchEditorStore.getState().pendingDialog
    expect(dialog?.defaultValue).toBe('60')

    act(() => dialog!.onConfirm('60'))
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_constraint_value', featureId: 'S1', constraintId: 'c1', value: 120,
    })
  })
})

describe('AngleDimension Flip side', () => {
  it('negates the current handedness sign', () => {
    const onMutation = vi.fn()
    setSketchCallback('onMutation', onMutation)
    render(<AngleDimension cid="c1" dim={RIGHT_ANGLE} interaction={INTERACTION} />)

    act(() => lastLabel().onDoubleClick({ stopPropagation: () => {}, clientX: 0, clientY: 0 }))
    const dialog = useSketchEditorStore.getState().pendingDialog
    expect(dialog?.extraAction?.label).toBe('Flip side')

    act(() => dialog!.extraAction!.onClick())
    // dirA x dirB = (10,0) x (0,10) = +100, so flipping stores -1.
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_constraint_sign', featureId: 'S1', constraintId: 'c1', sign: -1,
    })
  })
})

describe('AngleDimension placement override', () => {
  it('re-anchors the drag position around the computed vertex', () => {
    render(<AngleDimension cid="c1" dim={RIGHT_ANGLE} interaction={INTERACTION} />)

    act(() => {
      const drag: DragState = {
        type: 'dim_label', constraintId: 'c1', featureId: 'S1',
        anchorWorld: [0, 0], startWorld: [0, 0], currentWorld: [0, 8],
      }
      useSketchEditorStore.getState().setDrag(drag)
    })

    const label = lastLabel()
    expect(label.x).toBeCloseTo(0, 6)
    expect(label.y).toBeCloseTo(8, 6)
  })
})
