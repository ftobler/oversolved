import { useCallback, useMemo, useRef, forwardRef, useImperativeHandle } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrthographicCamera, Line } from '@react-three/drei'
import * as THREE from 'three'
import type { SketchData, Feature, Sketch, BodyResult, PlaneDef } from '../types/cad'
import { unflattenGeometry, deriveConstraints } from '../utils/geometryMapping'
import Geometry3D from './Geometry3D'
import { CubeGizmoCanvas } from './CubeGizmo'
import { type Hit, type Pv } from './CubeGizmo.utils'
import { useSketchEditorStore } from '../stores/sketchEditorStore'
import Body3D from './Geometry3D/Body3D'
import OriginMarker from './Viewport/OriginMarker'
import ReferencePlane from './Viewport/ReferencePlane'
import SceneController from './Viewport/SceneController'
import CameraLight from './Viewport/CameraLight'
import UserDefinedPlane from './Viewport/UserDefinedPlane'
import ContextMenuDialog from './ContextMenuDialog'
import { CLICK_THRESHOLD_PX } from './Geometry3D/constants'
import { useSelectionPointerUpCleanup } from './interaction/useSelectionPointerUpCleanup'
import { getBodiesToRender, getSketchesToRender } from './Viewport/bodyUtils'
import { buildBodySnapSketch, builtinPlaneTransform, BODY_SNAP_FEAT_PREFIX } from './Geometry3D/bodySnapProjection'

const INITIAL_POSITION: [number, number, number] = [20, 20, 100]

const INITIAL_ZOOM = 200

interface ViewportProps {
  features?: Feature[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  featureDefs?: any[]
  rollbackPosition?: number
  visibleFeatures?: Set<string>
  visibleBodies?: Set<string>
  solveResults?: Record<string, SketchData>
  resetTrigger?: number
  activeFeatureId?: string
  onRightClick?: (pos: [number, number]) => void
  showDebugHit?: boolean
  otherSketches?: Record<string, Sketch>  // sketches from other features (for project tool)
  bodies?: Record<string, BodyResult>
  pickBodies?: Record<string, BodyResult>
  partColors?: Record<string, string>
  partStyle?: Record<string, import('../types/cad').PartStyleEntry>
  ghostMode?: 'additive' | 'subtractive'
  planesVisible?: boolean
}

function isActive(id: string, features: Feature[] | undefined, rollbackPos: number | undefined, visible: Set<string> | undefined): boolean {
  if (!features || features.length === 0) return true
  const idx = features.findIndex(f => f.id === id)
  if (idx < 0) return false
  return (rollbackPos === undefined || idx < rollbackPos) && (!visible || visible.has(id))
}

function calculateMeshExtent(vertices: [number, number, number][]): number {
  if (vertices.length === 0) return 0

  let minX = vertices[0][0], maxX = vertices[0][0]
  let minY = vertices[0][1], maxY = vertices[0][1]
  let minZ = vertices[0][2], maxZ = vertices[0][2]

  for (const [x, y, z] of vertices) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x)
    minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z)
  }

  const width = maxX - minX
  const height = maxY - minY
  const depth = maxZ - minZ

  return Math.max(width, height, depth)
}

function getModelBoundingBoxExtent(bodies: Record<string, BodyResult> | undefined): number {
  if (!bodies) return 0

  const allVertices: [number, number, number][] = []
  for (const body of Object.values(bodies)) {
    if (body.mesh?.vertices) {
      allVertices.push(...body.mesh.vertices)
    }
  }

  return calculateMeshExtent(allVertices)
}

function getFaceExtent(faceQuery: string, bodies: Record<string, BodyResult>): number {
  const match = faceQuery.match(/@([^/]+)/)
  if (!match) return 0

  const bodyId = match[1]
  const body = bodies[bodyId]
  if (!body?.mesh?.vertices) return 0

  return calculateMeshExtent(body.mesh.vertices)
}

