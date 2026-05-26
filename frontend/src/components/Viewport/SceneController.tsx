import { useEffect, useLayoutEffect, useRef } from 'react'
import { OrbitControls } from '@react-three/drei'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { drawCubeGizmo, type Pv, type Hit } from '@/components/CubeGizmo.utils'

const INITIAL_POSITION: [number, number, number] = [20, 20, 100]
const INITIAL_ZOOM = 200

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

interface SceneControllerProps {
  resetTrigger?: number
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  pvRef: React.MutableRefObject<Pv[]>
  hoverRef: React.MutableRefObject<Hit | null>
  snapRef: React.MutableRefObject<THREE.Vector3 | null>
  cameraRef: React.MutableRefObject<THREE.Camera | null>
  controlsRef: React.MutableRefObject<OrbitControlsImpl | null>
}

export default function SceneController({ resetTrigger, canvasRef, pvRef, hoverRef, snapRef, cameraRef, controlsRef }: SceneControllerProps) {
  const { camera } = useThree()
  const ctrlRef = useRef<OrbitControlsImpl | null>(null)
  const mounted = useRef(false)

  // R3F can expose a new camera reference on scene changes (e.g. when
  // SketchPlaneDisplay or Geometry3D mounts during sketch edit entry).
  // Detect reference swaps during render and restore the previous position,
  // zoom, and orbit target so the user's view does not jump.
  const prevCameraRef = useRef<THREE.Camera | null>(null)
  const pendingRestore = useRef<{ pos: THREE.Vector3; zoom: number; target: THREE.Vector3 | null } | null>(null)

  if (prevCameraRef.current !== camera) {
    // Camera was replaced by R3F — save state from the previous instance
    // before it is lost.
    if (prevCameraRef.current) {
      const prevCam = prevCameraRef.current
      console.log('[CAMERA-DEBUG] SceneController: camera reference CHANGED, saving old state. oldPos=', prevCam.position.toArray(), 'oldZoom=', 'zoom' in prevCam ? (prevCam as unknown as { zoom: number }).zoom : 'N/A')
      pendingRestore.current = {
        pos: prevCam.position.clone(),
        zoom: ('zoom' in prevCam) ? (prevCam as unknown as { zoom: number }).zoom : INITIAL_ZOOM,
        target: ctrlRef.current?.target?.clone() ?? null,
      }
    } else {
      console.log('[CAMERA-DEBUG] SceneController: first camera init')
    }
    prevCameraRef.current = camera
  }

  cameraRef.current = camera

  // Apply any pending restore synchronously after the commit so the camera
  // state is correct before the browser paints the next frame.
  useLayoutEffect(() => {
    const saved = pendingRestore.current
    pendingRestore.current = null
    if (!saved) return
    console.log('[CAMERA-DEBUG] SceneController: restoring camera state. pos=', saved.pos.toArray(), 'zoom=', saved.zoom, 'target=', saved.target?.toArray())
    camera.position.copy(saved.pos)
    if ('zoom' in camera) {
      (camera as unknown as { zoom: number }).zoom = saved.zoom
      camera.updateProjectionMatrix()
    }
    if (saved.target) {
      ctrlRef.current?.target.copy(saved.target)
      ctrlRef.current?.update()
    }
  })

  // camera is intentionally omitted from deps — R3F can expose a new
  // reference on scene changes (sketch edit entry, etc.) and including it
  // would reset the camera that should only happen via resetTrigger.
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; console.log('[CAMERA-DEBUG] SceneController: first mount, skipping reset'); return }
    console.log('[CAMERA-DEBUG] SceneController: resetTrigger fired, resetting camera to INITIAL_POSITION. resetTrigger=', resetTrigger)
    camera.position.set(...INITIAL_POSITION)
    if ('zoom' in camera) {
      (camera as { zoom: number; updateProjectionMatrix: () => void }).zoom = INITIAL_ZOOM
      camera.updateProjectionMatrix()
    }
    ctrlRef.current?.target.set(0, 0, 0)
    ctrlRef.current?.update()
    pendingRestore.current = null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetTrigger])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 2 || !ctrlRef.current) return
      ctrlRef.current.mouseButtons.RIGHT = rightButtonMapping(e)
    }
    canvas.addEventListener('pointerdown', onPointerDown, { capture: true })
    return () => canvas.removeEventListener('pointerdown', onPointerDown, { capture: true })
  }, [canvasRef])

  useFrame(() => {
    if (snapRef.current) {
      const dir = snapRef.current.clone().normalize()
      const dist = camera.position.length()
      camera.position.copy(dir.multiplyScalar(dist))
      ctrlRef.current?.target.set(0, 0, 0)
      ctrlRef.current?.update()
      snapRef.current = null
    }

    if (canvasRef.current)
      pvRef.current = drawCubeGizmo(canvasRef.current, camera, hoverRef.current)
  })

  const orbitEnabled = useSketchEditorStore(s => s.orbitEnabled)
  const setIsRotating = useSketchEditorStore(s => s.setIsRotating)

  return (
    <OrbitControls
      ref={(ctrl) => {
        ctrlRef.current = ctrl
        controlsRef.current = ctrl
      }}
      enabled={orbitEnabled}
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
