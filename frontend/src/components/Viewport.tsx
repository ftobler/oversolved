import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useThree, useFrame } from '@react-three/fiber'
import { OrthographicCamera, OrbitControls, Line, Text } from '@react-three/drei'
import * as THREE from 'three'
import type { Sketch, Constraints, Topology } from './SketchSvg'
import Geometry3D from './Geometry3D'
import { CubeGizmoCanvas } from './CubeGizmo'
import { drawCubeGizmo, type Pv, type Hit } from './CubeGizmo.utils'
import { useSketchEditorStore } from '../stores/sketchEditorStore'

const INITIAL_POSITION: [number, number, number] = [0, 0, 100]  // camera initial position
const INITIAL_ZOOM = 200

// CAD-style mouse button mapping:
//   LEFT  = disabled (selection only via R3F raycasting, not viewport rotation)
//   MIDDLE = PAN
//   RIGHT  = ROTATE
// Ctrl+right is swapped to PAN dynamically in SceneController.
const MOUSE_BUTTONS = {
  LEFT: -1 as unknown as THREE.MOUSE,
  MIDDLE: THREE.MOUSE.PAN,
  RIGHT: THREE.MOUSE.ROTATE,
}

// ── Origin marker ─────────────────────────────────────────────────────────────

const AXIS_LEN = 0.35

function OriginDot() {
  const meshRef = useRef<THREE.Mesh>(null)
  const { camera } = useThree()
  useFrame(() => {
    if (meshRef.current) {
      const s = 4 * (1 / (('zoom' in camera) ? (camera as THREE.OrthographicCamera).zoom : 1))
      meshRef.current.scale.setScalar(s)
    }
  })
  return (
    <mesh ref={meshRef}>
      <sphereGeometry args={[1, 8, 8]} />
      <meshBasicMaterial color="#ffffff" />
    </mesh>
  )
}

function OriginMarker() {
  return (
    <group>
      <Line points={[[0,0,0],[AXIS_LEN,0,0]]} color="#e53935" lineWidth={2} />
      <Line points={[[0,0,0],[0,AXIS_LEN,0]]} color="#43a047" lineWidth={2} />
      <Line points={[[0,0,0],[0,0,AXIS_LEN]]} color="#1e88e5" lineWidth={2} />
      <OriginDot />
    </group>
  )
}

// ── Reference planes ──────────────────────────────────────────────────────────

const PLANE_SIZE = 1
const PH = PLANE_SIZE / 2
const PLANE_BORDER: [number,number,number][] = [[-PH,-PH,0],[PH,-PH,0],[PH,PH,0],[-PH,PH,0],[-PH,-PH,0]]

function PlaneLabel({ x, y, children }: { x: number; y: number; children: string }) {
  const groupRef = useRef<THREE.Group>(null)
  const { camera } = useThree()
  useFrame(() => {
    if (groupRef.current) {
      const s = 12 / (('zoom' in camera) ? (camera as THREE.OrthographicCamera).zoom : 1)
      groupRef.current.scale.setScalar(s)
    }
  })
  return (
    <group ref={groupRef} position={[x + 0.03, y - 0.02, 0.001]}>
      <Text fontSize={3} color="#888888" fillOpacity={0.20} anchorX="left" anchorY="top">
        {children}
      </Text>
    </group>
  )
}

