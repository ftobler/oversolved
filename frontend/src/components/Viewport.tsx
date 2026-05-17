import { useCallback, useEffect, useMemo, useRef, forwardRef, useImperativeHandle } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrthographicCamera } from '@react-three/drei'
import * as THREE from 'three'
import type { Feature, PartFeature, Sketch, BodyResult, PlaneDef } from '@/types/cad'
import { unflattenGeometry, deriveConstraints } from '@/utils/geometryMapping'
import Geometry3D from '@/components/Geometry3D'
import { CubeGizmoCanvas } from '@/components/CubeGizmo'
import { type Hit, type Pv } from '@/components/CubeGizmo.utils'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import Body3D from '@/components/Geometry3D/Body3D'
import PreviewEdgeOverlay from '@/components/Geometry3D/PreviewEdgeOverlay'
import OriginMarker from '@/components/Viewport/OriginMarker'
import ReferencePlane from '@/components/Viewport/ReferencePlane'
import SceneController from '@/components/Viewport/SceneController'
import CameraLight from '@/components/Viewport/CameraLight'
import UserDefinedPlane from '@/components/Viewport/UserDefinedPlane'
import { PlaneLabel, PlaneSurface } from '@/components/Viewport/PlaneVisual'
import ContextMenuDialog from '@/components/ContextMenuDialog'
import { IdPickingDriver, DIMENSION_LABEL_LAYER_NAME } from '@/picking'
import IdDebugOverlay from '@/components/Viewport/IdDebugOverlay'
import type { IdPipeline } from '@/picking'
import { useIdBufferPointerDispatch, wasLastClickConsumedByIdDispatch } from '@/components/Viewport/idDispatch/useIdBufferPointerDispatch'
import { CLICK_THRESHOLD_PX } from '@/components/Geometry3D/constants'
import { useSelectionPointerUpCleanup } from '@/components/interaction/useSelectionPointerUpCleanup'
import { getBodiesToRender, getSketchesToRender, getPreviewBodies } from '@/components/Viewport/bodyUtils'
import { buildBodySnapSketch, builtinPlaneTransform, BODY_SNAP_FEAT_PREFIX } from '@/components/Geometry3D/bodySnapProjection'
import type { SketchData } from '@/types/cad'

const INITIAL_POSITION: [number, number, number] = [20, 20, 100]

const INITIAL_ZOOM = 200

export interface ViewportProps {
  resetTrigger?: number
  onRightClick?: (pos: [number, number]) => void
}

function isActive(id: string, features: Feature[] | undefined, rollbackPos: number | undefined, visible: Set<string> | undefined): boolean {
  if (!features || features.length === 0) return true
  const idx = features.findIndex(f => f.id === id)
  if (idx < 0) return false
  return (rollbackPos === undefined || idx < rollbackPos) && (!visible || visible.has(id))
}

function calculateMeshExtentFromFlat(vertices: Float32Array): number {
  if (vertices.length === 0) return 0

  let minX = Infinity, maxX = -Infinity
  let minY = Infinity, maxY = -Infinity
  let minZ = Infinity, maxZ = -Infinity

  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i], y = vertices[i + 1], z = vertices[i + 2]
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }

  if (!Number.isFinite(minX)) return 0
  return Math.max(maxX - minX, maxY - minY, maxZ - minZ)
}

function calculateMeshExtent(vertices: Float32Array | [number, number, number][]): number {
  if (vertices instanceof Float32Array) return calculateMeshExtentFromFlat(vertices)
  if (vertices.length === 0) return 0

  let minX = Infinity, maxX = -Infinity
  let minY = Infinity, maxY = -Infinity
  let minZ = Infinity, maxZ = -Infinity

  for (const [x, y, z] of vertices) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
    if (x < minX) minX = x; if (x > maxX) maxX = x
    if (y < minY) minY = y; if (y > maxY) maxY = y
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
  }

  if (!Number.isFinite(minX)) return 0

  const width = maxX - minX
  const height = maxY - minY
  const depth = maxZ - minZ

  return Math.max(width, height, depth)
}

