import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useThree, useFrame } from '@react-three/fiber'
import { OrthographicCamera, OrbitControls, Line, Text } from '@react-three/drei'
import * as THREE from 'three'
import type { Sketch, Constraints, Topology } from './SketchSvg'
import { unflattenGeometry } from './SketchSvg'
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

// ── Constraint rendering ─────────────────────────────────────────────────────

function geomPoint(sketch: Sketch, ref: { entity: string; point?: string }): [number, number] | null {
  const e = sketch[ref.entity]
  if (!e) return null
  const pt = ref.point || 'start'

  if ('start' in e && 'end' in e && 'radius' in e) {
    // arc
    const arc = e as any
    return pt !== 'end' ? arc.start : arc.end
  } else if ('start' in e && 'end' in e) {
    // line_segment
    const line = e as any
    return pt === 'end' ? line.end : line.start
  } else if ('center' in e) {
    // circle
    return (e as any).center
  } else if ('x' in e) {
    // point
    const p = e as any
    return [p.x, p.y]
  }
  return null
}

function computeConstraintRender(constraint: any, sketch: Sketch): any {
  const kind = constraint.kind

  if (kind === 'horizontal') {
    if (constraint.a && constraint.b) {
      const pa = geomPoint(sketch, constraint.a)
      const pb = geomPoint(sketch, constraint.b)
      if (!pa || !pb) return { kind: 'unknown' }
      const at: [number, number] = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2]
      return { kind: 'symbol_h', at, entity: constraint.a.entity, entities: [constraint.a.entity, constraint.b.entity] }
    }
    const eid = constraint.target?.entity
    if (!eid) return { kind: 'unknown' }
    const e = sketch[eid] as any
    if (!e || !e.start || !e.end) return { kind: 'unknown' }
    const at: [number, number] = [(e.start[0] + e.end[0]) / 2, (e.start[1] + e.end[1]) / 2]
    return { kind: 'symbol_h', at, entity: eid }
  }

  if (kind === 'vertical') {
    if (constraint.a && constraint.b) {
      const pa = geomPoint(sketch, constraint.a)
      const pb = geomPoint(sketch, constraint.b)
      if (!pa || !pb) return { kind: 'unknown' }
      const at: [number, number] = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2]
      return { kind: 'symbol_v', at, entity: constraint.a.entity, entities: [constraint.a.entity, constraint.b.entity] }
    }
    const eid = constraint.target?.entity
    if (!eid) return { kind: 'unknown' }
    const e = sketch[eid] as any
    if (!e || !e.start || !e.end) return { kind: 'unknown' }
    const at: [number, number] = [(e.start[0] + e.end[0]) / 2, (e.start[1] + e.end[1]) / 2]
    return { kind: 'symbol_v', at, entity: eid }
  }

  if (kind === 'length') {
    const eid = constraint.target?.entity
    if (!eid) return { kind: 'unknown' }
    const e = sketch[eid] as any
    if (!e || !e.start || !e.end) return { kind: 'unknown' }
    const dx = e.end[0] - e.start[0]
    const dy = e.end[1] - e.start[1]
    const n = Math.hypot(dx, dy)
    const normal: [number, number] = n > 0 ? [-dy / n, dx / n] : [0, 1]
    return {
      kind: 'dim_linear',
      p1: e.start,
      p2: e.end,
      value: constraint.value || 0,
      normal,
      entity: eid,
    }
  }

  if (kind === 'radius') {
    const eid = constraint.target?.entity
    if (!eid) return { kind: 'unknown' }
    const e = sketch[eid] as any
    if (!e) return { kind: 'unknown' }
    const center = e.center
    const edge = e.start ? e.start : [e.center[0] + e.radius, e.center[1]]
    return {
      kind: 'dim_radius',
      p1: center,
      p2: edge,
      value: constraint.value || 0,
      entity: eid,
    }
  }

  if (kind === 'coincident') {
    const eid = constraint.a?.entity || constraint.target?.entity
    if (!eid) return { kind: 'unknown' }
    const pt = geomPoint(sketch, constraint.a || constraint.target)
    if (!pt) return { kind: 'unknown' }
    return {
      kind: 'symbol_coincident',
      at: pt,
      entity: eid,
      entities: [constraint.a?.entity, constraint.b?.entity, constraint.target?.entity].filter(Boolean) as string[],
    }
  }

  if (kind === 'perpendicular') {
    const eid = constraint.a?.entity
    if (!eid) return { kind: 'unknown' }
    const ea = sketch[eid] as any
    if (!ea || !ea.end) return { kind: 'unknown' }
    return { kind: 'symbol_perp', at: ea.end, entity: eid, entities: [constraint.a?.entity, constraint.b?.entity].filter(Boolean) as string[] }
  }

  if (kind === 'parallel') {
    const eid = constraint.a?.entity
    if (!eid) return { kind: 'unknown' }
    const ea = sketch[eid] as any
    if (!ea || !ea.start || !ea.end) return { kind: 'unknown' }
    const at: [number, number] = [(ea.start[0] + ea.end[0]) / 2, (ea.start[1] + ea.end[1]) / 2]
    return { kind: 'symbol_parallel', at, entity: eid, entities: [constraint.a?.entity, constraint.b?.entity].filter(Boolean) as string[] }
  }

  if (kind === 'angle') {
    const eid = constraint.a?.entity
    const eid2 = constraint.b?.entity
    if (!eid || !eid2) return { kind: 'unknown' }
    const ea = sketch[eid] as any
    const eb = sketch[eid2] as any
    if (!ea || !eb || !ea.start || !ea.end || !eb.end) return { kind: 'unknown' }
    return {
      kind: 'dim_angle',
      p1: ea.start,
      p2: ea.end,
      p3: eb.end,
      value: constraint.value || 0,
      entity: eid,
    }
  }

  if (kind === 'equal_length') {
    const eid = constraint.a?.entity
    const eid2 = constraint.b?.entity
    if (!eid || !eid2) return { kind: 'unknown' }
    const ea = sketch[eid] as any
    const eb = sketch[eid2] as any
    if (!ea || !eb || !ea.start || !ea.end || !eb.start || !eb.end) return { kind: 'unknown' }
    const at_a: [number, number] = [(ea.start[0] + ea.end[0]) / 2, (ea.start[1] + ea.end[1]) / 2]
    return {
      kind: 'symbol_equal',
      at: at_a,
      entity: eid,
      entities: [eid, eid2],
    }
  }

  if (kind === 'point_distance') {
    const eid = constraint.a?.entity
    const eid2 = constraint.b?.entity
    if (!eid || !eid2) return { kind: 'unknown' }
    const pa = geomPoint(sketch, constraint.a)
    const pb = geomPoint(sketch, constraint.b)
    if (!pa || !pb) return { kind: 'unknown' }
    const dx = pb[0] - pa[0]
    const dy = pb[1] - pa[1]
    const n = Math.hypot(dx, dy)
    const normal: [number, number] = n > 0 ? [-dy / n, dx / n] : [0, 1]
    return {
      kind: 'dim_linear',
      p1: pa,
      p2: pb,
      value: constraint.value || 0,
      normal,
      entity: eid,
    }
  }

  if (kind === 'midpoint') {
    const line = constraint.line
    if (!line) return { kind: 'unknown' }
    const eid = line.entity
    if (!eid) return { kind: 'unknown' }
    const e = sketch[eid] as any
    if (!e || !e.start || !e.end) return { kind: 'unknown' }
    const at: [number, number] = [(e.start[0] + e.end[0]) / 2, (e.start[1] + e.end[1]) / 2]
    return {
      kind: 'symbol_midpoint',
      at,
      entity: eid,
      entities: [eid, constraint.point?.entity].filter(Boolean) as string[],
    }
  }

  if (kind === 'concentric') {
    const eid = constraint.a?.entity
    if (!eid) return { kind: 'unknown' }
    const e = sketch[eid] as any
    if (!e) return { kind: 'unknown' }
    const center = e.center ? e.center : [e.x, e.y]
    return { kind: 'symbol_concentric', at: center, entity: eid, entities: [eid, constraint.b?.entity].filter(Boolean) as string[] }
  }

  if (kind === 'fixed') {
    const eid = constraint.target?.entity
    if (!eid) return { kind: 'unknown' }
    const at = geomPoint(sketch, constraint.target)
    if (!at) return { kind: 'unknown' }
    return {
      kind: 'symbol_fixed',
      at,
      entity: eid,
    }
  }

  if (kind === 'tangent') {
    const arc = constraint.arc
    if (!arc) return { kind: 'unknown' }
    const arcEid = arc.entity
    if (!arcEid) return { kind: 'unknown' }
    const arcGeom = sketch[arcEid] as any
    if (!arcGeom) return { kind: 'unknown' }
    const pt = arc.point !== 'end' ? arcGeom.start : arcGeom.end
    return { kind: 'symbol_tangent', at: pt, entity: arcEid, entities: [constraint.line?.entity, arcEid].filter(Boolean) as string[] }
  }

  if (kind === 'normal') {
    const arc = constraint.arc
    if (!arc) return { kind: 'unknown' }
    const arcEid = arc.entity
    if (!arcEid) return { kind: 'unknown' }
    const arcGeom = sketch[arcEid] as any
    if (!arcGeom) return { kind: 'unknown' }
    const pt = arc.point !== 'end' ? arcGeom.start : arcGeom.end
    return { kind: 'symbol_normal', at: pt, entity: arcEid, entities: [constraint.line?.entity, arcEid].filter(Boolean) as string[] }
  }

  if (kind === 'colinear') {
    const eid = constraint.a?.entity || constraint.target?.entity
    if (!eid) return { kind: 'unknown' }
    const pt = geomPoint(sketch, constraint.a || constraint.target)
    if (!pt) return { kind: 'unknown' }
    return {
      kind: 'symbol_colinear',
      at: pt,
      entity: eid,
      entities: [constraint.a?.entity, constraint.b?.entity, constraint.target?.entity].filter(Boolean) as string[],
    }
  }

  return { kind: 'unknown' }
}