function ReferencePlane({ rotation, label }: { rotation: [number,number,number]; label: string }) {
  return (
    <group rotation={rotation}>
      <mesh>
        <planeGeometry args={[PLANE_SIZE,PLANE_SIZE]} />
        <meshBasicMaterial color="#888888" transparent opacity={0.05} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <Line points={PLANE_BORDER} color="#666666" lineWidth={1} />
      <PlaneLabel x={-PH} y={PH}>{label}</PlaneLabel>
    </group>
  )
}

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
      (camera as { zoom: number; updateProjectionMatrix: () => void }).zoom = INITIAL_ZOOM // eslint-disable-line react-hooks/immutability
      camera.updateProjectionMatrix()
    }
    ctrlRef.current?.target.set(0, 0, 0)
    ctrlRef.current?.update()
  }, [resetTrigger]) // eslint-disable-line react-hooks/exhaustive-deps

  // Ctrl+right = pan: hold Ctrl to swap right mouse from ROTATE → PAN
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.key === 'Control' || e.key === 'Meta') && ctrlRef.current) {
        ctrlRef.current.mouseButtons.RIGHT = THREE.MOUSE.PAN
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if ((e.key === 'Control' || e.key === 'Meta') && ctrlRef.current) {
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

// ── Public types ──────────────────────────────────────────────────────────────

export interface Feature {
  id: string
  kind?: string
}

// Solve result for one feature — contains only data produced by the solver.
// The initial (pre-solve) geometry lives in PartDoc.features[x].initial and
// is never echoed back by the server. Do NOT add an 'initial' field here.
export interface SketchData {
  solved: Sketch
  constraints?: Constraints
  topology?: Topology
}

interface ViewportProps {
  features?: Feature[]
  rollbackPosition?: number
  visibleFeatures?: Set<string>
  solveResults?: Record<string, SketchData>
  resetTrigger?: number
  activeFeatureId?: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isActive(
  id: string,
  features: Feature[] | undefined,
  rollbackPos: number | undefined,
  visible: Set<string> | undefined,
): boolean {
  if (!features || features.length === 0) return true
  const idx = features.findIndex(f => f.id === id)
  if (idx < 0) return false
  return (rollbackPos === undefined || idx < rollbackPos) && (!visible || visible.has(id))
}

// ── Viewport ──────────────────────────────────────────────────────────────────

export default function Viewport({
  features,
  rollbackPosition,
  visibleFeatures,
  solveResults,
  resetTrigger = 0,
  activeFeatureId,
}: ViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pvRef = useRef<Pv[]>([])
  const hoverRef = useRef<Hit | null>(null)
  const snapRef = useRef<THREE.Vector3 | null>(null)
  const cameraRef = useRef<THREE.Camera | null>(null)

  const [ready, setReady] = useState(false)
  const onCreated = useCallback(() => {
    // Allow one frame for the camera/scene to settle, then reveal
    requestAnimationFrame(() => setReady(true))
  }, [])

  // Detect click-vs-drag for middle and right buttons.
  // Less than 4px movement = click → show alert placeholder.
  const pointerDownPos = useRef<[number, number] | null>(null)
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button === 1 || e.button === 2) pointerDownPos.current = [e.clientX, e.clientY]
  }, [])
  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (!pointerDownPos.current) return
    const dx = e.clientX - pointerDownPos.current[0]
    const dy = e.clientY - pointerDownPos.current[1]
    pointerDownPos.current = null
    if (Math.hypot(dx, dy) >= 4) return
    if (e.button === 1) window.alert('middle mouse click')
    if (e.button === 2) window.alert('right mouse click')
  }, [])

  const showOrigin = isActive('Origin', features, rollbackPosition, visibleFeatures)
  const showFront  = isActive('Front',  features, rollbackPosition, visibleFeatures)
  const showTop    = isActive('Top',    features, rollbackPosition, visibleFeatures)
  const showRight  = isActive('Right',  features, rollbackPosition, visibleFeatures)

  const activeSketchFeatures = useMemo(() => {
    if (!features || !solveResults) return []
    const limit = rollbackPosition ?? features.length
    return features
      .slice(0, limit)
      .filter(f => f.kind === 'sketch' && (!visibleFeatures || visibleFeatures.has(f.id)) && solveResults[f.id])
  }, [features, rollbackPosition, visibleFeatures, solveResults])

  return (
    <div
      style={{ position: 'relative', width: '100%', height: '100%' }}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onContextMenu={e => e.preventDefault()}
    >
      <Canvas
        style={{ width: '100%', height: '100%', background: '#111' }}
        gl={{ antialias: true }}
        onCreated={onCreated}
        onPointerMissed={() => useSketchEditorStore.getState().clearSelection()}
      >
        <OrthographicCamera makeDefault position={INITIAL_POSITION} zoom={INITIAL_ZOOM} near={-1000000} far={1000000} />
        <SceneController
          resetTrigger={resetTrigger}
          canvasRef={canvasRef}
          pvRef={pvRef}
          hoverRef={hoverRef}
          snapRef={snapRef}
          cameraRef={cameraRef}
        />

        <ambientLight intensity={0.8} />
        <directionalLight position={[2,2,3]} intensity={0.6} />

        {/* World: origin axes and reference planes */}
        {showOrigin && <OriginMarker />}
        {showFront  && <ReferencePlane rotation={[0,0,0]}          label="Front" />}
        {showTop    && <ReferencePlane rotation={[-Math.PI/2,0,0]} label="Top"   />}
        {showRight  && <ReferencePlane rotation={[0,Math.PI/2,0]}  label="Right" />}

        {/* Features */}
        {activeSketchFeatures.map(f => (
          <Geometry3D key={f.id}
            featureId={f.id}
            solved={solveResults![f.id].solved}
            constraints={solveResults![f.id].constraints}
            topology={solveResults![f.id].topology}
            activeFeatureId={activeFeatureId}
          />))}
      </Canvas>

      {!ready && (
        <div style={{
          position: 'absolute', inset: 0,
          background: '#111',
          zIndex: 1,
        }} />
      )}

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