function getModelBoundingBoxExtent(bodies: Record<string, BodyResult> | undefined): number {
  if (!bodies) return 0

  let maxExtent = 0
  for (const body of Object.values(bodies)) {
    if (body.mesh?.vertices) {
      const e = calculateMeshExtent(body.mesh.vertices)
      if (e > maxExtent) maxExtent = e
    }
  }

  return maxExtent
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

function getActiveSketchPlane(activeFeatureId: string | null | undefined, features: Feature[] | undefined): string | null {
  if (!activeFeatureId || !features) return null
  const activeFeature = features.find(f => f.id === activeFeatureId)
  if (!activeFeature || activeFeature.kind !== 'sketch') return null
  return activeFeature.plane || null
}

interface SketchPlaneDisplayProps {
  planeQuery: string
  size: number
  sketchLabel?: string
}

export function SketchPlaneDisplay({ planeQuery, size, sketchLabel }: SketchPlaneDisplayProps) {
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

  return (
    <group rotation={rotation}>
      <PlaneSurface
        size={size}
        noRaycast
      />
      {sketchLabel && (
        <PlaneLabel x={-size/2} y={size/2}>
          {sketchLabel}
        </PlaneLabel>
      )}
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
  resetTrigger,
  onRightClick,
}: ViewportProps, ref) {
  const features = usePartEditorStore(s => s.features) as Feature[]
  const doc = usePartEditorStore(s => s.doc)
  const rollbackPosition = usePartEditorStore(s => s.rollbackPosition) ?? undefined
  const visibleFeatures = usePartEditorStore(s => s.visibleFeatures)
  const visibleBodies = usePartEditorStore(s => s.visibleBodies)
  const solveResults = usePartEditorStore(s => s.solveResults) as Record<string, SketchData> | undefined
  const bodies = usePartEditorStore(s => s.bodies)
  const pickBodies = usePartEditorStore(s => s.pickBodies)
  const ghostMode = usePartEditorStore(s => s.ghostMode)
  const otherSketches = usePartEditorStore(s => s.otherSketches) as Record<string, Sketch>
  const partColors = usePartEditorStore(s => s.partColors)
  const partStyle = usePartEditorStore(s => s.partStyle)
  const activeFeatureId = usePartEditorStore(s => s.activeSketchFeatureId) ?? undefined
  const showDebugHit = useSketchEditorStore(s => s.showDebugHit)

  const featureDefs = doc?.features as PartFeature[] | undefined

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pvRef = useRef<Pv[]>([])
  const hoverRef = useRef<Hit | null>(null)
  const snapRef = useRef<THREE.Vector3 | null>(null)
  const cameraRef = useRef<THREE.Camera | null>(null)
  const glRef = useRef<THREE.WebGLRenderer | null>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const bodiesRef = useRef<Record<string, BodyResult> | undefined>(undefined)
  // eslint-disable-next-line react-hooks/refs
  bodiesRef.current = bodies
  const idPipelineRef = useRef<IdPipeline | null>(null)
  const onIdPipelineReady = useCallback((p: IdPipeline) => { idPipelineRef.current = p }, [])

  // 267.2: canvas-level pointer dispatcher backed by the ID buffer. Slice
  // scope consumes `dimensionLabel` only; per-mesh R3F handlers on every
  // other layer stay live. Dimension label R3F handlers come off in 267.3.
  const consumedLayers = useMemo(() => new Set([DIMENSION_LABEL_LAYER_NAME]), [])
  useIdBufferPointerDispatch({ glRef, consumedLayers })

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

  const autoZoomToFitNow = useCallback(() => {
    const camera = cameraRef.current as THREE.OrthographicCamera | null
    if (!camera) return false

    let minX = Infinity, maxX = -Infinity
    let minY = Infinity, maxY = -Infinity
    let minZ = Infinity, maxZ = -Infinity

    // Try body vertex data first (fast, accurate).
    const bodiesData = bodiesRef.current
    if (bodiesData && Object.keys(bodiesData).length > 0) {
      for (const body of Object.values(bodiesData)) {
        const verts = body.mesh?.vertices
        if (!verts) continue
        if (verts instanceof Float32Array) {
          for (let i = 0; i < verts.length; i += 3) {
            const x = verts[i], y = verts[i + 1], z = verts[i + 2]
            if (!Number.isFinite(x)) continue
            if (x < minX) minX = x; if (x > maxX) maxX = x
            if (y < minY) minY = y; if (y > maxY) maxY = y
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
          }
        } else {
          for (const [x, y, z] of verts) {
            if (!Number.isFinite(x)) continue
            if (x < minX) minX = x; if (x > maxX) maxX = x
            if (y < minY) minY = y; if (y > maxY) maxY = y
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
          }
        }
      }
    }

    // Fall back to scene traversal if no body vertex data found.
    if (!Number.isFinite(minX)) {
      const scene = sceneRef.current
      if (scene) {
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
        if (hasContent) {
          const size = box.getSize(new THREE.Vector3())
          const center = box.getCenter(new THREE.Vector3())
          if (Number.isFinite(size.x) && Number.isFinite(size.y)) {
            minX = center.x - size.x / 2; maxX = center.x + size.x / 2
            minY = center.y - size.y / 2; maxY = center.y + size.y / 2
            minZ = center.z - size.z / 2; maxZ = center.z + size.z / 2
          }
        }
      }
    }

    if (!Number.isFinite(minX)) return false

    const cx = (minX + maxX) / 2
    const cy = (minY + maxY) / 2
    const cz = (minZ + maxZ) / 2

    const frustumHeight = camera.top - camera.bottom
    const frustumWidth = camera.right - camera.left
    if (frustumHeight <= 0 || frustumWidth <= 0) return false

    // Project bounding box corners through camera view matrix to get screen-space extents.
    camera.updateMatrixWorld()
    const viewMatrix = camera.matrixWorldInverse
    const corners = [
      [minX, minY, minZ], [maxX, minY, minZ], [minX, maxY, minZ], [maxX, maxY, minZ],
      [minX, minY, maxZ], [maxX, minY, maxZ], [minX, maxY, maxZ], [maxX, maxY, maxZ],
    ]
    let minVX = Infinity, maxVX = -Infinity, minVY = Infinity, maxVY = -Infinity
    const tmp = new THREE.Vector3()
    for (const [x, y, z] of corners) {
      tmp.set(x, y, z).applyMatrix4(viewMatrix)
      if (tmp.x < minVX) minVX = tmp.x; if (tmp.x > maxVX) maxVX = tmp.x
      if (tmp.y < minVY) minVY = tmp.y; if (tmp.y > maxVY) maxVY = tmp.y
    }
    const viewSizeX = maxVX - minVX
    const viewSizeY = maxVY - minVY

    const margin = 2.0
    const targetViewHeight = Math.max(viewSizeY * margin, viewSizeX * margin * (frustumHeight / frustumWidth))
    const zoom = frustumHeight / targetViewHeight
    if (zoom <= 0 || !Number.isFinite(zoom)) return false

    camera.zoom = zoom
    const centerWorld = new THREE.Vector3(cx, cy, cz)
    const camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
    const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion)
    const newPos = camera.position.clone()
      .addScaledVector(camRight, camRight.dot(centerWorld) - camRight.dot(camera.position))
      .addScaledVector(camUp, camUp.dot(centerWorld) - camUp.dot(camera.position))
    camera.position.copy(newPos)
    camera.updateProjectionMatrix()
    return true
  }, [])

  // Binary geometry for 3D bodies arrives after the JSON solve result, so we
  // must handle the timing gap: try immediately, then re-trigger when bodies
  // prop populates. The ref prevents re-zooming after the first successful fit.
  const zoomDoneRef = useRef(false)
  const autoZoomToFit = useCallback(() => {
    if (zoomDoneRef.current) return
    if (autoZoomToFitNow()) { zoomDoneRef.current = true; return }
  }, [autoZoomToFitNow])
  // Re-trigger when bodies arrive (binary WS frame processed), unless already done.
  useEffect(() => { if (!zoomDoneRef.current) autoZoomToFit() }, [bodies, autoZoomToFit])

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
    () => getBodiesToRender(bodies, features, rollbackPosition, visibleBodies),
    [bodies, features, rollbackPosition, visibleBodies]
  )

  // Show ALL pickBodies regardless of rollbackPosition -- these represent the body
  // state before entering edit mode, and the user needs to see every prior body to
  // pick faces/edges as references for the feature being edited.
  const pickBodyItems = useMemo(
    () => getBodiesToRender(pickBodies, features, undefined, visibleBodies),
    [pickBodies, features, visibleBodies]
  )

  const previewBodyItems = useMemo(() => {
    if (ghostMode) {
      return getBodiesToRender(bodies, features, undefined, visibleBodies)
    }
    return getPreviewBodies(bodies, features, rollbackPosition, visibleBodies)
  }, [bodies, features, rollbackPosition, visibleBodies, ghostMode])

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
          // Only clear selection if this was a left-click on empty space, not a camera drag.
          // Skip when the id-buffer dispatcher already consumed the click (e.g. dim label):
          // R3F sees no R3F handler on the dim label mesh post-267.3 and would otherwise
          // treat every label click as a miss.
          if (wasLastClickConsumedByIdDispatch()) return
          if (!wasPointerDrag.current && pointerDownButton.current === 0) {
            useSketchEditorStore.getState().clearNormalSelection()
            useSketchEditorStore.getState().setHoveredBodyId(null)
          }
        }}
      >
        <OrthographicCamera makeDefault position={INITIAL_POSITION} zoom={INITIAL_ZOOM} near={-10} far={1000} /* clipping planes */ />
        <SceneController resetTrigger={resetTrigger} canvasRef={canvasRef} pvRef={pvRef} hoverRef={hoverRef} snapRef={snapRef} cameraRef={cameraRef} />

        <IdPickingDriver onReady={onIdPipelineReady} />
        {showDebugHit && <IdDebugOverlay />}

        <CameraLight />

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
            return <UserDefinedPlane key={f.id} featureId={f.id} label={f.label || f.id} planeTransform={solveResult.plane_transform} size={planeSizes[f.id]} />
          })}

        {(() => {
          const sketchPlaneQuery = getActiveSketchPlane(activeFeatureId, features)
          if (!sketchPlaneQuery) return null

          const planeSize = calculatePlaneSize(
            undefined,
            bodies,
          ) || 100

          const sketchFeature = features?.find(f => f.id === activeFeatureId)
          const sketchLabel = sketchFeature?.label || activeFeatureId

          return <SketchPlaneDisplay key="sketch-plane" planeQuery={sketchPlaneQuery} size={planeSize} sketchLabel={sketchLabel} />
        })()}

        {activeSketchFeatures.map(f => {
          const solveResult = solveResults?.[f.id]
          const fullFeatureDef = featureDefs?.find(fd => fd.id === f.id) || f
          const sketch = solveResult?.solved ? solveResult.solved : unflattenGeometry(fullFeatureDef.initial || {}, fullFeatureDef.entities)
          const constraints = solveResult?.constraints ? solveResult.constraints : deriveConstraints(fullFeatureDef, sketch)
          const isActiveFeature = f.id === activeFeatureId
          return (
            <Geometry3D key={f.id} featureId={f.id} solved={sketch} entities={fullFeatureDef.entities} constraints={constraints} topology={solveResult?.topology} activeFeatureId={activeFeatureId} plane={fullFeatureDef.plane} planeTransform={solveResult?.plane_transform} solveStatus={solveResult?.status} entityStatus={solveResult?.features} showDebugHit={showDebugHit} otherSketches={isActiveFeature ? combinedOtherSketches : undefined} featureDef={fullFeatureDef} />
          )
        })}

        {ghostMode ? (
          <>
            {pickBodyItems.map(b => (
              <Body3D key={b.key} featureId={b.featureId} bodyId={b.bodyId} mesh={b.mesh} edges={b.edges} edgeQueries={b.edgeQueries} vertices={b.vertices} vertexQueries={b.vertexQueries} visible={b.visible} showDebugHit={showDebugHit} color={partColors?.[b.key]} transparency={partStyle?.[b.key]?.transparency ?? 0} metalness={partStyle?.[b.key]?.metalness ?? 0.3} interactive={!activeFeatureId} />
            ))}
            <PreviewEdgeOverlay items={previewBodyItems} pickItems={pickBodyItems} />
          </>
        ) : (
          bodyItems.map(b => (
            <Body3D key={b.key} featureId={b.featureId} bodyId={b.bodyId} mesh={b.mesh} edges={b.edges} edgeQueries={b.edgeQueries} vertices={b.vertices} vertexQueries={b.vertexQueries} visible={b.visible} showDebugHit={showDebugHit} color={partColors?.[b.key]} transparency={partStyle?.[b.key]?.transparency ?? 0} metalness={partStyle?.[b.key]?.metalness ?? 0.3} interactive={!activeFeatureId} />
          ))
        )}
      </Canvas>


<CubeGizmoCanvas canvasRef={canvasRef} pvRef={pvRef} hoverRef={hoverRef} snapRef={snapRef} cameraRef={cameraRef} />
      <ContextMenuDialog />
    </div>
  )
})
