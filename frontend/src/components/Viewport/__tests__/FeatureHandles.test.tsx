import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'
import { usePartEditorStore, DEFAULT_PART_EDITOR_DATA } from '@/stores/partEditorStore'
import type { FeatureHandleData, PartDoc, PartFeature } from '@/types/cad'

/**
 * FeatureHandles owns the whole editing-arrow gesture: it decides whether a
 * stored value is draggable at all (an expression must not be silently
 * destroyed by a drag commit), seeds the pending drag, validates the
 * double-click edit, and commits the rounded value on release. These tests
 * drive the callbacks the component registers into the ID dispatcher and the
 * window-level gesture listeners, with the pure math kept real.
 */

const seams = vi.hoisted(() => ({
  callbacks: null as {
    onPointerDown: (x: number, y: number) => void
    onDoubleClick: (x: number, y: number) => void
  } | null,
  registration: null as Record<string, unknown> | null,
  closestParam: vi.fn(),
}))

vi.mock('@react-three/fiber', async () => {
  const three = await import('three')
  return {
    useFrame: () => {},
    useThree: () => ({
      camera: new three.OrthographicCamera(),
      gl: {
        domElement: {
          getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
        },
      },
      size: { width: 800, height: 600 },
    }),
  }
})

vi.mock('@react-three/drei', () => ({
  Html: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('@/picking', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/picking')>()),
  useFeatureHandleIdRegistration: (args: Record<string, unknown>) => { seams.registration = args },
}))

vi.mock('@/components/Viewport/idDispatch/featureHandleCallbacks', () => ({
  registerFeatureHandleCallbacks: (
    _key: string,
    cb: { onPointerDown: (x: number, y: number) => void; onDoubleClick: (x: number, y: number) => void },
  ) => {
    seams.callbacks = cb
    return () => { seams.callbacks = null }
  },
}))

vi.mock('@/utils/gizmoMath', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/gizmoMath')>()),
  closestParamOnAxis: (...a: unknown[]) => seams.closestParam(...a),
}))

import FeatureHandles from '@/components/Viewport/FeatureHandles'

const HANDLE: FeatureHandleData = {
  kind: 'linear',
  field: 'distance',
  anchor: [0, 0, 0],
  direction: [1, 0, 0],
  value: 5,
  unit_scale: 1,
  min: 0.1,
}

function extrudeFeature(overrides: Partial<PartFeature['extrude']> = {}): PartFeature {
  return {
    id: 'F1',
    kind: 'extrude',
    label: 'Extrude',
    extrude: { distance: 5, ...overrides },
  } as unknown as PartFeature
}

function installFeature(feature: PartFeature) {
  usePartEditorStore.setState({
    ...DEFAULT_PART_EDITOR_DATA,
    editingFeatureId: 'F1',
    doc: { features: [feature] } as unknown as PartDoc,
    solveResults: { F1: { handle: HANDLE } },
  })
}

beforeEach(() => {
  seams.callbacks = null
  seams.registration = null
  seams.closestParam.mockReset()
  setSketchCallback('onMutation', null)
  useSketchEditorStore.setState({
    drag: null, dragPending: null, dragStartClient: null, isPointerDown: false,
    hoveredSelectionId: null, pendingDialog: null,
  })
  installFeature(extrudeFeature())
})

afterEach(() => {
  cleanup()
})

describe('FeatureHandles container', () => {
  it('renders nothing without an editing feature or a handle', () => {
    usePartEditorStore.setState({ editingFeatureId: null })
    expect(render(<FeatureHandles />).container.firstChild).toBeNull()

    usePartEditorStore.setState({ editingFeatureId: 'F1', solveResults: {} })
    expect(render(<FeatureHandles />).container.firstChild).toBeNull()
  })

  it('renders nothing when the feature is missing from the doc', () => {
    usePartEditorStore.setState({ editingFeatureId: 'F1', doc: { features: [] } as unknown as PartDoc, solveResults: { F1: { handle: HANDLE } } })
    expect(render(<FeatureHandles />).container.firstChild).toBeNull()
  })

  it('registers the pick segment from the tail to the tip while not dragging', () => {
    render(<FeatureHandles />)
    expect(seams.registration).toMatchObject({ featureId: 'F1', field: 'distance', enabled: true })
    const start = seams.registration!.start as number[]
    // tail length = value * unit_scale = 5, so the tail starts 5 behind the anchor
    expect(start[0]).toBeCloseTo(-5, 6)
  })
})

