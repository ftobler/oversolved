import { useEffect, useRef } from 'react'
import { Canvas, useThree, useFrame } from '@react-three/fiber'
import { OrthographicCamera, OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import type { Sketch, Constraints } from './SketchSvg'
import Sketch3D from './Sketch3D'

const INITIAL_POSITION: [number, number, number] = [0, 0, 5]
const INITIAL_ZOOM = 200

// Gizmo position — change bottom/right/top/left to reposition
const GIZMO_STYLE: React.CSSProperties = {
  position: 'absolute',
  bottom: 12,
  right: 12,
  pointerEvents: 'none',
  borderRadius: '50%',
}
const GIZMO_SIZE = 110

interface SketchData {
  initial: Sketch
  solved: Sketch
  constraints?: Constraints
}

interface ViewportProps {
  sketch?: SketchData | null
  resetTrigger?: number
}

// ---------------------------------------------------------------------------
// Orientation gizmo (canvas-based, drawn via useFrame)
// ---------------------------------------------------------------------------

const GIZMO_AXES = [
  { label: 'Right',  dir: new THREE.Vector3( 1,  0,  0), color: '#c0392b' },
  { label: 'Left',   dir: new THREE.Vector3(-1,  0,  0), color: '#7b241c' },
  { label: 'Top',    dir: new THREE.Vector3( 0,  1,  0), color: '#1e8449' },
  { label: 'Bottom', dir: new THREE.Vector3( 0, -1,  0), color: '#145a32' },
  { label: 'Front',  dir: new THREE.Vector3( 0,  0,  1), color: '#1a5276' },
  { label: 'Back',   dir: new THREE.Vector3( 0,  0, -1), color: '#2980b9' },
]

function drawGizmo(canvas: HTMLCanvasElement, camera: THREE.Camera) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const W = canvas.width, H = canvas.height
  const cx = W / 2, cy = H / 2
  const armLen = W * 0.34
  const dotR = W * 0.13

  ctx.clearRect(0, 0, W, H)

  // Background circle
  ctx.beginPath()
  ctx.arc(cx, cy, W / 2 - 1, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(10,10,10,0.55)'
  ctx.fill()

  // Project axes through camera quaternion
  const invQuat = camera.quaternion.clone().invert()
  const pts = GIZMO_AXES.map(axis => {
    const v = axis.dir.clone().applyQuaternion(invQuat)
    return { ...axis, x: cx + v.x * armLen, y: cy - v.y * armLen, depth: v.z }
  })
  pts.sort((a, b) => a.depth - b.depth)

  // Lines
  for (const p of pts) {
    const alpha = p.depth < 0 ? 0.18 : 0.55
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(p.x, p.y)
    ctx.strokeStyle = p.color
    ctx.globalAlpha = alpha
    ctx.lineWidth = 1.5
    ctx.stroke()
  }
  ctx.globalAlpha = 1

  // Dots + labels
  for (const p of pts) {
    const front = p.depth >= -0.1
    const alpha = front ? 1 : 0.3
    const r = front ? dotR : dotR * 0.6

    ctx.globalAlpha = alpha
    ctx.beginPath()
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
    ctx.fillStyle = p.color
    ctx.fill()

    if (front) {
      ctx.globalAlpha = 1
      ctx.font = `bold ${Math.round(W * 0.085)}px Arial, sans-serif`
      ctx.fillStyle = '#ffffff'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(p.label, p.x, p.y)
    }
  }
  ctx.globalAlpha = 1
}

function GizmoSync({ canvasRef }: { canvasRef: React.RefObject<HTMLCanvasElement | null> }) {
  const { camera } = useThree()
  useFrame(() => {
    if (canvasRef.current) drawGizmo(canvasRef.current, camera)
  })
  return null
}

// ---------------------------------------------------------------------------
// Camera controller
// ---------------------------------------------------------------------------

function CameraController({ resetTrigger }: { resetTrigger: number }) {
  const { camera } = useThree()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const controlsRef = useRef<any>(null)
  const mounted = useRef(false)

  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return }
    camera.position.set(...INITIAL_POSITION)
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
    <OrbitControls ref={controlsRef} enableRotate enableZoom enablePan enableDamping={false} />
  )
}

// ---------------------------------------------------------------------------
// Viewport
// ---------------------------------------------------------------------------

export default function Viewport({ sketch, resetTrigger = 0 }: ViewportProps) {
  const gizmoRef = useRef<HTMLCanvasElement>(null)

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <Canvas
        style={{ width: '100%', height: '100%', background: '#111' }}
        gl={{ antialias: true }}
      >
        <OrthographicCamera makeDefault position={INITIAL_POSITION} zoom={INITIAL_ZOOM} />
        <CameraController resetTrigger={resetTrigger} />

        <ambientLight intensity={0.8} />
        <directionalLight position={[2, 2, 3]} intensity={0.6} />

        <mesh position={[0, 0, 0]}>
          <planeGeometry args={[1, 1]} />
          <meshStandardMaterial color={0x4fc3f7} side={2} transparent opacity={0.05} />
        </mesh>

        {sketch && (
          <Sketch3D initial={sketch.initial} solved={sketch.solved} constraints={sketch.constraints} />
        )}

        <GizmoSync canvasRef={gizmoRef} />
      </Canvas>

      <canvas
        ref={gizmoRef}
        width={GIZMO_SIZE}
        height={GIZMO_SIZE}
        style={GIZMO_STYLE}
      />
    </div>
  )
}
