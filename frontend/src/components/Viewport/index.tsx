import { useCallback, useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle, Suspense } from 'react'
import type { ReactNode } from 'react'
import { Canvas } from '@react-three/fiber'
import { Environment } from '@react-three/drei'
import * as THREE from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import type { Feature, PartFeature, Sketch, BodyResult, PlaneDef } from '@/types/cad'
import { unflattenGeometry, deriveConstraints } from '@/utils/geometry/geometryMapping'
import Geometry3D from '@/components/Geometry3D'
import { CubeGizmoCanvas } from '@/components/misc/CubeGizmo'
import '@/components/Viewport/ViewportHud.css'
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
import { DEFAULT_PLANE_SIZE } from '@/components/Viewport/planeConstants'
import { BUILTIN_PLANE_ROTATIONS } from '@/utils/builtinPlanes'
import { calculatePlaneSize, getActiveSketchPlane } from '@/components/Viewport/viewportPlaneSizing'
import { SketchPlaneDisplay } from '@/components/Viewport/SketchPlaneDisplay'
import ContextMenuDialog from '@/components/dialogs/ContextMenuDialog'
import { IdPickingDriver } from '@/picking'
import IdDebugOverlay from '@/components/Viewport/IdDebugOverlay'
import IdPickReadout from '@/components/Viewport/IdPickReadout'
import type { IdPipeline } from '@/picking'
import {
  PART_EDITOR_CONSUMED_LAYERS,
  useIdBufferPointerDispatch,
  wasLastClickConsumedByIdDispatch,
  wasLastClickStaleResolve,
  setLastClickStationaryPrimary,
  setLastClickBandDragging,
} from '@/components/Viewport/idDispatch/useIdBufferPointerDispatch'
import { clearAllHover } from '@/components/Viewport/idDispatch/brepAdapters'
import { useRubberBandSelect } from '@/components/Viewport/useRubberBandSelect'
import { shouldOpenRubberBand } from '@/components/Viewport/bandStartPolicy'
import { missClearsNormalSelection } from '@/components/Viewport/emptyClickClear'
import { DEFAULT_PART_ROUGHNESS } from '@/components/Geometry3D/constants'
import { createClickGestureTracker, isStationaryPrimaryClick } from '@/utils/clickGesture'
import { useSelectionPointerUpCleanup } from '@/components/interaction/useSelectionPointerUpCleanup'
import { useDrawToolClickGuardCleanup } from '@/components/Viewport/idDispatch/drawToolClickGuard'
import { useBandClickGuardCleanup } from '@/components/Viewport/idDispatch/bandClickGuard'
import {
  getBodiesToRender,
  getGhostBodiesToRender,
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

// Stabilized props for the R3F Canvas. Inline objects would produce new
// references every Viewport render, forcing CanvasImpl to re-render needlessly.
const CANVAS_STYLE = { width: '100%', height: '100%', background: '#111' }
const CANVAS_GL = { antialias: true, logarithmicDepthBuffer: true }
// `isolation: isolate` makes this div a stacking context, which pens every
// overlay drei portals next to the canvas inside the viewport. drei hands each
// `<Html>` a z-index interpolated over its default range -- up to ~16.8 million
// at the near plane -- so without the pen the constraint tiles (Constraints.tsx)
// and dimension labels (DimensionLabel.tsx) outrank the app's dialogs (9999)
// and paint over them, the closer to the camera the more reliably.
const PARENT_STYLE: React.CSSProperties = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, touchAction: 'none', isolation: 'isolate' }

export interface ViewportProps {
  onRightClick?: (pos: [number, number]) => void
  // Bottom-right overlay content, stacked under the orientation cube (the
  // measurement readout). A node rather than a fixed component so the part and
  // assembly editors can each hand in their own readout.
  hud?: ReactNode
}

