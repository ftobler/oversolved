import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as THREE from 'three'
import { render, act, cleanup } from '@testing-library/react'
import { useSketchEditorStore, setSketchCallback, useSketchUiStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore, DEFAULT_PART_EDITOR_DATA } from '@/stores/partEditorStore'
import { TurntableControls } from '@/components/Viewport/turntable'
import { createPointerClaims } from '@/viewport/pointerClaim'
import { installPointerEventStub } from '@/testing/pointerEventStub'
import type { ExtrudeFeatureDef, FeatureHandleData, PartDoc, PartFeature } from '@/types/cad'

/**
 * FeatureHandles owns the whole editing-arrow gesture: it decides whether a
 * stored value is draggable at all (an expression must not be silently
 * destroyed by a drag commit), seeds the pending drag, validates the
 * double-click edit, and commits the rounded value on release. These tests
 * drive the callbacks the component registers into the ID dispatcher and the
 * window-level gesture listeners, with the pure math kept real.
 */

const seams = vi.hoisted(() => {
  const domElement = document.createElement('canvas')
  Object.defineProperty(domElement, 'clientWidth', { value: 800 })
  Object.defineProperty(domElement, 'clientHeight', { value: 600 })
  Object.defineProperty(domElement, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  })
  return {
    callbacks: null as {
      onPointerDown: (x: number, y: number) => void
      onDoubleClick: (x: number, y: number) => void
    } | null,
    registration: null as Record<string, unknown> | null,
    closestParam: vi.fn(),
    camera: null as unknown as THREE.OrthographicCamera,
    gl: { domElement },
  }
})

installPointerEventStub('touch')

vi.mock('@react-three/fiber', () => ({
  useFrame: () => {},
  useThree: () => ({
    camera: seams.camera,
    gl: seams.gl,
    size: { width: 800, height: 600 },
  }),
}))

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
import { useEditorState } from '@/hooks/useEditorState'