function calculatePlaneSize(
  planeDefinition: PlaneDef | undefined,
  bodies: Record<string, BodyResult> | undefined,
): number {
  const FALLBACK_SIZE = 100
  const EXPANSION_FACTOR = 1.1

  if (!planeDefinition || !bodies) return FALLBACK_SIZE

  // Case 1: Plane defined on a face (on_face mode)
  if (planeDefinition.mode === 'on_face' && planeDefinition.face) {
    const faceExtent = getFaceExtent(planeDefinition.face, bodies)
    if (faceExtent > 0) return faceExtent * EXPANSION_FACTOR
  }

  // Case 4: Fallback - use model bounding box
  const modelExtent = getModelBoundingBoxExtent(bodies)
  if (modelExtent > 0) return modelExtent * EXPANSION_FACTOR

  // Final fallback
  return FALLBACK_SIZE
}

function getActiveSketchPlane(activeFeatureId: string | undefined, features: Feature[] | undefined): string | null {
  if (!activeFeatureId || !features) return null
  const activeFeature = features.find(f => f.id === activeFeatureId)
  if (!activeFeature || activeFeature.kind !== 'sketch') return null
  return activeFeature.plane || null
}

interface SketchPlaneDisplayProps {
  planeQuery: string
  size: number
}

function SketchPlaneDisplay({ planeQuery, size }: SketchPlaneDisplayProps) {
  const match = planeQuery.match(/@([^/]+)/)
  if (!match) return null

  const planeId = match[1]

  let rotation: [number, number, number] = [0, 0, 0]
  if (planeId === 'builtin_plane_front') rotation = [0, 0, 0]
  else if (planeId === 'builtin_plane_top') rotation = [-Math.PI/2, 0, 0]
  else if (planeId === 'builtin_plane_right') rotation = [0, Math.PI/2, 0]
  else {
    return null
  }

  const ph = size / 2
  const planeBorder: [number, number, number][] = [
    [-ph, -ph, 0], [ph, -ph, 0], [ph, ph, 0], [-ph, ph, 0], [-ph, -ph, 0],
  ]

  return (
    <group rotation={rotation}>
      <mesh raycast={() => null}>
        <planeGeometry args={[size, size]} />
        <meshBasicMaterial
          color="#0077ff"
          transparent
          opacity={0.08}
          side={THREE.DoubleSide}
          depthWrite={false}
          wireframe={false}
        />
      </mesh>

      <Line
        points={planeBorder}
        color="#0077ff"
        lineWidth={2}
        transparent
        opacity={0.3}
      />
    </group>
  )
}

export interface ViewportHandle {
  captureScreenshot: () => Promise<string | null>
  captureScreenshotForSaving: () => Promise<string | null>
  autoZoomToFit: () => void
  alignCameraToPlane: (planeId: string) => void
  alignCameraToFace: (faceNormal: [number, number, number], faceCenter: [number, number, number]) => void
}

