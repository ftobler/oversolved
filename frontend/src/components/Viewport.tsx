import { Canvas } from '@react-three/fiber'
import { OrthographicCamera, OrbitControls } from '@react-three/drei'

export default function Viewport() {
  return (
    <Canvas
      style={{ width: '100%', height: '100%', background: '#111' }}
      gl={{ antialias: true }}
    >
      <OrthographicCamera
        makeDefault
        position={[0, 0, 5]}
        zoom={200}
      />
      <OrbitControls enableRotate={true} enableZoom={true} enablePan={true} />

      <ambientLight intensity={0.8} />
      <directionalLight position={[2, 2, 3]} intensity={0.6} />

      {/* 1x1 Rectangle centered at origin */}
      <mesh position={[0, 0, 0]}>
        <planeGeometry args={[1, 1]} />
        <meshStandardMaterial color={0x4fc3f7} side={2} />
      </mesh>
    </Canvas>
  )
}
