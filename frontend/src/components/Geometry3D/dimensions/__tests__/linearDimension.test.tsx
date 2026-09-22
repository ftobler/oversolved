import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'
import type { DragState } from '@/stores/sketchEditorStore'

/**
 * LinearDimension's branch decisions: which arrow/leader arrangement is drawn
 * for a label inside vs beyond either end of the dimension line, how a live
 * drag overrides the stored placement, when an extension line is skipped, and
 * the directional Flip side mutation. Assertions are on the concrete coordinates
 * handed to the child primitives, which is what the pure layout helpers feed.
 */

const spies = vi.hoisted(() => ({
  Line: vi.fn(),
  Arrowhead: vi.fn(),
  ArrowTail: vi.fn(),
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
  ArrowTail: (props: Record<string, unknown>) => { spies.ArrowTail(props); return null },
  ExtensionLine: (props: Record<string, unknown>) => { spies.ExtensionLine(props); return null },
}))
vi.mock('../DimensionLabel', () => ({
  DimensionLabel: (props: Record<string, unknown>) => { spies.Label(props); return null },
}))
vi.mock('@/picking/useDimensionLabelIdRegistration', () => ({
  useDimensionLabelIdRegistration: vi.fn(),
}))

import { LinearDimension } from '../Linear'

type Dim = React.ComponentProps<typeof LinearDimension>['dim']
type Interaction = NonNullable<React.ComponentProps<typeof LinearDimension>['interaction']>

const INTERACTION: Interaction = {
  featureId: 'S1', entityId: 'L1', constraintId: 'c1', promptLabel: 'Length',
}

// Horizontal segment, unit upward normal, so the default offset pushes the dim
// line to y = dimOffset and the label to its midpoint.
const BASE: Dim = { kind: 'dim_linear', p1: [0, 0], p2: [10, 0], normal: [0, 1], value: 10 }

function renderDim(dim: Partial<Dim> = {}, extra: Partial<React.ComponentProps<typeof LinearDimension>> = {}) {
  return render(
    <LinearDimension
      cid="c1"
      dim={{ ...BASE, ...dim }}
      dimOffset={10}
      {...extra}
    />,
  )
}

function points(call: number): unknown {
  return spies.Line.mock.calls[call][0].points
}

// -udirY can be -0; normalise it so a component-side signed zero does not
// masquerade as a different direction.
function normDir(dir: number[]): number[] {
  return dir.map(n => n + 0)
}

beforeEach(() => {
  for (const s of Object.values(spies)) s.mockClear()
  useSketchEditorStore.setState({
    drag: null,
    dragPending: null,
    dragStartClient: null,
    isPointerDown: false,
    normalSelection: new Set(),
    hoveredConstraintEntityIds: new Set(),
    pendingDialog: null,
  })
  setSketchCallback('onMutation', null)
})

describe('LinearDimension arrow arrangement', () => {
  it('inside: arrows sit at the boundaries pointing outward and no leader is drawn', () => {
    renderDim()

    expect(spies.Line).toHaveBeenCalledTimes(1)
    expect(points(0)).toEqual([[0, 10, 0], [10, 10, 0]])
    expect(spies.Arrowhead.mock.calls.map(c => c[0])).toEqual([
      { tip: [0, 10], from: [10, 10], color: expect.any(String) },
      { tip: [10, 10], from: [0, 10], color: expect.any(String) },
    ])
    expect(spies.ArrowTail).not.toHaveBeenCalled()
    expect(spies.Label.mock.calls[0][0]).toMatchObject({ x: 5, y: 10 })
  })

  it('outside near d1: both arrows point inward and the leader runs from d1 to the label', () => {
    renderDim({ pos: [-10, 0] })

    // Dimension line first, then the leader from d1 to the off-end label.
    expect(points(0)).toEqual([[0, 0, 0], [10, 0, 0]])
    expect(points(1)).toEqual([[0, 0, 0], [-5, 0, 0]])
    expect(spies.Arrowhead.mock.calls.map(c => c[0])).toEqual([
      { tip: [0, 0], from: [-1, 0], color: expect.any(String) },
      { tip: [10, 0], from: [11, 0], color: expect.any(String) },
    ])
    expect(spies.ArrowTail.mock.calls.map(c => ({ ...c[0], dir: normDir(c[0].dir as number[]) }))).toEqual([
      { origin: [0, 0], dir: [-1, 0], color: expect.any(String) },
      { origin: [10, 0], dir: [1, 0], color: expect.any(String) },
    ])
    expect(spies.Label.mock.calls[0][0]).toMatchObject({ x: -5, y: 0 })
  })

  it('outside near d2: same inward arrows but the leader starts at d2', () => {
    renderDim({ pos: [10, 0] })

    expect(points(1)).toEqual([[10, 0, 0], [15, 0, 0]])
    expect(spies.Label.mock.calls[0][0]).toMatchObject({ x: 15, y: 0 })
  })
})

