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
  const restoreMounted = useRef(false)
  const resetMounted = useRef(false)

  // Track the previous camera identity and its state so we can restore
  // after R3F replaces the camera or resets its position/zoom during
  // reconciliation (e.g. on scene changes like entering sketch edit).
  const prevCamRef = useRef<THREE.Camera | null>(null)
  const justSwapped = useRef(false)
  const prevCamState = useRef<{ pos: THREE.Vector3; zoom: number; target: THREE.Vector3 }>({
    pos: new THREE.Vector3(),
    zoom: INITIAL_ZOOM,
    target: new THREE.Vector3(),
  })

  // Detect camera swaps and save the previous camera's state before the
  // new one's position is committed (R3F may have already reset it).
  if (prevCamRef.current !== camera) {
    if (prevCamRef.current) {
      const prev = prevCamRef.current
      prevCamState.current.pos.copy(prev.position)
      prevCamState.current.zoom = ('zoom' in prev) ? (prev as unknown as { zoom: number }).zoom : INITIAL_ZOOM
      if (ctrlRef.current?.target) prevCamState.current.target.copy(ctrlRef.current.target)
      justSwapped.current = true
      console.log('[CAMERA-DEBUG] SceneController: camera ref changed, saved old pos=', prevCamState.current.pos.toArray(), 'zoom=', prevCamState.current.zoom)
    }
    prevCamRef.current = camera
  }

  // Persist camera state during render (before R3F commit) so any
  // position/zoom reset done by R3F during commit can be detected.
  const savedPos = useRef(new THREE.Vector3())
  const savedZoom = useRef(INITIAL_ZOOM)
  const savedTarget = useRef(new THREE.Vector3())
  savedPos.current.copy(camera.position)
  if ('zoom' in camera) {
    savedZoom.current = (camera as unknown as { zoom: number }).zoom
  }
  if (ctrlRef.current?.target) {
    savedTarget.current.copy(ctrlRef.current.target)
  }

  cameraRef.current = camera

  // After every render, check whether the camera state was changed
  // unexpectedly during R3F's commit phase and restore if needed.
  useLayoutEffect(() => {
    if (!restoreMounted.current) { restoreMounted.current = true; return }
    const swapped = justSwapped.current
    justSwapped.current = false
    const posReset = camera.position.distanceToSquared(savedPos.current) > 0.01
    const zoomReset = Math.abs(('zoom' in camera ? (camera as unknown as { zoom: number }).zoom : INITIAL_ZOOM) - savedZoom.current) > 0.01
    if (swapped || posReset || zoomReset) {
      console.log('[CAMERA-DEBUG] SceneController: restoring camera! swapped=', swapped, 'posReset=', posReset, 'zoomReset=', zoomReset, 'to pos=', prevCamState.current.pos.toArray(), 'zoom=', prevCamState.current.zoom)
      camera.position.copy(prevCamState.current.pos)
      if ('zoom' in camera) {
        (camera as unknown as { zoom: number }).zoom = prevCamState.current.zoom
        camera.updateProjectionMatrix()
      }
      if (ctrlRef.current?.target) {
        ctrlRef.current.target.copy(prevCamState.current.target)
        ctrlRef.current.update()
      }
    }
  })

  // camera is intentionally omitted from deps — R3F can expose a new
  // reference on scene changes (sketch edit entry, etc.) and including it
  // would reset the camera that should only happen via resetTrigger.
  useEffect(() => {
    if (!resetMounted.current) { resetMounted.current = true; console.log('[CAMERA-DEBUG] SceneController: first mount, skipping reset'); return }
    console.log('[CAMERA-DEBUG] SceneController: resetTrigger fired, resetting camera to INITIAL_POSITION. resetTrigger=', resetTrigger)
    camera.position.set(...INITIAL_POSITION)
    if ('zoom' in camera) {
      (camera as { zoom: number; updateProjectionMatrix: () => void }).zoom = INITIAL_ZOOM
      camera.updateProjectionMatrix()
    }
    ctrlRef.current?.target.set(0, 0, 0)
    ctrlRef.current?.update()
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
