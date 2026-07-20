import { useCallback, useEffect, useMemo, useRef, forwardRef, useImperativeHandle } from 'react'
import { Canvas } from '@react-three/fiber'
import { Environment } from '@react-three/drei'
import * as THREE from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import type { Feature, PartFeature, Sketch, BodyResult, PlaneDef } from '@/types/cad'
import { unflattenGeometry, deriveConstraints } from '@/utils/geometry/geometryMapping'
import Geometry3D from '@/components/Geometry3D'
import { CubeGizmoCanvas } from '@/components/misc/CubeGizmo'
import { type Hit, type Pv } from '@/components/misc/CubeGizmo.utils'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import Body3D from '@/components/Geometry3D/Body3D'
import PreviewEdgeOverlay from '@/components/Geometry3D/PreviewEdgeOverlay'
import OriginMarker from '@/components/Viewport/OriginMarker'
import FeatureHandles from '@/components/Viewport/FeatureHandles'
import ReferencePlane from '@/components/Viewport/ReferencePlane'
import SceneController from '@/components/Viewport/SceneController'
import { INITIAL_CAMERA } from '@/components/Viewport/cameraConstants'
import { fitToContent, alignToPlane, alignToFace, traceCamera } from '@/components/Viewport/cameraController'
import EnvLight, { ENV_INTENSITY } from '@/components/Viewport/EnvLight'
import { captureThumbnail } from '@/components/Viewport/captureThumbnail'
import UserDefinedPlane from '@/components/Viewport/UserDefinedPlane'
import { PlaneLabel, PlaneSurface } from '@/components/Viewport/PlaneVisual'
import ContextMenuDialog from '@/components/dialogs/ContextMenuDialog'
import {
  IdPickingDriver,
  DIMENSION_LABEL_LAYER_NAME,
  FEATURE_HANDLE_LAYER_NAME,
  FACE_LAYER_NAME,
  EDGE_LAYER_NAME,
  VERTEX_LAYER_NAME,
  PLANE_LAYER_NAME,
  SKETCH_ENTITY_LAYER_NAME,
  SKETCH_VERTEX_LAYER_NAME,
  ORIGIN_LAYER_NAME,
  SKETCH_SURFACE_LAYER_NAME,
} from '@/picking'
import IdDebugOverlay from '@/components/Viewport/IdDebugOverlay'
import type { IdPipeline } from '@/picking'
import {
  useIdBufferPointerDispatch,
  wasLastClickConsumedByIdDispatch,
  wasLastClickStaleResolve,
} from '@/components/Viewport/idDispatch/useIdBufferPointerDispatch'
import { useRubberBandSelect } from '@/components/Viewport/useRubberBandSelect'
import { DEFAULT_PART_ROUGHNESS } from '@/components/Geometry3D/constants'
import { createClickGestureTracker, isStationaryPrimaryClick } from '@/utils/clickGesture'
import { useSelectionPointerUpCleanup } from '@/components/interaction/useSelectionPointerUpCleanup'
import {
  getBodiesToRender,
  getSketchesToRender,
  getPreviewBodies,
  type BodyRenderItem,
} from '@/components/Viewport/bodyUtils'
import {
  buildBodySnapSketch,
  builtinPlaneTransform,
  BODY_SNAP_FEAT_PREFIX,
} from '@/components/Geometry3D/bodySnapProjection'
import type { SketchData } from '@/types/cad'

const ENABLE_ID_BUFFER_PICKING = true

// Stabilized props for the R3F Canvas. Inline objects would produce new
// references every Viewport render, forcing CanvasImpl to re-render needlessly.
const CANVAS_STYLE = { width: '100%', height: '100%', background: '#111' }
const CANVAS_GL = { antialias: true, logarithmicDepthBuffer: true }
const PARENT_STYLE: React.CSSProperties = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, touchAction: 'none' }

export interface ViewportProps {
  onRightClick?: (pos: [number, number]) => void
}

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

function getActiveSketchPlane(
  activeFeatureId: string | null | undefined,
  features: Feature[] | undefined,
): string | null {
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
  autoZoomToFit: (force?: boolean) => void
  cancelPendingFit: () => void
  alignCameraToPlane: (planeId: string) => void
  alignCameraToFace: (faceNormal: [number, number, number], faceCenter: [number, number, number]) => void
}

