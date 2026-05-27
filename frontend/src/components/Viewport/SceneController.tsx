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
  const lastReset = useRef(resetTrigger)
  const prevCamera = useRef<THREE.Camera | null>(null)

  cameraRef.current = camera

  function applyInitialView() {
    console.log('[CAMERA-DEBUG] SceneController: applyInitialView -> INITIAL_POSITION')
    camera.position.set(...INITIAL_POSITION)
    if ('zoom' in camera) {
      (camera as { zoom: number; updateProjectionMatrix: () => void }).zoom = INITIAL_ZOOM
      camera.updateProjectionMatrix()
    }
    ctrlRef.current?.target.set(0, 0, 0)
    ctrlRef.current?.update()
  }

  // The camera carries no declarative position/zoom props, so R3F never snaps
  // it back to the initial pose on re-render. The ONLY automatic camera setup
  // is the very first instance, placed at the initial view. R3F swaps the
  // camera instance on scene changes (e.g. sketch edit entry); on such a swap
  // we copy the user's current pose onto the new instance so the view stays
  // put rather than jumping. Everything else is user controlled.
  useLayoutEffect(() => {
    const prev = prevCamera.current
    prevCamera.current = camera
    if (!prev) {
      console.log('[CAMERA-DEBUG] SceneController: first camera instance, initializing')
      applyInitialView()
      return
    }
    if (prev === camera) { console.log('[CAMERA-DEBUG] SceneController: camera effect ran, SAME instance (no-op)'); return }
    console.log('[CAMERA-DEBUG] SceneController: camera INSTANCE SWAP, preserving pose from', prev.position.toArray(), 'zoom', ('zoom' in prev) ? (prev as unknown as { zoom: number }).zoom : 'n/a')
    camera.position.copy(prev.position)
    camera.quaternion.copy(prev.quaternion)
    if ('zoom' in camera && 'zoom' in prev) {
      (camera as unknown as { zoom: number }).zoom = (prev as unknown as { zoom: number }).zoom
      camera.updateProjectionMatrix()
    }
    ctrlRef.current?.update()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera])

  // Only reset when resetTrigger changes to a genuinely new value (the user
  // clicked Reset Viewport). Comparing against the last acted-on value, rather
  // than a "mounted" boolean, keeps StrictMode's setup/cleanup/setup double
  // invocation from firing a spurious reset to the initial pose on load/edit.
  useEffect(() => {
    if (resetTrigger === lastReset.current) return
    lastReset.current = resetTrigger
    console.log('[CAMERA-DEBUG] SceneController: resetTrigger changed ->', resetTrigger)
    applyInitialView()
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
