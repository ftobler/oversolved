import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import * as THREE from 'three'
import { createRef } from 'react'
import { CubeGizmoCanvas } from '@/components/misc/CubeGizmo'
import { GIZMO_SIZE } from '@/components/misc/CubeGizmo.utils'
import type { Pv, Hit } from '@/components/misc/CubeGizmo.utils'

// The gizmo overlay is a plain <canvas> with DOM handlers; it owns no R3F scene,
// so it is unit testable in isolation (the "delete the Viewport, logic still
// passes" rule). computeGizmoHit ignores its pv argument, so a single dummy
// entry satisfies the not-yet-drawn-frame guard while still passing the length
// check.

const identityCamera = () => {
  const cam = new THREE.Camera()
  cam.quaternion.identity()
  return cam
}

function mount(onRequestRender?: () => void) {
  const canvasRef = createRef<HTMLCanvasElement>()
  const pvRef = { current: [{ sx: 1, sy: 1, z: 0 }] as Pv[] }  // non-empty passes the guard
  const hoverRef = { current: null as Hit | null }
  const snapRef = { current: null as THREE.Vector3 | null }
  const cameraRef = { current: identityCamera() as THREE.Camera | null }

  // A React ancestor stands in for the viewport pane, whose container-level
  // handlers would otherwise open a band and a click gesture from a press that
  // bubbles up out of the gizmo canvas. stopPropagation only halts React's
  // synthetic bubbling, so the ancestor uses React handlers too.
  const onAncestorDown = vi.fn()
  const onAncestorUp = vi.fn()
  const onAncestorClick = vi.fn()

  const { container } = render(
    <div data-testid="ancestor" onPointerDown={onAncestorDown} onPointerUp={onAncestorUp} onClick={onAncestorClick}>
      <CubeGizmoCanvas
        canvasRef={canvasRef}
        pvRef={pvRef}
        hoverRef={hoverRef}
        snapRef={snapRef}
        cameraRef={cameraRef}
        onRequestRender={onRequestRender}
      />
    </div>,
  )
  canvasRef.current = container.querySelector('canvas') as HTMLCanvasElement
  return {
    container,
    canvas: canvasRef.current,
    canvasRef,
    pvRef,
    hoverRef,
    snapRef,
    cameraRef,
    ancestor: container.querySelector('[data-testid="ancestor"]') as HTMLElement,
    onAncestorDown,
    onAncestorUp,
    onAncestorClick,
  }
}

describe('CubeGizmo click writes the camera snap direction', () => {
  let m: ReturnType<typeof mount>
  beforeEach(() => { m = mount() })

  it('a click on the cube centre writes the faced direction into snapRef', () => {
    const C = GIZMO_SIZE / 2
    fireEvent.click(m.canvas, { clientX: C, clientY: C })
    expect(m.snapRef.current).not.toBeNull()
    expect(m.snapRef.current!.x).toBeCloseTo(0)
    expect(m.snapRef.current!.y).toBeCloseTo(0)
    expect(m.snapRef.current!.z).toBeCloseTo(1)
  })

  it('a click outside the cube leaves snapRef untouched', () => {
    fireEvent.click(m.canvas, { clientX: 2, clientY: 2 })
    expect(m.snapRef.current).toBeNull()
  })

  it('a click with an empty pv buffer leaves snapRef untouched', () => {
    m.pvRef.current = []
    const C = GIZMO_SIZE / 2
    fireEvent.click(m.canvas, { clientX: C, clientY: C })
    expect(m.snapRef.current).toBeNull()
  })
})

describe('CubeGizmo owns its own gesture', () => {
  let m: ReturnType<typeof mount>

  beforeEach(() => {
    m = mount()
  })

  it('a pointerdown on the gizmo does not propagate to an ancestor listener', () => {
    fireEvent.pointerDown(m.canvas, { button: 0, pointerId: 1, isPrimary: true })
    expect(m.onAncestorDown).not.toHaveBeenCalled()
  })

  it('a pointerup on the gizmo does not propagate to an ancestor listener', () => {
    fireEvent.pointerUp(m.canvas, { button: 0, pointerId: 1, isPrimary: true })
    expect(m.onAncestorUp).not.toHaveBeenCalled()
  })

  it('a click on the gizmo does not propagate to an ancestor while still running its own handler', () => {
    const C = GIZMO_SIZE / 2
    fireEvent.click(m.canvas, { clientX: C, clientY: C })
    // Its own handler ran (snapRef set) yet the ancestor never saw the click.
    expect(m.snapRef.current).not.toBeNull()
    expect(m.onAncestorClick).not.toHaveBeenCalled()
  })
})

