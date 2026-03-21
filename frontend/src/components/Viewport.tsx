import { useEffect, useRef } from 'react'
import { Canvas, useThree, useFrame } from '@react-three/fiber'
import { OrthographicCamera, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import type { Sketch, Constraints } from './SketchSvg'
import Sketch3D from './Sketch3D'
import { CubeGizmoCanvas, drawCubeGizmo } from './CubeGizmo'
import type { Pv, Hit } from './CubeGizmo'

const INITIAL_POSITION: [number, number, number] = [0, 0, 5]
const INITIAL_ZOOM = 200

// ── SceneController ───────────────────────────────────────────────────────────

interface SceneControllerProps {
  resetTrigger: number
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  pvRef: React.MutableRefObject<Pv[]>
  hoverRef: React.MutableRefObject<Hit | null>
  snapRef: React.MutableRefObject<THREE.Vector3 | null>
  cameraRef: React.MutableRefObject<THREE.Camera | null>
}

function SceneController({ resetTrigger, canvasRef, pvRef, hoverRef, snapRef, cameraRef }: SceneControllerProps) {
  const { camera } = useThree()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctrlRef = useRef<any>(null)
  const mounted = useRef(false)

  cameraRef.current = camera

  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return }
    camera.position.set(...INITIAL_POSITION)
    if ('zoom' in camera) {
      (camera as { zoom: number; updateProjectionMatrix: () => void }).zoom = INITIAL_ZOOM
      camera.updateProjectionMatrix()
    }
    ctrlRef.current?.target.set(0, 0, 0)
    ctrlRef.current?.update()
  }, [resetTrigger]) // eslint-disable-line react-hooks/exhaustive-deps

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

  return <OrbitControls ref={ctrlRef} enableRotate enableZoom enablePan enableDamping={false} />
}

// ── ViewportProps ─────────────────────────────────────────────────────────────

interface SketchData {
  initial: Sketch
  solved: Sketch
  constraints?: Constraints
}

interface ViewportProps {
  sketch?: SketchData | null
  resetTrigger?: number
}

// ── Viewport ──────────────────────────────────────────────────────────────────

export default function Viewport({ sketch, resetTrigger = 0 }: ViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pvRef = useRef<Pv[]>([])
  const hoverRef = useRef<Hit | null>(null)
  const snapRef = useRef<THREE.Vector3 | null>(null)
  const cameraRef = useRef<THREE.Camera | null>(null)

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <Canvas
        style={{ width: '100%', height: '100%', background: '#111' }}
        gl={{ antialias: true }}
      >
        <OrthographicCamera makeDefault position={INITIAL_POSITION} zoom={INITIAL_ZOOM} />
        <SceneController
          resetTrigger={resetTrigger}
          canvasRef={canvasRef}
          pvRef={pvRef}
          hoverRef={hoverRef}
          snapRef={snapRef}
          cameraRef={cameraRef}
        />

        <ambientLight intensity={0.8} />
        <directionalLight position={[2, 2, 3]} intensity={0.6} />

        <mesh position={[0, 0, 0]}>
          <planeGeometry args={[1, 1]} />
          <meshStandardMaterial color={0x4fc3f7} side={2} transparent opacity={0.05} />
        </mesh>

        {sketch && (
          <Sketch3D initial={sketch.initial} solved={sketch.solved} constraints={sketch.constraints} />
        )}
      </Canvas>

      <CubeGizmoCanvas
        canvasRef={canvasRef}
        pvRef={pvRef}
        hoverRef={hoverRef}
        snapRef={snapRef}
        cameraRef={cameraRef}
      />
    </div>
  )
}