describe('FeatureHandles pointer-down guard', () => {
  it('seeds a feature_handle dragPending for a plain-number value', () => {
    render(<FeatureHandles />)
    act(() => seams.callbacks!.onPointerDown(100, 200))

    const st = useSketchEditorStore.getState()
    expect(st.isPointerDown).toBe(true)
    expect(st.dragStartClient).toEqual([100, 200])
    expect(st.dragPending).toMatchObject({
      type: 'feature_handle', featureId: 'F1', field: 'distance', startValue: 5, unitScale: 1, min: 0.1,
    })
  })

  it('refuses to start a drag for an expression value', () => {
    // The stored sub-def carries the raw expression string.
    const feature = extrudeFeature()
    ;(feature.extrude as unknown as Record<string, unknown>).distance = 'width*2'
    installFeature(feature)

    render(<FeatureHandles />)
    act(() => seams.callbacks!.onPointerDown(100, 200))

    expect(useSketchEditorStore.getState().dragPending).toBeNull()
    expect(useSketchEditorStore.getState().isPointerDown).toBe(false)
  })

  it('omits the max clamp when the handle has none', () => {
    render(<FeatureHandles />)
    act(() => seams.callbacks!.onPointerDown(1, 2))
    expect(useSketchEditorStore.getState().dragPending).not.toHaveProperty('max')
  })
})

describe('FeatureHandles double-click edit', () => {
  it('opens the dialog with the raw stored value and feature label', () => {
    render(<FeatureHandles />)
    act(() => seams.callbacks!.onDoubleClick(30, 40))

    const dialog = useSketchEditorStore.getState().pendingDialog
    expect(dialog).not.toBeNull()
    expect(dialog!.label).toBe('Extrude distance')
    expect(dialog!.defaultValue).toBe('5')
    expect(dialog!.position).toEqual([30, 40])
  })

  it('validates numbers and expressions, rejecting non-positive values', () => {
    render(<FeatureHandles />)
    act(() => seams.callbacks!.onDoubleClick(0, 0))
    const validate = useSketchEditorStore.getState().pendingDialog!.validate!

    expect(validate('abc')).toBe('Enter a number or expression')
    expect(validate('0')).toBe('Must be greater than 0')
    expect(validate('-2')).toBe('Must be greater than 0')
    expect(validate('12')).toBeNull()
  })

  it('stores a plain number as a number and an expression as the raw string', () => {
    const onMutation = vi.fn()
    setSketchCallback('onMutation', onMutation)
    render(<FeatureHandles />)
    act(() => seams.callbacks!.onDoubleClick(0, 0))

    const confirm = useSketchEditorStore.getState().pendingDialog!.onConfirm
    act(() => confirm('12'))
    expect(onMutation).toHaveBeenLastCalledWith({
      type: 'set_extrude_field', featureId: 'F1', field: 'distance', value: 12,
    })

    act(() => confirm(' width * 2 '))
    expect(onMutation).toHaveBeenLastCalledWith({
      type: 'set_extrude_field', featureId: 'F1', field: 'distance', value: 'width * 2',
    })
  })
})

describe('FeatureHandles drag-to-commit gesture', () => {
  it('activates past the click threshold, tracks the axis, and commits the rounded value on release', () => {
    const onMutation = vi.fn()
    setSketchCallback('onMutation', onMutation)
    seams.closestParam.mockReturnValueOnce(10).mockReturnValueOnce(12)

    render(<FeatureHandles />)
    act(() => seams.callbacks!.onPointerDown(100, 200))

    // One move far enough to trip the threshold activates the drag and applies
    // the travel in the same frame.
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 200 }))
    })
    expect(useSketchEditorStore.getState().drag).toMatchObject({
      type: 'feature_handle', featureId: 'F1', field: 'distance', startValue: 5, currentValue: 7,
    })

    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup'))
    })

    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_extrude_field', featureId: 'F1', field: 'distance', value: 7,
    })
    expect(useSketchEditorStore.getState().drag).toBeNull()
    expect(useSketchEditorStore.getState().dragPending).toBeNull()
  })

  it('a stationary release drops the pending gesture without committing', () => {
    const onMutation = vi.fn()
    setSketchCallback('onMutation', onMutation)
    render(<FeatureHandles />)
    act(() => seams.callbacks!.onPointerDown(100, 200))
    expect(useSketchEditorStore.getState().dragPending).not.toBeNull()

    // No pointermove ever crossed the click threshold, so the drag never
    // activated: the release must clear the pending state without a mutation.
    act(() => { window.dispatchEvent(new MouseEvent('pointerup')) })

    expect(useSketchEditorStore.getState().dragPending).toBeNull()
    expect(useSketchEditorStore.getState().drag).toBeNull()
    expect(onMutation).not.toHaveBeenCalled()
  })

  it('drops a live handle gesture on unmount so orbit cannot stay locked', () => {
    const { unmount } = render(<FeatureHandles />)
    act(() => seams.callbacks!.onPointerDown(100, 200))
    expect(useSketchEditorStore.getState().dragPending).not.toBeNull()

    unmount()

    expect(useSketchEditorStore.getState().dragPending).toBeNull()
    expect(useSketchEditorStore.getState().drag).toBeNull()
  })

  it('does not amend the value for a sub-centesimal micro-drag', () => {
    const onMutation = vi.fn()
    setSketchCallback('onMutation', onMutation)
    seams.closestParam.mockReturnValueOnce(10).mockReturnValueOnce(10.001)

    render(<FeatureHandles />)
    act(() => seams.callbacks!.onPointerDown(100, 200))
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 200 }))
    })
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup'))
    })

    expect(onMutation).not.toHaveBeenCalled()
    expect(useSketchEditorStore.getState().drag).toBeNull()
  })
})