const HANDLE: FeatureHandleData = {
  kind: 'linear',
  field: 'distance',
  anchor: [0, 0, 0],
  direction: [1, 0, 0],
  value: 5,
  unit_scale: 1,
  min: 0.1,
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

/** Let a settled mutation's pump continuation run. */
async function settleGate(gate: { resolve: () => void }): Promise<void> {
  await act(async () => {
    gate.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function extrudeFeature(overrides: Partial<ExtrudeFeatureDef> = {}): PartFeature {
  return {
    id: 'F1',
    kind: 'extrude',
    label: 'Extrude',
    extrude: { sketch: [], distance: 5, ...overrides },
  }
}

function installFeature(feature: PartFeature) {
  usePartEditorStore.setState({
    ...DEFAULT_PART_EDITOR_DATA,
    doc: { features: [feature] } as unknown as PartDoc,
    solveResults: { F1: { handle: HANDLE } },
  })
  useEditorState.setState({
    editingFeatureId: 'F1',
  })
}

beforeEach(() => {
  seams.callbacks = null
  seams.registration = null
  seams.closestParam.mockReset()
  seams.camera = new THREE.OrthographicCamera(-400, 400, 300, -300, -1000, 1000)
  seams.camera.position.set(20, 20, 100)
  seams.camera.updateProjectionMatrix()
  setSketchCallback('onMutation', null)
  setSketchCallback('isEditSessionOpen', null)
  useEditorState.setState({
    drag: null,
    dragPending: null,
    dragStartClient: null,
    isPointerDown: false,
    hoveredSelectionId: null,
  })
  useSketchUiStore.setState({
    pendingDialog: null,
  })
  installFeature(extrudeFeature())
})

afterEach(() => {
  cleanup()
})

describe('FeatureHandles container', () => {
  it('renders nothing without an editing feature or a handle', () => {
    useEditorState.setState({
    editingFeatureId: null,
  })
    expect(render(<FeatureHandles />).container.firstChild).toBeNull()

    usePartEditorStore.setState({
    solveResults: {},
  })
  useEditorState.setState({
    editingFeatureId: 'F1',
  })
    expect(render(<FeatureHandles />).container.firstChild).toBeNull()
  })

  it('renders nothing when the feature is missing from the doc', () => {
    usePartEditorStore.setState({
    doc: { features: [] } as unknown as PartDoc,
    solveResults: { F1: { handle: HANDLE } },
  })
  useEditorState.setState({
    editingFeatureId: 'F1',
  })
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
    if (feature.kind !== 'extrude') throw new Error('fixture is not an extrude')
    feature.extrude.distance = 'width*2'
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

    const dialog = useSketchUiStore.getState().pendingDialog
    expect(dialog).not.toBeNull()
    expect(dialog!.label).toBe('Extrude distance')
    expect(dialog!.defaultValue).toBe('5')
    expect(dialog!.position).toEqual([30, 40])
  })

  it('validates numbers and expressions, rejecting non-positive values', () => {
    render(<FeatureHandles />)
    act(() => seams.callbacks!.onDoubleClick(0, 0))
    const validate = useSketchUiStore.getState().pendingDialog!.validate!

    // The shared value rules' words, the same as a schema field's, and the
    // variable scope of the edited feature: no variable is defined above it.
    expect(validate('abc')).toBe(
      'Value refused: unknown variable "abc"; no variables are defined above this feature',
    )
    expect(validate('0')).toBe('Value refused: must be greater than 0')
    expect(validate('-2')).toBe('Value refused: must be greater than 0')
    expect(validate('12')).toBeNull()
  })

  it('accepts a variable defined above the feature and refuses an unknown one by name', () => {
    const width: PartFeature = {
      id: 'W1', kind: 'variable', label: 'width', variable: { expression: 40 },
    }
    usePartEditorStore.setState({
      ...DEFAULT_PART_EDITOR_DATA,
      doc: { features: [width, extrudeFeature()] } as unknown as PartDoc,
      solveResults: { F1: { handle: HANDLE } },
    })
    render(<FeatureHandles />)
    act(() => { seams.callbacks!.onDoubleClick(0, 0) })
    const validate = useSketchUiStore.getState().pendingDialog!.validate!

    expect(validate('width')).toBeNull()
    expect(validate('width/2')).toBeNull()
    expect(validate('nope')).toBe(
      'Value refused: unknown variable "nope"; defined above this feature: width',
    )
  })

  it('stores a plain number as a number and an expression as the raw string', () => {
    const onMutation = vi.fn()
    setSketchCallback('onMutation', onMutation)
    render(<FeatureHandles />)
    act(() => seams.callbacks!.onDoubleClick(0, 0))

    const confirm = useSketchUiStore.getState().pendingDialog!.onConfirm
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

  it('a touch drag moves the value and leaves the camera where it was', () => {
    // Same reported bug as the section arrow, one layer up: the store gate that
    // disables orbit only lands on a React commit, so a move dispatched before
    // it would rotate. The press claim is what holds the camera off.
    const onMutation = vi.fn()
    setSketchCallback('onMutation', onMutation)
    const camera = seams.camera
    const controls = new TurntableControls(camera, seams.gl.domElement)
    controls.azimuth = 0.4
    controls.elevation = 0.3
    controls.update()
    const claims = createPointerClaims()
    controls.pointerClaimed = id => claims.isClaimed(id)
    const before = { position: camera.position.toArray(), quaternion: camera.quaternion.toArray() }

    render(<FeatureHandles />)

    act(() => {
      // The controller saw the press first, as the canvas listener order does.
      seams.gl.domElement.dispatchEvent(new PointerEvent('pointerdown', {
        pointerType: 'touch', pointerId: 44, isPrimary: true, button: 0,
        clientX: 100, clientY: 200, bubbles: true, cancelable: true,
      }))
      // The dispatcher routes the press to the arrow and claims the pointer.
      seams.callbacks!.onPointerDown(100, 200)
      claims.claim(44)
      // No commit has run yet, so the arrow's window listener is not bound: this
      // is the window where only the claim keeps the camera still.
      document.dispatchEvent(new PointerEvent('pointermove', {
        pointerType: 'touch', pointerId: 44, clientX: 300, clientY: 200, bubbles: true,
      }))
    })
    expect(useSketchEditorStore.getState().drag).toBeNull()
    expect({ position: camera.position.toArray(), quaternion: camera.quaternion.toArray() }).toEqual(before)

    seams.closestParam.mockReturnValueOnce(10).mockReturnValueOnce(12)
    act(() => {
      document.dispatchEvent(new PointerEvent('pointermove', {
        pointerType: 'touch', pointerId: 44, clientX: 320, clientY: 200, bubbles: true,
      }))
    })
    expect(useSketchEditorStore.getState().drag).toMatchObject({
      type: 'feature_handle', featureId: 'F1', field: 'distance', currentValue: 7,
    })
    expect({ position: camera.position.toArray(), quaternion: camera.quaternion.toArray() }).toEqual(before)

    act(() => {
      document.dispatchEvent(new PointerEvent('pointerup', {
        pointerType: 'touch', pointerId: 44, clientX: 320, clientY: 200, bubbles: true,
      }))
    })
    expect(onMutation).toHaveBeenCalledWith({
      type: 'set_extrude_field', featureId: 'F1', field: 'distance', value: 7,
    })
    controls.dispose()
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

/** Pointer moves at the queued axis parameters (fallback: past the axis, no move). */
function moveAt(param: number) {
  seams.closestParam.mockReturnValueOnce(param)
  act(() => {
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 200 }))
  })
}

function dispatchedValues(onMutation: ReturnType<typeof vi.fn>): unknown[] {
  return onMutation.mock.calls.map(call => (call[0] as { value: unknown }).value)
}

/** Let a pump whose send resolved synchronously issue its next value. */
async function flushPump(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('FeatureHandles live rebuild while dragging', () => {
  beforeEach(() => {
    seams.closestParam.mockReturnValue(null)
  })

  it('keeps one solve in flight and sends only the newest value', async () => {
    const gates: Array<ReturnType<typeof deferred>> = []
    const onMutation = vi.fn(() => {
      const gate = deferred()
      gates.push(gate)
      return gate.promise
    })
    setSketchCallback('onMutation', onMutation)

    render(<FeatureHandles />)
    act(() => seams.callbacks!.onPointerDown(100, 200))
    // Activation at the start value: the drag is armed but nothing has moved.
    seams.closestParam.mockReturnValueOnce(10).mockReturnValueOnce(10)
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 200 }))
    })
    expect(onMutation).not.toHaveBeenCalled()

    // 10.2 is sent; 10.7 and 11.3 only replace the waiting value.
    moveAt(15.2)
    moveAt(15.7)
    moveAt(16.3)
    expect(dispatchedValues(onMutation)).toEqual([10.2])

    await settleGate(gates[0])
    expect(dispatchedValues(onMutation)).toEqual([10.2, 11.3])

    // Release at 12: the gesture is over, so the final value is sent at once
    // and lands inside the still-open edit session.
    moveAt(17)
    act(() => { window.dispatchEvent(new MouseEvent('pointerup')) })
    expect(dispatchedValues(onMutation)).toEqual([10.2, 11.3, 12])
    expect(useSketchEditorStore.getState().drag).toBeNull()
  })

  it('keeps the preview following the drag back to the start', async () => {
    const onMutation = vi.fn()
    setSketchCallback('onMutation', onMutation)
    // A stored value can carry more decimals than the 0.01 commit step; the
    // restore must be exact, not the rounded step.
    installFeature(extrudeFeature({ distance: 5.125 }))
    usePartEditorStore.setState({ solveResults: { F1: { handle: { ...HANDLE, value: 5.125 } } } })

    render(<FeatureHandles />)
    act(() => seams.callbacks!.onPointerDown(100, 200))
    seams.closestParam.mockReturnValueOnce(10).mockReturnValueOnce(10)
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 200 }))
    })
    moveAt(18)  // 13.125, committed as its rounded step
    expect(dispatchedValues(onMutation)).toEqual([13.13])
    await flushPump()

    // The trip back offers the start step like any other value: the preview
    // must follow the arrow, not stop at the last step it happened to send.
    moveAt(10)  // 5.125, rounds to the start step
    expect(dispatchedValues(onMutation)).toEqual([13.13, 5.13])
    await flushPump()

    // The release restores the authored value exactly, not its step.
    act(() => { window.dispatchEvent(new MouseEvent('pointerup')) })
    expect(dispatchedValues(onMutation)).toEqual([13.13, 5.13, 5.125])
  })

  it('restores a stored plain-number string as a string', async () => {
    const onMutation = vi.fn()
    setSketchCallback('onMutation', onMutation)
    // The handle evaluates "5" to 5 for the drag, but putting it back as the
    // number 5 would dirty the document with a spelling change.
    installFeature(extrudeFeature({ distance: '5' }))

    render(<FeatureHandles />)
    act(() => seams.callbacks!.onPointerDown(100, 200))
    seams.closestParam.mockReturnValueOnce(10).mockReturnValueOnce(10)
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 200 }))
    })
    moveAt(18)  // 13
    await flushPump()
    moveAt(10)  // back to the start
    await flushPump()

    act(() => { window.dispatchEvent(new MouseEvent('pointerup')) })
    expect(dispatchedValues(onMutation)).toEqual([13, 5, '5'])
  })

  it('dispatches nothing for a move under the click threshold', () => {
    const onMutation = vi.fn()
    setSketchCallback('onMutation', onMutation)
    seams.closestParam.mockReturnValue(10)

    render(<FeatureHandles />)
    act(() => seams.callbacks!.onPointerDown(100, 200))
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 101, clientY: 200 }))
    })
    expect(useSketchEditorStore.getState().drag).toBeNull()
    expect(onMutation).not.toHaveBeenCalled()
  })
})

