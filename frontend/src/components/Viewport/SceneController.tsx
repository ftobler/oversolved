import { useEffect, useRef } from 'react'
import { OrbitControls } from '@react-three/drei'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { drawCubeGizmo, type Pv, type Hit } from '@/components/misc/CubeGizmo.utils'
import { resetView, snapToDirection } from '@/components/Viewport/cameraController'

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

  cameraRef.current = camera

  // The single orthographic camera is created and initially positioned by the
  // <Canvas orthographic camera={...}> in Viewport. R3F never swaps or
  // repositions it on re-render. The ONLY automatic camera move here is an
  // explicit Reset Viewport click (resetTrigger changing to a new value);
  // everything else is user controlled. Comparing against the last acted-on
  // value (not a "mounted" boolean) keeps StrictMode's setup/cleanup/setup
  // double invocation from firing a spurious reset.
  useEffect(() => {
    if (resetTrigger === lastReset.current) return
    lastReset.current = resetTrigger
    resetView(camera, ctrlRef.current, 'resetTrigger')
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
      snapToDirection(camera, ctrlRef.current, snapRef.current)
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
