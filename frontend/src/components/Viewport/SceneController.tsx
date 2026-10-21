import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { drawCubeGizmo, type Pv, type Hit } from '@/components/misc/CubeGizmo.utils'
import { snapToDirection } from '@/components/Viewport/cameraController'
import { deriveOrbitEnabled } from '@/components/Viewport/orbitEnabled'
import { pickPivotPoint } from '@/components/Viewport/pivotPick'
import { useViewOptionsStore } from '@/stores/viewOptionsStore'
import {
  restoreTurntablePose,
  snapshotTurntablePose,
  TurntableControls,
  type TurntablePoseSnapshot,
} from '@/components/Viewport/turntable'

// Camera freeze fix: R3F wraps Canvas children in React.Suspense. When a child
// suspends mid-solve the entire Canvas tree hides and re-shows, tearing the
// controls' effect down and running it again. The pose rides on the Canvas
// camera's userData because the camera outlives the controller: the effect
// cleanup runs while the outgoing controller is still live, and the setup that
// follows adopts the carried pose before any frame can run. A per-instance ref
// cannot carry it across the teardown, because the cleanup is the only place
// the outgoing state is still readable.
interface PoseCarrier {
  turntablePose?: TurntablePoseSnapshot
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
  controlsRef: React.MutableRefObject<TurntableControls | null>
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
  const { camera, gl, scene, invalidate } = useThree()
  const ctrlRef = useRef<TurntableControls | null>(null)
  const cameraRefStable = useRef(camera)
  // eslint-disable-next-line react-hooks/refs -- mirror the latest camera into a ref without triggering a re-render
  cameraRefStable.current = camera

  // showSeq bumps every time this component's effect setup runs, which happens
  // on initial mount AND on every re-show after React Suspense hides the tree
  // (Suspense calls cleanup then re-runs setup on show). Rebuilding the
  // controller forces a clean gesture state after a reveal, and the carried
  // pose means the rebuild costs no camera movement.
  const [showSeq, setShowSeq] = useState(0)
  useEffect(() => {
    setShowSeq(k => k + 1)
  }, [])

  // The one owner of the incoming and outgoing controls. An attach restores the
  // carried pose before any frame can run, so the rebuilt controller cannot
  // overwrite it with the camera's current default; a detach stashes the live
  // pose on the camera for the next attach.
  const attachControls = useCallback((ctrl: TurntableControls | null) => {
    const cam = cameraRefStable.current
    if (ctrl) {
      const state = (cam.userData as PoseCarrier).turntablePose
      if (state) restoreTurntablePose(ctrl, state)
      ctrlRef.current = ctrl
      controlsRef.current = ctrl
      return
    }
    const last = ctrlRef.current
    if (last) {
      ;(cam.userData as PoseCarrier).turntablePose = snapshotTurntablePose(last)
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

  const setIsRotating = useSketchEditorStore(s => s.setIsRotating)
  const orbitAroundCursor = useViewOptionsStore(s => s.orbit_around_cursor)

  // The controller listens on the renderer canvas, the same surface the old
  // drei OrbitControls bound to, so modifiers and gestures work everywhere in
  // the pane rather than only over the 140x140 gizmo corner.
  useLayoutEffect(() => {
    const cam = cameraRefStable.current
    if (!cam || !gl?.domElement) return
    const ctrl = new TurntableControls(cam, gl.domElement)
    ctrl.onChange = () => invalidate?.()
    ctrl.onStart = () => setIsRotating(true)
    ctrl.onEnd = () => setIsRotating(false)
    // The raycast needs the scene and the renderer canvas, neither of which the
    // framework-free controller may know about, so it is injected here.
    ctrl.pivotPick = (clientX, clientY) => pickPivotPoint(
      cam,
      scene,
      gl.domElement.getBoundingClientRect(),
      clientX,
      clientY,
    )
    ctrl.orbitAroundCursor = useViewOptionsStore.getState().orbit_around_cursor
    attachControls(ctrl)
    return () => {
      attachControls(null)
      ctrl.dispose()
    }
  }, [camera, gl, scene, invalidate, setIsRotating, showSeq, attachControls])

  // The preference is a runtime gate, like `enabled`: toggling it must not
  // rebuild the controller and drop the live pose.
  useEffect(() => {
    if (ctrlRef.current) ctrlRef.current.orbitAroundCursor = orbitAroundCursor
  }, [orbitAroundCursor, showSeq])

  // `enabled` is a runtime gate, not a reason to rebuild the controller: a
  // sketch drag or a part manipulation can toggle it every gesture.
  const drag = useSketchEditorStore(s => s.drag)
  const dragPending = useSketchEditorStore(s => s.dragPending)
  const isPointerDown = useSketchEditorStore(s => s.isPointerDown)
  const sketchOrbitEnabled = deriveOrbitEnabled(isPointerDown, drag, dragPending)
  const orbitAllowed = orbitEnabled ?? sketchOrbitEnabled
  useEffect(() => {
    if (ctrlRef.current) ctrlRef.current.enabled = orbitAllowed
  }, [orbitAllowed, showSeq])

  useFrame(() => {
    if (snapRef.current) {
      snapToDirection(camera, ctrlRef.current, snapRef.current)
      snapRef.current = null
    }

    if (gizmoCanvasRef.current)
      // The 4th argument is what a demand-rendered Canvas needs: the label font
      // can land after the frame that requested it, and the arrival asks for
      // the repaint itself instead of waiting for the next unrelated frame.
      pvRef.current = drawCubeGizmo(gizmoCanvasRef.current, camera, hoverRef.current, invalidate)
  })

  return null
}