describe('FeatureHandles drag survives its own solves', () => {
  it('keeps the arrow and the gesture alive while the solve result is missing', async () => {
    const onMutation = vi.fn()
    setSketchCallback('onMutation', onMutation)
    seams.closestParam.mockReturnValue(null)

    const { container, unmount } = render(<FeatureHandles />)
    act(() => seams.callbacks!.onPointerDown(100, 200))
    seams.closestParam.mockReturnValueOnce(10).mockReturnValueOnce(10)
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 200 }))
    })
    moveAt(12)  // 7
    expect(onMutation).toHaveBeenCalledTimes(1)
    await flushPump()

    // A failing live solve leaves no handle for the edited feature.
    act(() => {
      usePartEditorStore.setState({ solveResults: { F1: {} } })
    })
    expect(seams.callbacks).not.toBeNull()
    expect(container.firstChild).not.toBeNull()
    expect(useSketchEditorStore.getState().drag).not.toBeNull()

    moveAt(13)  // 8, still priced from the held handle
    expect(dispatchedValues(onMutation)).toEqual([7, 8])
    await flushPump()

    // The next good solve installs a fresh handle and the gesture continues.
    const fresh: FeatureHandleData = { ...HANDLE, value: 8, anchor: [3, 0, 0] }
    act(() => {
      usePartEditorStore.setState({ solveResults: { F1: { handle: fresh } } })
    })
    expect(seams.callbacks).not.toBeNull()
    moveAt(14)  // 9
    expect(dispatchedValues(onMutation)).toEqual([7, 8, 9])

    unmount()
  })
})