export default forwardRef<ViewportHandle, ViewportProps>(function Viewport({
  features,
  featureDefs,
  rollbackPosition,
  visibleFeatures,
  visibleBodies,
  solveResults,
  resetTrigger,
  activeFeatureId,
  onRightClick,
  showDebugHit,
  otherSketches,
  bodies,
  pickBodies,
  partColors,
  partStyle,
  ghostMode,
  planesVisible = true,
}: ViewportProps, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pvRef = useRef<Pv[]>([])
  const hoverRef = useRef<Hit | null>(null)
  const snapRef = useRef<THREE.Vector3 | null>(null)
  const cameraRef = useRef<THREE.Camera | null>(null)
  const glRef = useRef<THREE.WebGLRenderer | null>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)

  const onCreated = useCallback((state: { gl: THREE.WebGLRenderer; scene: THREE.Scene }) => {
    glRef.current = state.gl
    sceneRef.current = state.scene
  }, [])

  const captureScreenshot = useCallback(async (): Promise<string | null> => {
    const gl = glRef.current
    const scene = sceneRef.current
    const camera = cameraRef.current
    if (!gl || !scene || !camera) return null
    gl.render(scene, camera)
    return gl.domElement.toDataURL('image/png')
  }, [])

  const captureScreenshotForSaving = useCallback(async (): Promise<string | null> => {
    const gl = glRef.current
    const scene = sceneRef.current
    const camera = cameraRef.current as THREE.OrthographicCamera | null
    if (!gl || !scene || !camera) return null

    const originalSize = gl.getSize(new THREE.Vector2())
    const smallWidth = Math.floor(originalSize.width / 4)
    const smallHeight = Math.floor(originalSize.height / 4)

    await new Promise<void>(resolve => setTimeout(resolve, 0))

    gl.setSize(smallWidth, smallHeight)
    gl.render(scene, camera)
    const dataUrl = gl.domElement.toDataURL('image/png')

    gl.setSize(originalSize.width, originalSize.height)

    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('Failed to load image'))
      img.src = dataUrl
    })

    const MAX_SIZE = 512
    const finalScale = Math.min(MAX_SIZE / img.width, MAX_SIZE / img.height, 1)
    const newWidth = Math.floor(img.width * finalScale)
    const newHeight = Math.floor(img.height * finalScale)

    const canvas = document.createElement('canvas')
    canvas.width = newWidth
    canvas.height = newHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    ctx.drawImage(img, 0, 0, newWidth, newHeight)
    return canvas.toDataURL('image/png')
  }, [])

  const autoZoomToFit = useCallback(() => {
    const camera = cameraRef.current as THREE.OrthographicCamera | null
    const scene = sceneRef.current
    if (!camera || !scene) return

    const box = new THREE.Box3()
    let hasContent = false

    scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.computeBoundingBox()
        const geoBox = obj.geometry.boundingBox
        if (geoBox) {
          const worldBox = geoBox.clone().applyMatrix4(obj.matrixWorld)
          box.union(worldBox)
          hasContent = true
        }
      }
    })

    if (!hasContent) return

    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())

    const gl = glRef.current
    if (!gl) return

    const aspect = gl.domElement.width / gl.domElement.height
    const margin = 1.2

    const viewHeight = size.y * margin
    const viewWidth = size.x * margin

    let targetViewHeight = viewHeight
    let targetViewWidth = viewWidth
    if (targetViewWidth / aspect > targetViewHeight) {
      targetViewHeight = targetViewWidth / aspect
    } else {
      targetViewWidth = targetViewHeight * aspect
    }

    const zoom = gl.domElement.height / targetViewHeight
    if (zoom > 0) {
      camera.zoom = zoom
      camera.position.set(center.x, center.y, 100)
      camera.updateProjectionMatrix()
    }
  }, [])

  const alignCameraToPlane = useCallback((planeId: string) => {
    const camera = cameraRef.current as THREE.OrthographicCamera | null
    if (!camera) return

    const planeRotations: Record<string, [number, number, number]> = {
      'builtin_plane_front': [0, 0, 100],
      'builtin_plane_top': [0, 100, 0],
      'builtin_plane_right': [100, 0, 0],
      'builtin_plane_bottom': [0, -100, 0],
      'builtin_plane_back': [0, 0, -100],
      'builtin_plane_left': [-100, 0, 0],
    }

    const direction = planeRotations[planeId]
    if (!direction) return

    const distance = 100
    const [dx, dy, dz] = direction
    const norm = Math.sqrt(dx*dx + dy*dy + dz*dz)
    camera.position.set(
      (dx / norm) * distance,
      (dy / norm) * distance,
      (dz / norm) * distance
    )

    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()
  }, [cameraRef])

  const alignCameraToFace = useCallback((faceNormal: [number, number, number], faceCenter: [number, number, number]) => {
    const camera = cameraRef.current as THREE.OrthographicCamera | null
    if (!camera) return

    const [nx, ny, nz] = faceNormal
    const norm = Math.sqrt(nx*nx + ny*ny + nz*nz)
    if (norm === 0) return

    const distance = 100
    const ndx = nx / norm
    const ndy = ny / norm
    const ndz = nz / norm

    camera.position.set(
      faceCenter[0] + ndx * distance,
      faceCenter[1] + ndy * distance,
      faceCenter[2] + ndz * distance
    )
    camera.lookAt(faceCenter[0], faceCenter[1], faceCenter[2])
    camera.updateProjectionMatrix()
  }, [cameraRef])

  useImperativeHandle(ref, () => ({ captureScreenshot, captureScreenshotForSaving, autoZoomToFit, alignCameraToPlane, alignCameraToFace }), [captureScreenshot, captureScreenshotForSaving, autoZoomToFit, alignCameraToPlane, alignCameraToFace])

  const closeContextMenu = useSketchEditorStore(s => s.closeContextMenu)

  const pointerDownPos = useRef<[number, number] | null>(null)
  const pointerDownButton = useRef<number | null>(null)
  const wasPointerDrag = useRef(false)

  // Layer 3B: clear isPointerDown and dynamicSelection on any pointer-up (including off-canvas releases).
  useSelectionPointerUpCleanup()

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!e.isPrimary) return  // Ignore non-primary pointers (multi-touch)
    pointerDownButton.current = e.button
    if (e.button === 0 || e.button === 1 || e.button === 2) {
      pointerDownPos.current = [e.clientX, e.clientY]
    }
    if (e.button !== 2) closeContextMenu()
  }, [closeContextMenu])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!e.isPrimary) return  // Ignore non-primary pointers (multi-touch)
    if (!pointerDownPos.current) {
      wasPointerDrag.current = false
      pointerDownButton.current = null
      return
    }
    const dx = e.clientX - pointerDownPos.current[0]
    const dy = e.clientY - pointerDownPos.current[1]
    const wasDrag = Math.hypot(dx, dy) >= CLICK_THRESHOLD_PX
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

  const bodyItems = useMemo(
    () => getBodiesToRender(bodies, features, rollbackPosition, visibleBodies, ghostMode),
    [bodies, features, rollbackPosition, visibleBodies, ghostMode]
  )

  const pickBodyItems = useMemo(
    () => getBodiesToRender(pickBodies, features, undefined, visibleBodies, ghostMode),
    [pickBodies, features, visibleBodies, ghostMode]
  )

  const activeSketchFeatures = useMemo(
    () => getSketchesToRender(features, rollbackPosition, visibleFeatures),
    [features, rollbackPosition, visibleFeatures]
  )

  // Build a combined otherSketches that includes cross-sketch entities AND projected body geometry.
  // Body geometry is projected to 2D using the active sketch's plane transform so snap detection
  // can treat it as regular sketch candidates (with a BODY_SNAP_FEAT_PREFIX sentinel featureId).
  const combinedOtherSketches = useMemo(() => {
    if (!activeFeatureId) return otherSketches
    const activeResult = solveResults?.[activeFeatureId]
    const activeFeature = features?.find(f => f.id === activeFeatureId)

    // Resolve plane transform: backend-provided or derived from builtin plane string.
    const planeTransform = activeResult?.plane_transform
      ?? (activeFeature?.plane ? builtinPlaneTransform(activeFeature.plane) : null)

    if (!planeTransform || !bodies) return otherSketches

    const bodySketchEntries: Record<string, Sketch> = {}
    for (const [bodyId, body] of Object.entries(bodies)) {
      const snapSketch = buildBodySnapSketch(body.vertices, body.edges, planeTransform)
      if (Object.keys(snapSketch).length > 0) {
        bodySketchEntries[`${BODY_SNAP_FEAT_PREFIX}${bodyId}`] = snapSketch
      }
    }

    if (Object.keys(bodySketchEntries).length === 0) return otherSketches
    return { ...otherSketches, ...bodySketchEntries }
  }, [activeFeatureId, solveResults, features, bodies, otherSketches])

  const planeSizes = useMemo(() => {
    const sizes: Record<string, number> = {}
    features?.forEach(f => {
      if (f.kind === 'plane') {
        const planeDef = featureDefs?.find(fd => fd.id === f.id)?.definition as PlaneDef | undefined
        sizes[f.id] = calculatePlaneSize(planeDef, bodies)
      }
    })
    return sizes
  }, [features, featureDefs, bodies])

  return (
    <div
      style={{ position: 'relative', width: '100%', height: '100%', touchAction: 'none' }}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onContextMenu={e => { e.preventDefault(); }}
    >
      <Canvas
        style={{ width: '100%', height: '100%', background: '#111' }}
        gl={{ antialias: true, logarithmicDepthBuffer: true }}
        onCreated={onCreated}
        onPointerMissed={() => {
          // Only clear selection if this was a left-click on empty space, not a camera drag
          if (!wasPointerDrag.current && pointerDownButton.current === 0) {
            useSketchEditorStore.getState().clearNormalSelection()
            useSketchEditorStore.getState().setHoveredBodyId(null)
          }
        }}
      >
        <OrthographicCamera makeDefault position={INITIAL_POSITION} zoom={INITIAL_ZOOM} near={-10} far={1000} /* clipping planes */ />
        <SceneController resetTrigger={resetTrigger} canvasRef={canvasRef} pvRef={pvRef} hoverRef={hoverRef} snapRef={snapRef} cameraRef={cameraRef} />

        <CameraLight />

        {showOrigin && <OriginMarker />}
        {planesVisible && showFront  && <ReferencePlane rotation={[0,0,0]} label="Front" />}
        {planesVisible && showTop    && <ReferencePlane rotation={[-Math.PI/2,0,0]} label="Top" />}
        {planesVisible && showRight  && <ReferencePlane rotation={[0,Math.PI/2,0]} label="Right" />}

        {planesVisible && (features ?? [])
          .filter(f => f.kind === 'plane' && !['Origin','Top','Front','Right'].includes(f.id))
          .filter(f => isActive(f.id, features, rollbackPosition, visibleFeatures))
          .map(f => {
            const solveResult = solveResults?.[f.id]
            if (!solveResult?.plane_transform) return null
            return <UserDefinedPlane key={f.id} featureId={f.id} label={f.label || f.id} planeTransform={solveResult.plane_transform} size={planeSizes[f.id]} />
          })}

        {(() => {
          const sketchPlaneQuery = getActiveSketchPlane(activeFeatureId, features)
          if (!sketchPlaneQuery) return null

          const planeSize = calculatePlaneSize(
            undefined,
            bodies,
          ) || 100

          return <SketchPlaneDisplay key="sketch-plane" planeQuery={sketchPlaneQuery} size={planeSize} />
        })()}

        {activeSketchFeatures.map(f => {
          const solveResult = solveResults?.[f.id]
          const fullFeatureDef = featureDefs?.find(fd => fd.id === f.id) || f
          const sketch = solveResult?.solved ? solveResult.solved : unflattenGeometry(fullFeatureDef.initial || {}, fullFeatureDef.entities)
          const constraints = solveResult?.constraints ? solveResult.constraints : deriveConstraints(fullFeatureDef, sketch)
          const isActive = f.id === activeFeatureId
          return (
            <Geometry3D key={f.id} featureId={f.id} solved={sketch} entities={fullFeatureDef.entities} constraints={constraints} topology={solveResult?.topology} activeFeatureId={activeFeatureId} plane={fullFeatureDef.plane} planeTransform={solveResult?.plane_transform} solveStatus={solveResult?.status} entityStatus={solveResult?.features} showDebugHit={showDebugHit} otherSketches={isActive ? combinedOtherSketches : undefined} />
          )
        })}

        {pickBodyItems.map(b => (
          <Body3D key={`pick-${b.key}`} featureId={b.featureId} bodyId={b.bodyId} mesh={b.mesh} edges={b.edges} edgeQueries={b.edgeQueries} vertices={b.vertices} vertexQueries={b.vertexQueries} visible={b.visible} showDebugHit={showDebugHit} color={partColors?.[b.key]} transparency={partStyle?.[b.key]?.transparency ?? 0} metalness={partStyle?.[b.key]?.metalness ?? 0.3} ghost={b.ghost} interactive={true} />
        ))}
        {bodyItems.map(b => (
          <Body3D key={b.key} featureId={b.featureId} bodyId={b.bodyId} mesh={b.mesh} edges={b.edges} edgeQueries={b.edgeQueries} vertices={b.vertices} vertexQueries={b.vertexQueries} visible={b.visible} showDebugHit={showDebugHit} color={partColors?.[b.key]} transparency={partStyle?.[b.key]?.transparency ?? 0} metalness={partStyle?.[b.key]?.metalness ?? 0.3} ghost={b.ghost} interactive={ghostMode === undefined && pickBodyItems.length === 0} />
        ))}
      </Canvas>


<CubeGizmoCanvas canvasRef={canvasRef} pvRef={pvRef} hoverRef={hoverRef} snapRef={snapRef} cameraRef={cameraRef} />
      <ContextMenuDialog />
    </div>
  )
})