// eslint-disable-next-line react-refresh/only-export-components -- test-only pure helper exported alongside the component for direct unit tests
export function isActive(
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

export interface ViewportHandle {
  captureScreenshotForSaving: () => Promise<string | null>
  autoZoomToFit: (force?: boolean) => void
  cancelPendingFit: () => void
  alignCameraToPlane: (planeId: string) => void
  alignCameraToFace: (faceNormal: [number, number, number], faceCenter: [number, number, number]) => void
}

export default forwardRef<ViewportHandle, ViewportProps>(function Viewport({
  onRightClick,
  hud,
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
  // eslint-disable-next-line react-hooks/refs -- mirror latest bodies into a ref for use inside stable callbacks
  bodiesRef.current = bodies
  const idPipelineRef = useRef<IdPipeline | null>(null)
  const onIdPipelineReady = useCallback((p: IdPipeline) => { idPipelineRef.current = p }, [])

  // 267.2/267.4/267.5: canvas-level pointer dispatcher backed by the ID buffer.
  // Consumes dimensionLabel, B-rep face/edge/vertex, sketch, plane, and origin
  // layers (the shared PART_EDITOR_CONSUMED_LAYERS set).
  const consumedLayers = PART_EDITOR_CONSUMED_LAYERS
  const clearIdBufferHover = useIdBufferPointerDispatch({ glRef, consumedLayers })

  // Bumped when the scene-side prerequisites of a fit become live (the
  // Canvas-owned camera via SceneController, gl/scene via onCreated). R3F
  // renders the scene tree on a later frame than this component's mount, so a
  // fit armed by a warm second-document first solve can fire while the camera
  // is still absent -- tryFit then stays pending, and without this tick the
  // only retry (a bodies change) has already fired and never fires again.
  // The two sources must stay separate: onCreated fires before the scene tree
  // in R3F, so the camera arrival is usually the later event and must not be
  // swallowed by a shared one-shot. onSceneReady needs no latch of its own --
  // it is called from scene-tree effects (never mid-render) and is one-shot
  // per instance inside SceneController.
  const [sceneTick, setSceneTick] = useState(0)
  const onSceneReady = useCallback(() => setSceneTick(t => t + 1), [])

  const createdLiveRef = useRef(false)
  const onCreated = useCallback((state: { gl: THREE.WebGLRenderer; scene: THREE.Scene }) => {
    glRef.current = state.gl
    sceneRef.current = state.scene
    // Rides the same readiness tick as the scene camera: tryFit's
    // empty-document fallback reads sceneRef, so its availability must also
    // re-attempt a fit that was armed before the Canvas had rendered. Latched:
    // a caller may invoke onCreated while rendering, and re-entering setState
    // from there would loop renders.
    if (createdLiveRef.current) return
    createdLiveRef.current = true
    setSceneTick(t => t + 1)
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

  // Re-attempt only as bodies arrive or as the scene becomes live: the initial
  // (first-solve) fit retries here as geometry populates AND when the
  // Canvas-owned camera appears (sceneTick), because a warm second-document
  // solve can arm the fit before the scene tree has ever rendered. We
  // deliberately do NOT react to edit-state (activeFeatureId) changes: a fit
  // must only land for the initial solve or the manual Reset Viewport button,
  // never on edit-exit, undo, or any other solve. tryFit no-ops unless a fit is
  // armed, so steady-state solves are inert.
  useEffect(() => {
    tryFit()
  }, [bodies, sceneTick, tryFit])

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
      captureScreenshotForSaving,
      autoZoomToFit,
      cancelPendingFit,
      alignCameraToPlane,
      alignCameraToFace,
    }),
    [captureScreenshotForSaving, autoZoomToFit, cancelPendingFit, alignCameraToPlane, alignCameraToFace],
  )

  const closeContextMenu = useSketchEditorStore(s => s.closeContextMenu)

  // Which button opened the gesture and how far it travelled. Shared with the
  // assembly viewport (utils/clickGesture) so the two editors can never disagree
  // about what counts as a click and what counts as a camera drag.
  const clickGesture = useRef(createClickGestureTracker())

  // Layer 3B: clear isPointerDown on any pointer-up (including off-canvas releases).
  useSelectionPointerUpCleanup()

  // Layer 3C: clear a stale draw-tool click-consumed flag when a gesture ends
  // without ever producing a click on the canvas (see drawToolClickGuard.ts).
  useDrawToolClickGuardCleanup()

  // Same hygiene for the band guard: a teardown no click follows (cancel,
  // stranded release) must not eat the next gesture's click.
  useBandClickGuardCleanup()

  // 268: rubber-band drag-box selection on empty canvas space. Shares the
  // dispatcher's consumedLayers so a sweep never collects a layer the editor
  // does not consume.
  const rubberBand = useRubberBandSelect(glRef, consumedLayers)

  const onPointerMissed = useCallback(() => {
    if (missClearsNormalSelection({
      clickConsumedByIdDispatch: wasLastClickConsumedByIdDispatch(),
      clickWasStaleResolve: wasLastClickStaleResolve(),
      bandDragging: rubberBand.state.isDraggingRef.current,
      stationaryPrimaryClick: isStationaryPrimaryClick(clickGesture.current.state),
    })) {
      useSketchEditorStore.getState().clearNormalSelection()
    }
  }, [rubberBand])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!e.isPrimary) return  // Ignore non-primary pointers (multi-touch)
    clickGesture.current.down(e.pointerId, e.button, e.clientX, e.clientY)
    if (e.button !== 2) closeContextMenu()

    // 268: attempt rubber-band on left-click in empty space.
    if (e.button === 0) {
      const s = useSketchEditorStore.getState()
      const hasHover = !!(s.hoveredSelectionId
        || s.hoveredVertexId
        || s.hoveredConstraintEntityIds.size > 0)
      // The band gate is a pure decision (bandStartPolicy) so the dimension
      // placement case is unit tested away from the Viewport. A pending
      // dimension pick means the next empty-space click finalises the
      // dimension; opening a box there would swallow that click (bandClickGuard)
      // and replace the selection, so the pane must not start a band then.
      if (shouldOpenRubberBand({
        activeTool: s.activeTool,
        dimensionPickCount: s.dimensionPicks.length,
        hasHover,
      })) {
        // Capture is NOT taken here. Everything interactive in this pane -- the R3F
        // event source, the id-buffer canvas, the cube gizmo overlay -- is a
        // descendant, so capturing on press retargets the whole gesture and its
        // trailing click onto this div and starves all of them. A stationary press is
        // an ordinary click and must keep its own target; the band takes capture on
        // the move that first opens a box instead (handlePointerMove).
        rubberBand.onPointerDown(e)
      }
    }
  }, [closeContextMenu, rubberBand])

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if (!e.isPrimary) return  // Ignore non-primary pointers (multi-touch)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    const hadDown = clickGesture.current.state.origin !== null
    const click = clickGesture.current.up(e.pointerId, e.clientX, e.clientY)
    // A release with no matching press (the gesture started outside the pane)
    // owns neither the rubber band nor the context menu.
    if (!hadDown) return

    // Read the rubber-band drag flag BEFORE teardown: onPointerUp runs endDrag
    // synchronously and clears the ref, so reading after it would always be false.
    const bandWasDragging = rubberBand.state.isDraggingRef.current

    // Always commit or cancel the rubber-band so it never stays sticky after release.
    rubberBand.onPointerUp()

    // Publish the two halves of the miss-clear predicate the backplane path
    // cannot read for itself. The Canvas `onPointerMissed` path reads these same
    // facts from live refs; both paths must reach the identical predicate so a
    // click that clears in one clears in the other.
    setLastClickStationaryPrimary(isStationaryPrimaryClick(click))
    setLastClickBandDragging(bandWasDragging)

    if (click.wasDrag) return

    if (e.button === 2 && onRightClick) {
      onRightClick([e.clientX, e.clientY])
    }
  }, [onRightClick, rubberBand])

  // The browser tore the gesture away (a touch became a scroll, the pointer
  // was lost): no pointer-up will follow, so drop the band and the click
  // gesture here or a stale origin would pair with the NEXT release.
  const handlePointerCancel = useCallback((e: React.PointerEvent) => {
    if (!e.isPrimary) return  // a secondary pointer going away owns no part of the primary gesture
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    clickGesture.current.reset()
    rubberBand.onPointerCancel()
    // No click follows a cancel: the backplane must not treat a lost gesture as
    // empty-space deselect.
    setLastClickStationaryPrimary(false)
    setLastClickBandDragging(false)
  }, [rubberBand])

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
  // pick faces/edges as references for the feature being edited. Bodies the edit
  // removes stay, marked doomed (see getGhostBodiesToRender).
  const pickBodyItems = useMemo(
    () => getGhostBodiesToRender(pickBodies, bodies, features, partStyle),
    [pickBodies, bodies, features, partStyle]
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
    // The pointer id rides along: a second finger's move must not latch the
    // primary gesture's click tracker (utils/clickGesture guards on it).
    clickGesture.current.move(e.pointerId, e.clientX, e.clientY)
    // The box just opened: from here on the gesture belongs to the band, and
    // capture is what delivers its release even if it lands off-pane.
    if (rubberBand.onPointerMove(e)) e.currentTarget.setPointerCapture(e.pointerId)
  }, [rubberBand])

  // Pointer-leave must tear the hover down: the id-buffer dispatch hook only
  // listens for move/down/click, so a stale hover would otherwise block the
  // rubber-band start on re-entry and offer "Normal to" for a face the pointer
  // is no longer over. Same teardown the assembly viewport applies. Beyond the
  // store clear, clearIdBufferHover also invalidates the dispatcher's own
  // in-flight GPU-readback resolve: without it, a hover resolve already
  // launched before the pointer left can land a frame later and redraw the
  // highlight the leave was meant to clear.
  const handlePointerLeave = useCallback(() => {
    clearAllHover()
    clearIdBufferHover()
  }, [clearIdBufferHover])

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
      color={partColors?.[b.key]}
      transparency={partStyle?.[b.key]?.transparency ?? 0}
      roughness={partStyle?.[b.key]?.roughness ?? DEFAULT_PART_ROUGHNESS}
      metalness={partStyle?.[b.key]?.metalness ?? 0}
      transmission={partStyle?.[b.key]?.transmission ?? 0}
      doomed={b.doomed}
    />
  )

  return (
    <div
      style={PARENT_STYLE}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerMove={handlePointerMove}
      onPointerCancel={handlePointerCancel}
      onPointerLeave={handlePointerLeave}
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
          gizmoCanvasRef={canvasRef}
          pvRef={pvRef}
          hoverRef={hoverRef}
          snapRef={snapRef}
          cameraRef={cameraRef}
          controlsRef={controlsRef}
          onReady={onSceneReady}
        />

        <IdPickingDriver onReady={onIdPipelineReady} />
        {showDebugHit && <IdDebugOverlay />}

        {/* Local boundary so the 1.47 MB HDR no longer hides and re-shows the
            entire Canvas subtree (which destroys and recreates the IdPipeline on
            every cold new-tab reveal). Mirrors PlaneVisual's <Text> boundary. */}
        <Suspense fallback={null}>
          <Environment files={`${import.meta.env.BASE_URL}env.hdr`} background={false} environmentIntensity={ENV_INTENSITY} />
        </Suspense>
        <EnvLight />

        {showOrigin && <OriginMarker />}
        {showFront  && <ReferencePlane rotation={BUILTIN_PLANE_ROTATIONS.builtin_plane_front} label="Front" />}
        {showTop    && <ReferencePlane rotation={BUILTIN_PLANE_ROTATIONS.builtin_plane_top} label="Top" />}
        {showRight  && <ReferencePlane rotation={BUILTIN_PLANE_ROTATIONS.builtin_plane_right} label="Right" />}

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

          // The active sketch plane has no sized geometry behind it, so it uses
          // the shared default rather than the model-extent path.
          const planeSize = DEFAULT_PLANE_SIZE

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

      {/* Reads the pick pass in words while the collision debug view is on:
          which entities the cursor's disc actually covers, in the order the
          click would take them. The buffer overlay can only show that a mark
          exists, not which entity it is. */}
      {showDebugHit && <IdPickReadout glRef={glRef} />}

      {/* 268: rubber-band drag-box selection overlay. A box is crossing-only;
          the window-mode styling and its mode branch were deleted with the
          dead window selection path. */}
      {rubberBand.state.dragging && rubberBand.state.rect && (
        <div style={(() => {
          const color = '#81c784'
          const fill  = 'rgba(129,199,132,0.08)'
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

      <div className="viewport-hud">
        <CubeGizmoCanvas
          canvasRef={canvasRef}
          pvRef={pvRef}
          hoverRef={hoverRef}
          snapRef={snapRef}
          cameraRef={cameraRef}
        />
        <div className="viewport-hud-readout">{hud}</div>
      </div>
      <ContextMenuDialog />
    </div>
  )
})