describe('FeatureHandles ends a lost pointer', () => {
  it('restores the authored start on unmount while the edit session is open', async () => {
    const onMutation = vi.fn()
    setSketchCallback('onMutation', onMutation)
    setSketchCallback('isEditSessionOpen', () => true)
    seams.closestParam.mockReturnValue(null)

    const { unmount } = render(<FeatureHandles />)
    act(() => seams.callbacks!.onPointerDown(100, 200))
    seams.closestParam.mockReturnValueOnce(10).mockReturnValueOnce(10)
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 200 }))
    })
    moveAt(12)  // 7 reaches the document
    await flushPump()

    unmount()
    expect(dispatchedValues(onMutation)).toEqual([7, 5])
    expect(useSketchEditorStore.getState().drag).toBeNull()
    expect(useSketchEditorStore.getState().dragPending).toBeNull()
  })

  it('drops the drag without a restore once the edit session closed', async () => {
    const onMutation = vi.fn()
    setSketchCallback('onMutation', onMutation)
    setSketchCallback('isEditSessionOpen', () => false)
    seams.closestParam.mockReturnValue(null)

    const { unmount } = render(<FeatureHandles />)
    act(() => seams.callbacks!.onPointerDown(100, 200))
    seams.closestParam.mockReturnValueOnce(10).mockReturnValueOnce(10)
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 200 }))
    })
    moveAt(12)  // 7
    await flushPump()

    // OK or Cancel already closed the session: a restore here would be a new
    // edit, not a rewind, so the drag is only dropped.
    unmount()
    expect(dispatchedValues(onMutation)).toEqual([7])
    expect(useSketchEditorStore.getState().drag).toBeNull()
  })

  it('restores on pointercancel and stops listening for the lost pointer', () => {
    const onMutation = vi.fn()
    setSketchCallback('onMutation', onMutation)
    setSketchCallback('isEditSessionOpen', () => true)
    seams.closestParam.mockReturnValue(null)

    render(<FeatureHandles />)
    act(() => seams.callbacks!.onPointerDown(100, 200))
    seams.closestParam.mockReturnValueOnce(10).mockReturnValueOnce(10)
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 200 }))
    })
    moveAt(12)  // 7

    act(() => { window.dispatchEvent(new Event('pointercancel')) })
    expect(dispatchedValues(onMutation)).toEqual([7, 5])
    const st = useSketchEditorStore.getState()
    expect(st.drag).toBeNull()
    expect(st.dragPending).toBeNull()
    expect(st.isPointerDown).toBe(false)

    // The gesture is over: a stray move no longer rebuilds.
    moveAt(13)
    expect(dispatchedValues(onMutation)).toEqual([7, 5])
  })

  it('restores when the window loses focus mid-drag', () => {
    const onMutation = vi.fn()
    setSketchCallback('onMutation', onMutation)
    setSketchCallback('isEditSessionOpen', () => true)
    seams.closestParam.mockReturnValue(null)

    render(<FeatureHandles />)
    act(() => seams.callbacks!.onPointerDown(100, 200))
    seams.closestParam.mockReturnValueOnce(10).mockReturnValueOnce(10)
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 200 }))
    })
    moveAt(12)  // 7

    act(() => { window.dispatchEvent(new Event('blur')) })
    expect(dispatchedValues(onMutation)).toEqual([7, 5])
    expect(useSketchEditorStore.getState().drag).toBeNull()
  })
})