export default forwardRef<ViewportHandle, ViewportProps>(function Viewport({
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
  const controlsRef = useRef<OrbitControlsImpl | null>(null)
  const glRef = useRef<THREE.WebGLRenderer | null>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const bodiesRef = useRef<Record<string, BodyResult> | undefined>(undefined)
  // eslint-disable-next-line react-hooks/refs
  bodiesRef.current = bodies
  const idPipelineRef = useRef<IdPipeline | null>(null)
  const onIdPipelineReady = useCallback((p: IdPipeline) => { idPipelineRef.current = p }, [])

  // 267.2/267.4/267.5: canvas-level pointer dispatcher backed by the ID buffer.
  // Consumes dimensionLabel, B-rep face/edge/vertex, sketch, plane, and origin layers.
  const consumedLayers = useMemo(() => (ENABLE_ID_BUFFER_PICKING
    ? new Set([
      DIMENSION_LABEL_LAYER_NAME, FEATURE_HANDLE_LAYER_NAME,
      FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME,
      PLANE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME, ORIGIN_LAYER_NAME,
      SKETCH_SURFACE_LAYER_NAME,
    ])
    : new Set<string>()), [])
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

  const captureScreenshotForSaving = useCallback(
    (): Promise<string | null> => captureThumbnail(glRef.current, sceneRef.current, cameraRef.current),
    [],
  )

  // Auto-fit: frame a document's content once, when its geometry first becomes
  // available. `fitPending` is armed by autoZoomToFit() (called imperatively on
  // each document's first solve) and disarmed once fitToContent succeeds. Because
  // it is a re-armable intent, not a permanent latch, loading a second document
  // into the same Viewport re-fits. Camera-only; never mutates app state.
  const fitPendingRef = useRef(false)

  const tryFit = useCallback((force = false) => {
    if (!fitPendingRef.current) return
    // Don't auto-reframe while editing a sketch: rollback-driven body changes
    // during edit must not reposition the camera. Stays pending until edit ends.
    // `force` is the explicit Reset Viewport press: a deliberate user request
    // always reframes, even mid-edit.
    if (!force && usePartEditorStore.getState().activeSketchFeatureId) { traceCamera('fit:skip', 'editing sketch'); return }
    const camera = cameraRef.current as THREE.OrthographicCamera | null
    if (!camera) return
    // Geometry (binary) arrives after the JSON solve, so the first attempts may
    // find no bounds; stay pending and retry as `bodies` populate.
    if (fitToContent(camera, controlsRef.current, bodiesRef.current, sceneRef.current)) {
      fitPendingRef.current = false
      traceCamera('fit:done')
    }
  }, [])

  // Imperative: re-arm the fit for the current document and attempt immediately.
  // This is the single camera-framing entry point: Part.handleFirstSolve calls
  // it (unforced) on each document's first solve, and the Reset Viewport button
  // calls it with force=true to reframe on demand. Guards (editing / no
  // geometry yet) live in tryFit, so a stale or mid-edit unforced call is
  // harmless.
  const autoZoomToFit = useCallback((force = false) => {
    traceCamera('fit:request', 'force=', force)
    fitPendingRef.current = true
    tryFit(force)
  }, [tryFit])

  // Re-attempt only as bodies arrive: the initial (first-solve) fit retries
  // here as geometry populates. We deliberately do NOT react to edit-state
  // (activeFeatureId) changes: a fit must only land for the initial solve or
  // the manual Reset Viewport button, never on edit-exit, undo, or any other
  // solve. tryFit no-ops unless a fit is armed, so steady-state solves are inert.
  useEffect(() => {
    tryFit()
  }, [bodies, tryFit])

  // Disarm any pending (deferred) fit so a subsequent doc/body change cannot
  // reframe the camera. Undo/redo use this: undo exits the active sketch edit,
  // which would otherwise let a fit deferred during the edit land and move the
  // camera. Undo/redo must never change the camera.
  const cancelPendingFit = useCallback(() => {
    if (fitPendingRef.current) traceCamera('fit:cancel')
    fitPendingRef.current = false
  }, [])

  const alignCameraToPlane = useCallback((planeId: string) => {
    const camera = cameraRef.current as THREE.OrthographicCamera | null
    if (!camera) return
    alignToPlane(camera, controlsRef.current, planeId)
  }, [cameraRef])

  const alignCameraToFace = useCallback(
    (faceNormal: [number, number, number], faceCenter: [number, number, number]) => {
      const camera = cameraRef.current as THREE.OrthographicCamera | null
      if (!camera) return
      alignToFace(camera, controlsRef.current, faceNormal, faceCenter)
    },
    [cameraRef],
  )

  useImperativeHandle(
    ref,
    () => ({
      captureScreenshot,
      captureScreenshotForSaving,
      autoZoomToFit,
      cancelPendingFit,
      alignCameraToPlane,
      alignCameraToFace,
    }),
    [captureScreenshot, captureScreenshotForSaving, autoZoomToFit, cancelPendingFit, alignCameraToPlane, alignCameraToFace],
  )

  const closeContextMenu = useSketchEditorStore(s => s.closeContextMenu)

  // Which button opened the gesture and how far it travelled. Shared with the
  // assembly viewport (utils/clickGesture) so the two editors can never disagree
  // about what counts as a click and what counts as a camera drag.
  const clickGesture = useRef(createClickGestureTracker())

  // Layer 3B: clear isPointerDown on any pointer-up (including off-canvas releases).
  useSelectionPointerUpCleanup()

  // 268: rubber-band drag-box selection on empty canvas space.
  const rubberBand = useRubberBandSelect(glRef)

  const onPointerMissed = useCallback(() => {
    if (wasLastClickConsumedByIdDispatch()) return
    if (wasLastClickStaleResolve()) return
    if (rubberBand.state.isDraggingRef.current) return
    if (isStationaryPrimaryClick(clickGesture.current.state)) {
      useSketchEditorStore.getState().clearNormalSelection()
    }
  }, [rubberBand])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!e.isPrimary) return  // Ignore non-primary pointers (multi-touch)
    clickGesture.current.down(e.button, e.clientX, e.clientY)
    if (e.button !== 2) closeContextMenu()

    // 268: attempt rubber-band on left-click in empty space.
    if (e.button === 0) {
      const s = useSketchEditorStore.getState()
      const hasHover = s.hoveredSelectionId
        || s.hoveredVertexId
        || s.hoveredConstraintEntityIds.size > 0
      if (!hasHover) {
        const currentTool = s.activeTool
        // Only start rubber-band for non-drawing tools (null, select, drag, dimension).
        if (!currentTool || currentTool === 'select' || currentTool === 'drag' || currentTool === 'dimension') {
          const started = rubberBand.onPointerDown(e, false)
          // If started (no hit), don't prevent default — let pointer-up determine click vs drag.
          void started
        }
      }
    }
  }, [closeContextMenu, rubberBand])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!e.isPrimary) return  // Ignore non-primary pointers (multi-touch)
    const hadDown = clickGesture.current.state.origin !== null
    const click = clickGesture.current.up(e.clientX, e.clientY)
    // A release with no matching press (the gesture started outside the pane)
    // owns neither the rubber band nor the context menu.
    if (!hadDown) return

    // Always commit or cancel the rubber-band so it never stays sticky after release.
    rubberBand.onPointerUp()

    if (click.wasDrag) return

    if (e.button === 2 && onRightClick) {
      onRightClick([e.clientX, e.clientY])
    }
  }, [onRightClick, rubberBand])

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

    // Resolve plane transform: kernel-provided or derived from builtin plane string.
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

  // Latch the travel as it happens, then hand the move on to the rubber band. An
  // orbit that swings out and returns near its start would otherwise read as a
  // stationary click when only the two end points are compared.
  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    clickGesture.current.move(e.clientX, e.clientY)
    rubberBand.onPointerMove(e)
  }, [rubberBand])

  const handleContextMenu = useCallback((e: React.MouseEvent) => { e.preventDefault() }, [])

  const renderBodyItem = (b: BodyRenderItem) => (
    <Body3D
      key={b.key}
      featureId={b.featureId}
      bodyId={b.bodyId}
      mesh={b.mesh}
      edges={b.edges}
      edgeQueries={b.edgeQueries}
      vertices={b.vertices}
      vertexQueries={b.vertexQueries}
      visible={b.visible}
      showDebugHit={showDebugHit}
      color={partColors?.[b.key]}
      transparency={partStyle?.[b.key]?.transparency ?? 0}
      roughness={partStyle?.[b.key]?.roughness ?? DEFAULT_PART_ROUGHNESS}
      metalness={partStyle?.[b.key]?.metalness ?? 0}
      transmission={partStyle?.[b.key]?.transmission ?? 0}
    />
  )

  return (
    <div
      style={PARENT_STYLE}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerMove={handlePointerMove}
      onContextMenu={handleContextMenu}
    >
      <Canvas
        orthographic
        camera={INITIAL_CAMERA}
        style={CANVAS_STYLE}
        gl={CANVAS_GL}
        onCreated={onCreated}
        onPointerMissed={onPointerMissed}
      >
        <SceneController
          key="scene-ctrl"
          canvasRef={canvasRef}
          pvRef={pvRef}
          hoverRef={hoverRef}
          snapRef={snapRef}
          cameraRef={cameraRef}
          controlsRef={controlsRef}
        />

        {ENABLE_ID_BUFFER_PICKING && <IdPickingDriver onReady={onIdPipelineReady} />}
        {showDebugHit && <IdDebugOverlay />}

        <Environment files="/env.hdr" background={false} environmentIntensity={ENV_INTENSITY} />
        <EnvLight />

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
            return (
              <UserDefinedPlane
                key={f.id}
                featureId={f.id}
                label={f.label || f.id}
                planeTransform={solveResult.plane_transform}
                size={planeSizes[f.id]}
              />
            )
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

          return (
            <SketchPlaneDisplay
              key="sketch-plane"
              planeQuery={sketchPlaneQuery}
              size={planeSize}
              sketchLabel={sketchLabel}
            />
          )
        })()}

        {activeSketchFeatures.map(f => {
          const solveResult = solveResults?.[f.id]
          const fullFeatureDef = featureDefs?.find(fd => fd.id === f.id) || f
          const sketch = solveResult?.solved ? solveResult.solved : unflattenGeometry(fullFeatureDef.initial || {}, fullFeatureDef.entities)
          const constraints = solveResult?.constraints ? solveResult.constraints : deriveConstraints(fullFeatureDef, sketch)
          const isActiveFeature = f.id === activeFeatureId
          return (
            <Geometry3D
              key={f.id}
              featureId={f.id}
              solved={sketch}
              entities={fullFeatureDef.entities}
              constraints={constraints}
              topology={solveResult?.topology}
              activeFeatureId={activeFeatureId}
              plane={fullFeatureDef.plane}
              planeTransform={solveResult?.plane_transform}
              originLocal={solveResult?.originLocal}
              solveStatus={solveResult?.status}
              entityStatus={solveResult?.features}
              showDebugHit={showDebugHit}
              otherSketches={isActiveFeature ? combinedOtherSketches : undefined}
              featureDef={fullFeatureDef}
            />
          )
        })}

        {ghostMode ? (
          <>
            {pickBodyItems.map(renderBodyItem)}
            <PreviewEdgeOverlay items={previewBodyItems} pickItems={pickBodyItems} />
          </>
        ) : (
          bodyItems.map(renderBodyItem)
        )}

        {/* Draggable editing arrow for the feature open in the editor panel. */}
        <FeatureHandles />
      </Canvas>

      {/* 268: rubber-band drag-box selection overlay */}
      {rubberBand.state.dragging && rubberBand.state.rect && (
        <div style={(() => {
          const color = rubberBand.state.rect.mode === 'window' ? '#4fc3f7' : '#81c784'
          const fill  = rubberBand.state.rect.mode === 'window' ? 'rgba(79,195,247,0.08)' : 'rgba(129,199,132,0.08)'
          // CSS `dashed` has no length control; use background gradients for custom dash size.
          const dash = `${color} 0, ${color} 5px, transparent 5px, transparent 8px`
          return {
            position: 'absolute' as const,
            left: rubberBand.state.rect.x,
            top: rubberBand.state.rect.y,
            width: rubberBand.state.rect.w,
            height: rubberBand.state.rect.h,
            backgroundImage: [
              `repeating-linear-gradient(90deg, ${dash})`,
              `repeating-linear-gradient(90deg, ${dash})`,
              `repeating-linear-gradient(0deg,  ${dash})`,
              `repeating-linear-gradient(0deg,  ${dash})`,
            ].join(', '),
            backgroundSize: '8px 1px, 8px 1px, 1px 8px, 1px 8px',
            backgroundPosition: '0 0, 0 100%, 0 0, 100% 0',
            backgroundRepeat: 'repeat-x, repeat-x, repeat-y, repeat-y',
            backgroundColor: fill,
            pointerEvents: 'none' as const,
            zIndex: 10,
          }
        })()} />
      )}

      <CubeGizmoCanvas
        canvasRef={canvasRef}
        pvRef={pvRef}
        hoverRef={hoverRef}
        snapRef={snapRef}
        cameraRef={cameraRef}
      />
      <ContextMenuDialog />
    </div>
  )
})