function deriveConstraints(
  feature: any,
  sketch: Sketch
): Constraints {
  if (!feature.constraints) return {}
  const result: Constraints = {}

  for (const c of feature.constraints) {
    const render = computeConstraintRender(c, sketch)
    if (render.kind === 'unknown') continue
    result[c.id] = {
      render,
      residual: 0,
    }
  }
  return result
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
  featureDefs?: any[] // Full feature definitions from PartDoc.features
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
  featureDefs,
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
    if (!features) return []
    const limit = rollbackPosition ?? features.length
    return features
      .slice(0, limit)
      .filter(f => f.kind === 'sketch' && (!visibleFeatures || visibleFeatures.has(f.id)))
  }, [features, rollbackPosition, visibleFeatures])

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
        {activeSketchFeatures.map(f => {
          const solveResult = solveResults?.[f.id]
          // Get the full feature definition if available
          const fullFeatureDef = featureDefs?.find(fd => fd.id === f.id) || f
          // Use solved geometry if available, otherwise show initial geometry from the document
          const sketch = solveResult?.solved ? solveResult.solved : unflattenGeometry(fullFeatureDef.initial || {}, fullFeatureDef.entities)
          // Always derive constraints from the current sketch geometry (whether solved or initial)
          // to ensure icons are correctly placed.
          const constraints = solveResult?.constraints ? solveResult.constraints : deriveConstraints(fullFeatureDef, sketch)
          return (
            <Geometry3D key={f.id}
              featureId={f.id}
              solved={sketch}
              constraints={constraints}
              topology={solveResult?.topology}
              activeFeatureId={activeFeatureId}
            />
          )
        })}
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