describe('FeatureHandles measures travel from the solved handle', () => {
  function grabPoint(container: HTMLElement): [number, number, number] {
    const group = container.querySelector('group') as HTMLElement | null
    if (!group) throw new Error('no arrow group rendered')
    const raw = group.getAttribute('position') ?? ''
    return raw.split(',').map(Number) as [number, number, number]
  }

  it('does not add the anchor movement a second time (extrude)', () => {
    const onMutation = vi.fn()
    setSketchCallback('onMutation', onMutation)
    // Start at value 10 with the grab point at the 10 position.
    installFeature(extrudeFeature({ distance: 10 }))
    usePartEditorStore.setState({ solveResults: { F1: { handle: { ...HANDLE, value: 10 } } } })
    seams.closestParam.mockReturnValue(null)

    const { container } = render(<FeatureHandles />)
    act(() => seams.callbacks!.onPointerDown(100, 200))
    seams.closestParam.mockReturnValueOnce(0).mockReturnValueOnce(0)
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 200 }))
    })
    expect(grabPoint(container)[0]).toBeCloseTo(0, 6)

    moveAt(5)  // 15
    expect(grabPoint(container)[0]).toBeCloseTo(5, 6)
    // A linear handle keeps its world-sized tail during the drag: the tail
    // mesh plus the two head meshes.
    expect(container.querySelectorAll('mesh')).toHaveLength(3)

    // The live solve lands at 15 with the grab point already at 15.
    const solved: FeatureHandleData = { ...HANDLE, value: 15, anchor: [5, 0, 0] }
    act(() => {
      usePartEditorStore.setState({ solveResults: { F1: { handle: solved } } })
    })
    expect(grabPoint(container)[0]).toBeCloseTo(5, 6)
    expect(container.textContent).toContain('15.00')
  })

  it('does not add the anchor movement a second time (revolve)', () => {
    const onMutation = vi.fn()
    setSketchCallback('onMutation', onMutation)
    installFeature(extrudeFeature())
    const angular: FeatureHandleData = {
      kind: 'angular',
      field: 'angle',
      anchor: [0, 0, 0],
      direction: [0, 1, 0],
      value: 10,
      unit_scale: 1,
      min: 0.01,
      max: 360,
    }
    usePartEditorStore.setState({ solveResults: { F1: { handle: angular } } })
    seams.closestParam.mockReturnValue(null)

    const { container } = render(<FeatureHandles />)
    act(() => seams.callbacks!.onPointerDown(100, 200))
    seams.closestParam.mockReturnValueOnce(0).mockReturnValueOnce(0)
    act(() => {
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 300, clientY: 200 }))
    })

    moveAt(5)  // 15
    expect(grabPoint(container)[1]).toBeCloseTo(5, 6)
    // An angular handle deliberately has no straight world tail (it would
    // misrepresent the swept arc): only the two head meshes are drawn.
    expect(container.querySelectorAll('mesh')).toHaveLength(2)

    const solved: FeatureHandleData = { ...angular, value: 15, anchor: [0, 5, 0] }
    act(() => {
      usePartEditorStore.setState({ solveResults: { F1: { handle: solved } } })
    })
    expect(grabPoint(container)[1]).toBeCloseTo(5, 2)
    expect(container.textContent).toContain('15.00')
  })
})