describe('LinearDimension placement override', () => {
  it('a live drag position overrides the stored pos and re-picks the inside arrangement', () => {
    // Stored pos would place the label outside near d1; the drag moves it to
    // (5, 2), back inside the dimension line.
    renderDim({ pos: [-10, 0] }, { interaction: INTERACTION })

    act(() => {
      const drag: DragState = {
        type: 'dim_label', constraintId: 'c1', featureId: 'S1',
        anchorWorld: [5, 0], startWorld: [0, 0], currentWorld: [5, 2],
      }
      useSketchEditorStore.getState().setDrag(drag)
    })

    expect(spies.Label.mock.calls.at(-1)![0]).toMatchObject({ x: 5, y: 2 })
    // The last render is the dragged one: a single inside-arrangement dim line.
    expect(points(spies.Line.mock.calls.length - 1)).toEqual([[0, 2, 0], [10, 2, 0]])
    expect(spies.Arrowhead.mock.calls.slice(-2).map(c => c[0].tip)).toEqual([[0, 2], [10, 2]])
  })
})

describe('LinearDimension degenerate normal', () => {
  it('falls back to a unit scale instead of dividing by a zero normal', () => {
    renderDim({ normal: [0, 0] })

    // unx/uny stay 0, so the dimension line collapses onto the measured line.
    expect(points(0)).toEqual([[0, 0, 0], [10, 0, 0]])
    expect(spies.Label.mock.calls[0][0]).toMatchObject({ x: 5, y: 0 })
  })
})

describe('LinearDimension extension lines', () => {
  it('draws both default witness lines from each measured point to the dim line', () => {
    renderDim()

    expect(spies.ExtensionLine.mock.calls.map(c => c[0])).toEqual([
      { start: [0, 0], end: [0, 10], color: expect.any(String) },
      { start: [10, 0], end: [10, 10], color: expect.any(String) },
    ])
  })

  it('skips a witness line whose dim endpoint already projects onto the entity segment', () => {
    renderDim({
      ext1_line: [0, 0, 0, 20],
      ext2_line: [10, 0, 10, 20],
    })

    expect(spies.ExtensionLine).not.toHaveBeenCalled()
  })

  it('runs a witness line from the nearest segment point when the endpoint projects short of it', () => {
    renderDim({ ext1_line: [0, -5, 0, 5], ext2_line: [10, 0, 10, 20] })

    expect(spies.ExtensionLine.mock.calls.map(c => c[0])).toEqual([
      { start: [0, 5], end: [0, 10], color: expect.any(String) },
    ])
  })
})

describe('LinearDimension label text', () => {
  it('formats integer values without decimals and fractional values to two places', () => {
    renderDim({ value: 10 })
    expect(spies.Label.mock.calls.at(-1)![0].label).toBe('10')

    spies.Label.mockClear()
    renderDim({ value: 10.5 })
    expect(spies.Label.mock.calls[0][0].label).toBe('10.50')
  })
})

describe('LinearDimension Flip side', () => {
  function openFlip() {
    renderDim({ dimKind: 'point_distance_x' }, { interaction: INTERACTION })
    const labelProps = spies.Label.mock.calls[0][0] as { onDoubleClick: (e: unknown) => void }
    act(() => labelProps.onDoubleClick({ stopPropagation: () => {}, clientX: 0, clientY: 0 }))
    return useSketchEditorStore.getState().pendingDialog
  }

  it('offers Flip side for a directional dim and negates the current sign', () => {
    const onMutation = vi.fn()
    setSketchCallback('onMutation', onMutation)
    // p2.x > p1.x so the axis-distance sign is +1; flipping stores -1.
    const dialog = openFlip()

    expect(dialog?.extraAction?.label).toBe('Flip side')
    act(() => dialog!.extraAction!.onClick())

    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_constraint_sign', featureId: 'S1', constraintId: 'c1', sign: -1,
    })
  })

  it('uses the perpendicular line-distance sign for a line_distance dim', () => {
    const onMutation = vi.fn()
    setSketchCallback('onMutation', onMutation)
    // normal +X, so the point p2 is on the positive side; lineDistanceSign = +1
    // and flipping stores -1.
    renderDim({ dimKind: 'line_distance', p1: [0, 0], p2: [0, 2], normal: [1, 0] }, { interaction: INTERACTION })
    const labelProps = spies.Label.mock.calls[0][0] as { onDoubleClick: (e: unknown) => void }
    act(() => labelProps.onDoubleClick({ stopPropagation: () => {}, clientX: 0, clientY: 0 }))

    const dialog = useSketchEditorStore.getState().pendingDialog!
    act(() => dialog.extraAction!.onClick())

    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_constraint_sign', featureId: 'S1', constraintId: 'c1', sign: -1,
    })
  })

  it('does not offer Flip side for a non-directional dim', () => {
    renderDim({}, { interaction: INTERACTION })
    const labelProps = spies.Label.mock.calls[0][0] as { onDoubleClick: (e: unknown) => void }
    act(() => labelProps.onDoubleClick({ stopPropagation: () => {}, clientX: 0, clientY: 0 }))

    expect(useSketchEditorStore.getState().pendingDialog?.extraAction).toBeUndefined()
  })
})