describe('CubeGizmo hover cursor', () => {
  let m: ReturnType<typeof mount>
  beforeEach(() => { m = mount() })

  it('mouse-move sets the pointer cursor on a hit and clears it on leave', () => {
    const C = GIZMO_SIZE / 2
    fireEvent.mouseMove(m.canvas, { clientX: C, clientY: C })
    expect(m.canvas.style.cursor).toBe('pointer')
    fireEvent.mouseLeave(m.canvas)
    expect(m.canvas.style.cursor).toBe('default')
  })
})

describe('CubeGizmo asks for its frame', () => {
  // The gizmo is painted from the render loop's useFrame (SceneController), and
  // the part viewport draws on demand: hover and snap change what that frame
  // would draw while touching nothing React can see, so each has to request a
  // frame itself.
  it('hover, leave and a snapping click each request a frame', () => {
    const onRequestRender = vi.fn()
    const m = mount(onRequestRender)
    const C = GIZMO_SIZE / 2

    fireEvent.mouseMove(m.canvas, { clientX: C, clientY: C })
    expect(onRequestRender).toHaveBeenCalledTimes(1)

    fireEvent.mouseLeave(m.canvas)
    expect(onRequestRender).toHaveBeenCalledTimes(2)

    fireEvent.click(m.canvas, { clientX: C, clientY: C })
    expect(onRequestRender).toHaveBeenCalledTimes(3)
  })

  it('a move that stays on the same face requests no second frame', () => {
    const onRequestRender = vi.fn()
    const m = mount(onRequestRender)
    const C = GIZMO_SIZE / 2

    fireEvent.mouseMove(m.canvas, { clientX: C, clientY: C })
    fireEvent.mouseMove(m.canvas, { clientX: C + 3, clientY: C + 3 })

    // Same face: the highlight did not change, so grazing the cube must not
    // redraw the scene and the pick buffer per pointermove.
    expect(onRequestRender).toHaveBeenCalledTimes(1)
  })

  it('a move off the cube requests the clear, but leaving an unhovered cube requests nothing', () => {
    const onRequestRender = vi.fn()
    const m = mount(onRequestRender)
    const C = GIZMO_SIZE / 2

    fireEvent.mouseMove(m.canvas, { clientX: C, clientY: C })
    fireEvent.mouseMove(m.canvas, { clientX: 3, clientY: 3 })
    expect(onRequestRender).toHaveBeenCalledTimes(2)

    onRequestRender.mockClear()
    fireEvent.mouseLeave(m.canvas)
    expect(onRequestRender).not.toHaveBeenCalled()
  })

  it('a click that hits nothing requests no frame', () => {
    const onRequestRender = vi.fn()
    const m = mount(onRequestRender)

    fireEvent.click(m.canvas, { clientX: 2, clientY: 2 })

    expect(onRequestRender).not.toHaveBeenCalled()
  })
})

describe('CubeGizmo null guards', () => {
  let m: ReturnType<typeof mount>
  beforeEach(() => { m = mount() })

  it('a click with no camera leaves snapRef untouched', () => {
    m.cameraRef.current = null
    const C = GIZMO_SIZE / 2
    fireEvent.click(m.canvas, { clientX: C, clientY: C })
    expect(m.snapRef.current).toBeNull()
  })

  it('a mouse-move with no canvas leaves hoverRef null and the cursor default', () => {
    m.canvasRef.current = null
    const C = GIZMO_SIZE / 2
    fireEvent.mouseMove(m.canvas, { clientX: C, clientY: C })
    expect(m.hoverRef.current).toBeNull()
    expect(m.canvas.style.cursor).toBe('default')
  })
})
