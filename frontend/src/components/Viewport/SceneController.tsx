import { useEffect, useRef } from 'react'
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

// TEMP DEBUG (camera freeze) module-scoped counters.
const orbitDbg = { moves: 0, changes: 0, instanceId: 0, gestureInstance: 0, lastInstance: null as unknown }

interface SceneControllerProps {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  pvRef: React.MutableRefObject<Pv[]>
  hoverRef: React.MutableRefObject<Hit | null>
  snapRef: React.MutableRefObject<THREE.Vector3 | null>
  cameraRef: React.MutableRefObject<THREE.Camera | null>
  controlsRef: React.MutableRefObject<OrbitControlsImpl | null>
}

export default function SceneController({ canvasRef, pvRef, hoverRef, snapRef, cameraRef, controlsRef }: SceneControllerProps) {
  const { camera, gl } = useThree()
  const ctrlRef = useRef<OrbitControlsImpl | null>(null)

  // TEMP DEBUG (camera freeze): is the camera object being swapped, and does
  // SceneController remount? Both would force drei to recreate OrbitControls.
  useEffect(() => {
    console.log('[orbit-debug] SceneController MOUNT', { cameraUuid: camera.uuid })
    return () => console.log('[orbit-debug] SceneController UNMOUNT')
  }, [])
  useEffect(() => {
    console.log('[orbit-debug] camera changed', { cameraUuid: camera.uuid })
  }, [camera])

  // Expose the Canvas-owned camera to the parent Viewport (for fitToContent).
  // eslint-disable-next-line react-hooks/refs
  cameraRef.current = camera

  // The single orthographic camera is created and initially positioned by the
  // <Canvas orthographic camera={...}> in Viewport. R3F never swaps or
  // repositions it on re-render, and SceneController never moves it on its own.
  // Programmatic framing (startup fit and the Reset Viewport button) goes
  // through Viewport's autoZoomToFit -> fitToContent; everything else here is
  // user controlled via OrbitControls.
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

  const drag = useSketchEditorStore(s => s.drag)
  const dragPending = useSketchEditorStore(s => s.dragPending)
  const isPointerDown = useSketchEditorStore(s => s.isPointerDown)
  const orbitEnabled = deriveOrbitEnabled(isPointerDown, drag, dragPending)
  const setIsRotating = useSketchEditorStore(s => s.setIsRotating)

  // TEMP DEBUG (camera freeze): per-gesture move counters + instance identity.
  useEffect(() => {
    const canvas = gl.domElement  // the WebGL canvas OrbitControls binds to
    if (!canvas) return
    const onDown = (e: PointerEvent) => {
      orbitDbg.moves = 0
      orbitDbg.gestureInstance = orbitDbg.instanceId
      console.log('[orbit-debug] pointerdown', {
        button: e.button,
        enabled: ctrlRef.current?.enabled,
        instanceId: orbitDbg.instanceId,
        domEl: ctrlRef.current?.domElement?.tagName,
      })
    }
    const onMove = () => { orbitDbg.moves++ }
    const onUp = () => {
      console.log('[orbit-debug] pointerup', {
        rawMovesOnCanvas: orbitDbg.moves,
        instanceAtStart: orbitDbg.gestureInstance,
        instanceNow: orbitDbg.instanceId,
        replacedMidGesture: orbitDbg.gestureInstance !== orbitDbg.instanceId,
      })
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [gl])

  return (
    <OrbitControls
      ref={(ctrl) => {
        ctrlRef.current = ctrl
        controlsRef.current = ctrl
        // TEMP DEBUG: only count a genuinely NEW controls object (ignore the
        // null/instance churn from this inline callback re-running each render).
        if (ctrl && ctrl !== orbitDbg.lastInstance) {
          orbitDbg.lastInstance = ctrl
          orbitDbg.instanceId++
          console.log('[orbit-debug] NEW controls instance', orbitDbg.instanceId)
        }
      }}
      enabled={orbitEnabled}
      mouseButtons={MOUSE_BUTTONS}
      enableRotate
      enableZoom
      enablePan
      enableDamping={false}
      onStart={() => { console.log('[orbit-debug] onStart'); setIsRotating(true) }}
      onChange={() => { orbitDbg.changes++ }}
      onEnd={() => { console.log('[orbit-debug] onEnd', { onChangeCount: orbitDbg.changes }); orbitDbg.changes = 0; setIsRotating(false) }}
    />
  )
}
