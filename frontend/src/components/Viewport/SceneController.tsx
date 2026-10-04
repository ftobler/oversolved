import { useCallback, useEffect, useRef, useState } from 'react'
import { OrbitControls } from '@react-three/drei'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { drawCubeGizmo, type Pv, type Hit } from '@/components/misc/CubeGizmo.utils'
import { snapToDirection } from '@/components/Viewport/cameraController'
import { deriveOrbitEnabled } from '@/components/Viewport/orbitEnabled'

const MOUSE_BUTTONS = {
  LEFT: -1 as unknown as THREE.MOUSE,
  MIDDLE: THREE.MOUSE.PAN,
  RIGHT: THREE.MOUSE.ROTATE,
}

function rightButtonMapping(e: MouseEvent | PointerEvent): THREE.MOUSE {
  if (e.shiftKey) return THREE.MOUSE.DOLLY
  if (e.ctrlKey || e.metaKey) return THREE.MOUSE.PAN
  return THREE.MOUSE.ROTATE
}

// Camera freeze fix: R3F wraps Canvas children in React.Suspense. When a
// child suspends mid-solve the entire Canvas tree hides and re-shows,
// disposing OrbitControls in between. Three-stdlib's dispose() removes
// document-level listeners but does not clear the private pointers array,
// so after reconnect the controls can never re-arm. We force a fresh
// OrbitControls instance on every show by bumping showSeq in the effect
// that re-fires on each show, and carry the camera pose across the rebuild.
interface SavedOrbitState {
  position: [number, number, number]
  target: [number, number, number]
  zoom: number
}

// The pose rides on the Canvas camera's userData because the camera outlives
// the rebuild while the controls does not. A per-instance ref cannot carry it:
// React detaches the OrbitControls ref during the commit phase, before the
// passive-effect cleanup that used to read it, so the save never ran and the
// orbit target reset to (0,0,0) after any Suspense cycle.
interface PoseCarrier {
  orbitPose?: SavedOrbitState
}

interface SceneControllerProps {
  /**
   * The gizmo overlay canvas: the 140x140 corner element CubeGizmoCanvas owns.
   * Only used as the draw target for the cube; pointer capture lives on the
   * renderer canvas (gl.domElement), never here.
   */
  gizmoCanvasRef: React.RefObject<HTMLCanvasElement | null>
  pvRef: React.MutableRefObject<Pv[]>
  hoverRef: React.MutableRefObject<Hit | null>
  snapRef: React.MutableRefObject<THREE.Vector3 | null>
  cameraRef: React.MutableRefObject<THREE.Camera | null>
  controlsRef: React.MutableRefObject<OrbitControlsImpl | null>
  /**
   * Overrides the sketch-drag orbit gate. The assembly viewport has no sketch
   * drag; it blocks the camera while a part is being dragged instead.
   */
  orbitEnabled?: boolean
  /**
   * Fired once the Canvas-owned camera is exposed through cameraRef. The R3F
   * scene tree renders on a later frame than the host component's mount, so a
   * caller that armed work before this render (e.g. a first-solve camera fit)
   * needs this signal to know the camera can now be driven.
   */
  onReady?: () => void
}

