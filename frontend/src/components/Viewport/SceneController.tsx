import { useEffect, useRef } from 'react'
import { OrbitControls } from '@react-three/drei'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import { drawCubeGizmo, type Pv, type Hit } from '../CubeGizmo.utils'

const INITIAL_POSITION: [number, number, number] = [0, 0, 100]
const INITIAL_ZOOM = 200

const MOUSE_BUTTONS = {
  LEFT: -1 as unknown as THREE.MOUSE,
  MIDDLE: THREE.MOUSE.PAN,
  RIGHT: THREE.MOUSE.ROTATE,
}

interface SceneControllerProps {
  resetTrigger: number
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  pvRef: React.MutableRefObject<Pv[]>
  hoverRef: React.MutableRefObject<Hit | null>
  snapRef: React.MutableRefObject<THREE.Vector3 | null>
  cameraRef: React.MutableRefObject<THREE.Camera | null>
}

export default function SceneController({ resetTrigger, canvasRef, pvRef, hoverRef, snapRef, cameraRef }: SceneControllerProps) {
  const { camera } = useThree()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctrlRef = useRef<any>(null)
  const mounted = useRef(false)

  cameraRef.current = camera

  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return }
    camera.position.set(...INITIAL_POSITION)
    if ('zoom' in camera) {
      // eslint-disable-next-line react-hooks/immutability
      (camera as { zoom: number; updateProjectionMatrix: () => void }).zoom = INITIAL_ZOOM
      camera.updateProjectionMatrix()
    }
    ctrlRef.current?.target.set(0, 0, 0)
    ctrlRef.current?.update()
  }, [resetTrigger, camera])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!ctrlRef.current) return
      if (e.key === 'Control' || e.key === 'Meta') {
        ctrlRef.current.mouseButtons.RIGHT = THREE.MOUSE.PAN
      } else if (e.key === 'Shift') {
        ctrlRef.current.mouseButtons.RIGHT = THREE.MOUSE.DOLLY
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (!ctrlRef.current) return
      if (e.key === 'Control' || e.key === 'Meta' || e.key === 'Shift') {
        ctrlRef.current.mouseButtons.RIGHT = THREE.MOUSE.ROTATE
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp) }
  }, [])

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

  return (
    <OrbitControls
      ref={ctrlRef}
      enabled={orbitEnabled}
      mouseButtons={MOUSE_BUTTONS}
      enableRotate
      enableZoom
      enablePan
      enableDamping={false}
    />
  )
}
