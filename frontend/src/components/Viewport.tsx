import { useEffect, useRef } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { OrthographicCamera, OrbitControls } from '@react-three/drei'
import type { Sketch, Constraints } from './SketchSvg'
import Sketch3D from './Sketch3D'

const INITIAL_POSITION: [number, number, number] = [0, 0, 5]
const INITIAL_ZOOM = 200

interface SketchData {
  initial: Sketch
  solved: Sketch
  constraints?: Constraints
}

interface ViewportProps {
  sketch?: SketchData | null
  resetTrigger?: number
}

function CameraController({ resetTrigger }: { resetTrigger: number }) {
  const { camera } = useThree()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const controlsRef = useRef<any>(null)
  const mounted = useRef(false)

  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return }
    camera.position.set(...INITIAL_POSITION)
    // OrthographicCamera has zoom
    if ('zoom' in camera) {
      (camera as { zoom: number; updateProjectionMatrix: () => void }).zoom = INITIAL_ZOOM
      camera.updateProjectionMatrix()
    }
    if (controlsRef.current) {
      controlsRef.current.target.set(0, 0, 0)
      controlsRef.current.update()
    }
  }, [resetTrigger]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <OrbitControls
      ref={controlsRef}
      enableRotate={true}
      enableZoom={true}
      enablePan={true}
      enableDamping={false}
    />
  )
}

export default function Viewport({ sketch, resetTrigger = 0 }: ViewportProps) {
  return (
    <Canvas
      style={{ width: '100%', height: '100%', background: '#111' }}
      gl={{ antialias: true }}
    >
      <OrthographicCamera makeDefault position={INITIAL_POSITION} zoom={INITIAL_ZOOM} />
      <CameraController resetTrigger={resetTrigger} />

      <ambientLight intensity={0.8} />
      <directionalLight position={[2, 2, 3]} intensity={0.6} />

      {/* Origin plane at 5% opacity */}
      <mesh position={[0, 0, 0]}>
        <planeGeometry args={[1, 1]} />
        <meshStandardMaterial color={0x4fc3f7} side={2} transparent opacity={0.05} />
      </mesh>

      {sketch && (
        <Sketch3D initial={sketch.initial} solved={sketch.solved} constraints={sketch.constraints} />
      )}
    </Canvas>
  )
}