export default function SceneController({ gizmoCanvasRef, pvRef, hoverRef, snapRef, cameraRef, controlsRef, orbitEnabled, onReady }: SceneControllerProps) {
  const { camera, gl } = useThree()
  const ctrlRef = useRef<OrbitControlsImpl | null>(null)
  const cameraRefStable = useRef(camera)
  // eslint-disable-next-line react-hooks/refs -- mirror the latest camera into a ref without triggering a re-render
  cameraRefStable.current = camera

  // showSeq bumps every time this component's effect setup runs, which
  // happens on initial mount AND on every re-show after React Suspense
  // hides the tree (Suspense calls cleanup then re-runs setup on show).
  // A clean OrbitControls key forces drei's useMemo to produce a fresh
  // three-stdlib instance with an empty pointers array.
  const [showSeq, setShowSeq] = useState(0)
  useEffect(() => {
    setShowSeq(k => k + 1)
  }, [])

  // The one owner of the incoming and outgoing controls. An attach applies the
  // carried pose before any frame can run, so the rebuilt controls' default
  // target cannot overwrite it; a detach stashes the live pose on the camera
  // for the next attach. Doing both in the ref callback is what makes the save
  // survive: it runs in the commit phase, while the outgoing controls and its
  // target are still live.
  const attachControls = useCallback((ctrl: OrbitControlsImpl | null) => {
    const cam = cameraRefStable.current
    if (ctrl) {
      const state = (cam.userData as PoseCarrier).orbitPose
      if (state) {
        cam.position.set(...state.position)
        ctrl.target.set(...state.target)
        cam.zoom = state.zoom
        cam.updateProjectionMatrix()
        ctrl.update()
      }
      ctrlRef.current = ctrl
      controlsRef.current = ctrl
      return
    }
    const last = ctrlRef.current
    if (last) {
      ;(cam.userData as PoseCarrier).orbitPose = {
        position: [cam.position.x, cam.position.y, cam.position.z],
        target: [last.target.x, last.target.y, last.target.z],
        zoom: cam.zoom,
      }
    }
    ctrlRef.current = null
    controlsRef.current = null
  }, [controlsRef])

  // Expose the Canvas-owned camera to the parent Viewport (for fitToContent).
  // eslint-disable-next-line react-hooks/refs -- expose the Canvas-owned camera to the parent Viewport without a re-render
  cameraRef.current = camera

  // Announce the camera live after it is exposed above. One-shot and gated on
  // a truthy camera: the production race is this component not having rendered
  // at all yet (R3F builds the scene tree a frame late), so a single
  // announcement per instance covers it, and a latch keeps a caller-side
  // setState from looping back through here when the camera identity churns.
  const announcedRef = useRef(false)
  useEffect(() => {
    if (announcedRef.current || !camera) return
    announcedRef.current = true
    onReady?.()
  }, [camera, onReady])

  // Right-button mapping: shift/ctrl/meta override the default rotate action.
  // Bound to the renderer canvas, not the gizmo overlay: OrbitControls listens
  // there, so a mapping attached to the 140x140 corner element would leave
  // right-drags elsewhere unremapped and let one modifier press stick into
  // every later plain right-drag. The handler re-evaluates on every press,
  // which is what keeps the mapping non-sticky for press-and-hold gestures.
  useEffect(() => {
    const canvas = gl.domElement
    if (!canvas) return
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 2 || !ctrlRef.current) return
      ctrlRef.current.mouseButtons.RIGHT = rightButtonMapping(e)
    }
    canvas.addEventListener('pointerdown', onPointerDown, { capture: true })
    return () => canvas.removeEventListener('pointerdown', onPointerDown, { capture: true })
  }, [gl])

  useFrame(() => {
    if (snapRef.current) {
      snapToDirection(camera, ctrlRef.current, snapRef.current)
      snapRef.current = null
    }

    if (gizmoCanvasRef.current)
      pvRef.current = drawCubeGizmo(gizmoCanvasRef.current, camera, hoverRef.current)
  })

  const drag = useSketchEditorStore(s => s.drag)
  const dragPending = useSketchEditorStore(s => s.dragPending)
  const isPointerDown = useSketchEditorStore(s => s.isPointerDown)
  const sketchOrbitEnabled = deriveOrbitEnabled(isPointerDown, drag, dragPending)
  const setIsRotating = useSketchEditorStore(s => s.setIsRotating)

  return (
    <OrbitControls
      key={showSeq}
      ref={attachControls}
      enabled={orbitEnabled ?? sketchOrbitEnabled}
      mouseButtons={MOUSE_BUTTONS}
      enableRotate
      enableZoom
      enablePan
      enableDamping={false}
      onStart={() => setIsRotating(true)}
      onEnd={() => setIsRotating(false)}
    />
  )
}
