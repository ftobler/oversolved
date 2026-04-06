import { useCallback, useMemo, useRef, useState } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { OrthographicCamera, Line, Text } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { SketchData, Feature, PlaneTransform, Sketch } from '../types/cad'
import { unflattenGeometry, deriveConstraints } from '../utils/geometryMapping'
import Geometry3D from './Geometry3D'
import { CubeGizmoCanvas } from './CubeGizmo'
import { type Hit, type Pv } from './CubeGizmo.utils'
import { useSketchEditorStore } from '../stores/sketchEditorStore'
import OriginMarker from './Viewport/OriginMarker'
import ReferencePlane from './Viewport/ReferencePlane'
import SceneController from './Viewport/SceneController'
import ContextMenuDialog from './ContextMenuDialog'
import { planeRotationFromTransform } from './Geometry3D/utils'
import { COLOR_SELECTED, COLOR_HOVER } from './Geometry3D/constants'

const INITIAL_POSITION: [number, number, number] = [20, 20, 100]
const INITIAL_ZOOM = 200

interface ViewportProps {
  features?: Feature[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  featureDefs?: any[]
  rollbackPosition?: number
  visibleFeatures?: Set<string>
  solveResults?: Record<string, SketchData>
  resetTrigger?: number
  activeFeatureId?: string
  onRightClick?: (pos: [number, number]) => void
  showDebugHit?: boolean
  otherSketches?: Record<string, Sketch>  // sketches from other features (for project tool)
}

function isActive(id: string, features: Feature[] | undefined, rollbackPos: number | undefined, visible: Set<string> | undefined): boolean {
  if (!features || features.length === 0) return true
  const idx = features.findIndex(f => f.id === id)
  if (idx < 0) return false
  return (rollbackPos === undefined || idx < rollbackPos) && (!visible || visible.has(id))
}

const UDPLANE_SIZE = 1
const UDPH = UDPLANE_SIZE / 2
const UDPLANE_BORDER: [number,number,number][] = [[-UDPH,-UDPH,0],[UDPH,-UDPH,0],[UDPH,UDPH,0],[-UDPH,UDPH,0],[-UDPH,-UDPH,0]]

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

function UserDefinedPlane({ featureId, label, planeTransform }: { featureId: string; label: string; planeTransform: PlaneTransform }) {
  // HOVER PATTERN: Local state for visual feedback (fast), store for logic/debug.
  // DO NOT use local hovered state alone - must also call setHoveredPlane().
  const [hovered, setHovered] = useState(false)
  const toggleSelect = useSketchEditorStore(s => s.toggleSelect)
  const commitPlaneSelection = useSketchEditorStore(s => s.commitPlaneSelection)
  const planeSelectionFeatureId = useSketchEditorStore(s => s.planeSelectionFeatureId)
  const fieldPickState = useSketchEditorStore(s => s.fieldPickState)
  const commitFieldPick = useSketchEditorStore(s => s.commitFieldPick)
  const drag = useSketchEditorStore(s => s.drag)
  const setHoveredPlane = useSketchEditorStore(s => s.setHoveredPlane)
  const isRotating = useSketchEditorStore(s => s.isRotating)
  const selId = `@${featureId}`
  const selected = useSketchEditorStore(s => s.selection.has(selId))
  const isDragging = drag !== null

  const rot = planeRotationFromTransform(planeTransform)
  const [ox, oy, oz] = planeTransform.origin

  const color = hovered ? COLOR_HOVER : selected ? COLOR_SELECTED : '#444444'
  const opacity = hovered ? 0.15 : selected ? 0.12 : 0.05

  return (
    <group position={[ox, oy, oz]} rotation={rot}>
      {!isDragging && (
        <mesh
          onPointerOver={e => { if (isRotating) return; e.stopPropagation(); setHovered(true); setHoveredPlane(selId) }}
          onPointerOut={() => { if (isRotating) return; setHovered(false); setHoveredPlane(null) }}
          onClick={e => {
            e.stopPropagation()
            if (fieldPickState?.kind === 'plane') commitFieldPick(selId)
            else if (planeSelectionFeatureId) commitPlaneSelection(selId)
            else toggleSelect(selId)
          }}
        >
          <planeGeometry args={[UDPLANE_SIZE, UDPLANE_SIZE]} />
          <meshBasicMaterial color={color} transparent opacity={opacity} side={THREE.DoubleSide} depthWrite={false} />
        </mesh>
      )}
      <Line points={UDPLANE_BORDER} color={hovered ? COLOR_HOVER : selected ? COLOR_SELECTED : '#666666'} lineWidth={1} />
      <PlaneLabel x={-UDPH} y={UDPH}>{label}</PlaneLabel>
    </group>
  )
}

export default function Viewport({
  features,
  featureDefs,
  rollbackPosition,
  visibleFeatures,
  solveResults,
  resetTrigger = 0,
  activeFeatureId,
  onRightClick,
  showDebugHit = false,
}: ViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pvRef = useRef<Pv[]>([])
  const hoverRef = useRef<Hit | null>(null)
  const snapRef = useRef<THREE.Vector3 | null>(null)
  const cameraRef = useRef<THREE.Camera | null>(null)

  const [ready, setReady] = useState(false)
  const onCreated = useCallback(() => {
    requestAnimationFrame(() => setReady(true))
  }, [])

  const closeContextMenu = useSketchEditorStore(s => s.closeContextMenu)

  const pointerDownPos = useRef<[number, number] | null>(null)
  const pointerDownButton = useRef<number | null>(null)
  const wasPointerDrag = useRef(false)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    pointerDownButton.current = e.button
    if (e.button === 0 || e.button === 1 || e.button === 2) {
      pointerDownPos.current = [e.clientX, e.clientY]
    }
    if (e.button !== 2) closeContextMenu()
  }, [closeContextMenu])

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (!pointerDownPos.current) {
      wasPointerDrag.current = false
      pointerDownButton.current = null
      return
    }
    const dx = e.clientX - pointerDownPos.current[0]
    const dy = e.clientY - pointerDownPos.current[1]
    const wasDrag = Math.hypot(dx, dy) >= 4
    wasPointerDrag.current = wasDrag
    pointerDownPos.current = null

    if (wasDrag) return

    if (e.button === 2 && onRightClick) {
      onRightClick([e.clientX, e.clientY])
    }
  }, [onRightClick])

  const showOrigin = isActive('Origin', features, rollbackPosition, visibleFeatures)
  const showFront  = isActive('Front',  features, rollbackPosition, visibleFeatures)
  const showTop    = isActive('Top',    features, rollbackPosition, visibleFeatures)
  const showRight  = isActive('Right',  features, rollbackPosition, visibleFeatures)

  const activeSketchFeatures = useMemo(() => {
    if (!features) return []
    const limit = rollbackPosition ?? features.length
    return features.slice(0, limit).filter(f => f.kind === 'sketch' && (!visibleFeatures || visibleFeatures.has(f.id)))
  }, [features, rollbackPosition, visibleFeatures])

  return (
    <div
      style={{ position: 'relative', width: '100%', height: '100%' }}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onContextMenu={e => { e.preventDefault(); }}
    >
      <Canvas
        style={{ width: '100%', height: '100%', background: '#111' }}
        gl={{ antialias: true }}
        onCreated={onCreated}
        onPointerMissed={() => {
          // Only clear selection if this was a left-click on empty space, not a camera drag
          if (!wasPointerDrag.current && pointerDownButton.current === 0) {
            useSketchEditorStore.getState().clearSelection()
          }
        }}
      >
        <OrthographicCamera makeDefault position={INITIAL_POSITION} zoom={INITIAL_ZOOM} near={-1000000} far={1000000} />
        <SceneController resetTrigger={resetTrigger} canvasRef={canvasRef} pvRef={pvRef} hoverRef={hoverRef} snapRef={snapRef} cameraRef={cameraRef} />

        <ambientLight intensity={0.8} />
        <directionalLight position={[2,2,3]} intensity={0.6} />

        {showOrigin && <OriginMarker />}
        {showFront  && <ReferencePlane rotation={[0,0,0]} label="Front" />}
        {showTop    && <ReferencePlane rotation={[-Math.PI/2,0,0]} label="Top" />}
        {showRight  && <ReferencePlane rotation={[0,Math.PI/2,0]} label="Right" />}

        {(features ?? [])
          .filter(f => f.kind === 'plane' && !['Origin','Top','Front','Right'].includes(f.id))
          .filter(f => isActive(f.id, features, rollbackPosition, visibleFeatures))
          .map(f => {
            const solveResult = solveResults?.[f.id]
            if (!solveResult?.plane_transform) return null
            return <UserDefinedPlane key={f.id} featureId={f.id} label={f.label || f.id} planeTransform={solveResult.plane_transform} />
          })}

        {activeSketchFeatures.map(f => {
          const solveResult = solveResults?.[f.id]
          const fullFeatureDef = featureDefs?.find(fd => fd.id === f.id) || f
          const sketch = solveResult?.solved ? solveResult.solved : unflattenGeometry(fullFeatureDef.initial || {}, fullFeatureDef.entities)
          const constraints = solveResult?.constraints ? solveResult.constraints : deriveConstraints(fullFeatureDef, sketch)
          return (
            <Geometry3D key={f.id} featureId={f.id} solved={sketch} entities={fullFeatureDef.entities} constraints={constraints} topology={solveResult?.topology} activeFeatureId={activeFeatureId} plane={fullFeatureDef.plane} planeTransform={solveResult?.plane_transform} solveStatus={solveResult?.status} entityStatus={solveResult?.features} showDebugHit={showDebugHit} />
          )
        })}
      </Canvas>

      {!ready && <div style={{ position: 'absolute', inset: 0, background: '#111', zIndex: 1 }} />}

      <CubeGizmoCanvas canvasRef={canvasRef} pvRef={pvRef} hoverRef={hoverRef} snapRef={snapRef} cameraRef={cameraRef} />
      <ContextMenuDialog />
    </div>
  )
}
