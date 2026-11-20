import { useRef, useEffect } from 'react'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { useSketchEditorStore, useSketchUiStore, getSketchCallback } from '@/stores/sketchEditorStore'
import { toolRegistry, isDrawingTool } from '@/registry/toolRegistry'
import { sanitizePointerEvent } from '@/components/Geometry3D/pointerAbstractionAdapters'
import { projectCursorToSketchPlane } from '@/components/Geometry3D/dragMathPlane'
import { Dot } from '@/components/Geometry3D/VertexDots'
import { DashedLine } from '@/components/Geometry3D/dimensions'
import { COLOR_PREVIEW } from '@/components/Geometry3D/constants'
import { useAlignmentSnapEffect, toolTakesAlignmentSnap } from '@/components/interaction/useAlignmentSnapEffect'
import { failLoud } from '@/stores/stateInvariants'
import type { Sketch } from '@/types/cad'
import type { DrawingToolContext } from '@/tools/DrawingTool'
import { computePreviewPts } from '@/utils/geometry/drawGeometry'
import { resolveDrawCursor } from '@/utils/geometry/drawLogic'
import { resolveDrawPressSnap } from '@/utils/geometry/drawPressSnap'
import { markDrawToolClickConsumed } from '@/components/Viewport/idDispatch/drawToolClickGuard'
import { shouldClearSelectionOnBackplaneClick, resolvePickAtEvent, PART_EDITOR_CONSUMED_LAYERS } from '@/components/Viewport/idDispatch/useIdBufferPointerDispatch'
import { findEdgeKindForQuery, findFaceBoundaryEdges } from '@/picking/partDispatchCallbacks'
import { effectiveAllowedLayers } from '@/registry/toolPickConfig'

// Secondary (bit 2) or middle (bit 4) mouse button held: a camera/navigation
// gesture, not a draw hover. Back/forward buttons are not draw gestures either.
const NAV_BUTTONS = 6

/** World length of one screen pixel on the sketch plane, or null when the
 *  camera carries no distance-free scale. The draw snap gate needs it to stay
 *  a screen-space reach instead of a fixed document tolerance. */
function screenPixelSize(camera: THREE.Camera | null | undefined): number | null {
  if (!camera) return null
  const ortho = camera as THREE.OrthographicCamera
  if (!ortho.isOrthographicCamera || !Number.isFinite(ortho.zoom) || ortho.zoom === 0) return null
  return 1 / ortho.zoom
}

export function DrawPreview({ featureId, activeFeatureId, sketch, otherSketches }: {
  featureId?: string
  activeFeatureId?: string
  // The same geometry DrawPlane hands the commit, so a curve snap finds the
  // same foot in the preview as on click.
  sketch?: Sketch
  otherSketches?: Record<string, Sketch>
}) {
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const effectiveTool = activeTool ?? 'drag'
  const drawPoints = useSketchEditorStore(s => s.drawPoints)
  const drawHover = useSketchEditorStore(s => s.drawHover)
  const alignmentSnapPoint = useSketchEditorStore(s => s.alignmentSnapPoint)
  const alignmentSnapKind = useSketchEditorStore(s => s.alignmentSnapKind)
  const ngonSides = useSketchUiStore(s => s.ngonSides)
  const hoveredVertexId = useSketchEditorStore(s => s.hoveredVertexId)
  const hoveredVertexPosition = useSketchEditorStore(s => s.hoveredVertexPosition)
  const hoveredSnapKind = useSketchEditorStore(s => s.hoveredSnapKind)
  const hoveredSelectionId = useSketchEditorStore(s => s.hoveredSelectionId)
  const drawSnapRefs = useSketchEditorStore(s => s.drawSnapRefs)
  const { camera } = useThree()

  if (activeFeatureId === null) return null
  // The preview lives inside each sketch's transformed group; only the active
  // sketch may draw it, else other visible sketches double-render it on their
  // own planes (the draw cursor lives in the active sketch's local space).
  if (featureId !== activeFeatureId) return null
  // Only a drawing tool owns draw state; idle select (activeTool null resolves
  // to 'drag') and dimension/drag render nothing here.
  if (!isDrawingTool(effectiveTool)) return null

  // Draw to where the click would commit, not to the raw cursor, so the
  // preview does not jump when a snap moves the committed point.
  // The same screen-scaled vertex gate the press uses, so a hover the pointer
  // already left cannot make the preview promise a snap the click will not make.
  const cursor = drawHover && resolveDrawCursor(effectiveTool, drawPoints, drawHover, {
    hoveredVertexId, hoveredVertexPosition, hoveredSnapKind, hoveredSelectionId,
    drawSnapRefs, alignmentSnapPoint, alignmentSnapKind, ngonSides,
    pixelSize: screenPixelSize(camera),
  }, sketch, otherSketches)
  const previewPts = computePreviewPts(effectiveTool, drawPoints, cursor, ngonSides)
  // The alignment guide runs from its anchor to the cursor it measured.
  const endpoint = drawHover

  return (
    <>
      {drawPoints.map((pt, i) => (
        <Dot key={i} x={pt[0]} y={pt[1]} px={4} color={COLOR_PREVIEW} billboard />
      ))}
      {cursor && effectiveTool === 'point' && (
        <Dot x={cursor[0]} y={cursor[1]} px={4} color={COLOR_PREVIEW} billboard />
      )}
      {previewPts && <Line points={previewPts} color={COLOR_PREVIEW} lineWidth={1} />}
      {alignmentSnapPoint && endpoint && alignmentSnapKind && (
        <DashedLine
          points={[
            [alignmentSnapPoint[0], alignmentSnapPoint[1], 0],
            [endpoint[0], endpoint[1], 0],
          ]}
          color={COLOR_PREVIEW}
          lineWidth={1}
        />
      )}
    </>
  )
}

export function DrawPlane({ featureId, activeFeatureId, sketch, sketchGroupRef, otherSketches }: {
  featureId: string
  activeFeatureId?: string
  sketch?: Sketch
  sketchGroupRef?: React.RefObject<THREE.Group | null>
  otherSketches?: Record<string, Sketch>
}) {
  const meshRef = useRef<THREE.Mesh>(null)
  // Double-click sequencing: the first press of the double click may already
  // have completed the gesture and cleared the buffer, so the second press
  // starts a fresh one. `onDoubleClick` then sees a one-point gesture that must
  // not be left staged (a stray preview dot Enter cannot finish).
  const previousPressFinishedRef = useRef(false)
  const pressAfterFinishRef = useRef(false)
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const effectiveTool = activeTool ?? 'drag'
  const drawPoints = useSketchEditorStore(s => s.drawPoints)
  const setDrawHover = useSketchEditorStore(s => s.setDrawHover)
  const dimensionPicks = useSketchEditorStore(s => s.dimensionPicks)
  const setDimensionCursorWorld = useSketchEditorStore(s => s.setDimensionCursorWorld)
  const clearDraw = useSketchEditorStore(s => s.clearDraw)
  const onMutation = getSketchCallback('onMutation')
  const onMutationBatch = getSketchCallback('onMutationBatch')
  const clearNormalSelection = useSketchEditorStore(s => s.clearNormalSelection)
  const drawHover = useSketchEditorStore(s => s.drawHover)
  const hoveredVertexId = useSketchEditorStore(s => s.hoveredVertexId)
  const { camera, gl } = useThree()

  const drawLastPoint = drawPoints.length > 0 ? drawPoints[drawPoints.length - 1] : null
  // A named vertex beats the axis in the commit, so the guide would promise a
  // snap the click never makes. The rule is the commit's, not a second copy:
  // only hand the effect a cursor when no vertex owns the point.
  const alignmentCursor = toolTakesAlignmentSnap(effectiveTool) && hoveredVertexId === null
    ? drawHover
    : null
  useAlignmentSnapEffect(alignmentCursor, drawLastPoint)

  // Resolve the sketch group ref: prefer explicit prop, fall back to mesh parent.
  const resolvedGroupRef: React.RefObject<THREE.Object3D | null> = sketchGroupRef ?? {
    get current() { return meshRef.current?.parent ?? null },
  }

  // Window-level pointermove: bypasses R3F event bubbling so Part3D/Surfaces meshes
  // cannot block the draw hover cursor. The handler ref is updated every render so the
  // closure always captures fresh props/derived values without effect dependency issues.
  // meshRef is only attached in drawing-tool mode; when null the handler is a no-op.
  const handleDrawMoveRef = useRef<((e: PointerEvent) => void) | null>(null)
  handleDrawMoveRef.current = (e: PointerEvent) => {
    const group = resolvedGroupRef.current
    if (!group) return
    // Every visible sketch mounts a DrawPlane, but only the active sketch's
    // plane owns the draw cursor: an inactive plane would project the cursor
    // onto its own plane and overwrite the active hover. Mirrors the render
    // guard below and DrawPreview's active-feature guard.
    if (featureId !== activeFeatureId) return
    if (e.buttons & NAV_BUTTONS) { setDrawHover(null); return }

    // Live canvas bounds: not cached so sidebar resizes are reflected immediately.
    const rect = gl.domElement.getBoundingClientRect()
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1
    const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1

    // Math-plane projection -- no scene mesh involved, so no other geometry
    // can block the raycast. Replaces the former raycaster.intersectObject(mesh) pattern.
    const worldPt = projectCursorToSketchPlane(camera, group, { x: ndcX, y: ndcY })
    if (!worldPt) {
      setDrawHover(null)
      if (dimensionPicks.length > 0) setDimensionCursorWorld(null)
      return
    }
    const sanitized = sanitizePointerEvent({ point: worldPt, clientX: e.clientX, clientY: e.clientY }, resolvedGroupRef)
    setDrawHover(sanitized?.localPoint ?? null)
    // Mirror the cursor world point for the dimension-placement gesture so the
    // empty-click finalize can write `pos` at exactly where the user clicked.
    if (effectiveTool === 'dimension' && dimensionPicks.length > 0 && sanitized?.localPoint) {
      setDimensionCursorWorld(sanitized.localPoint)
    }
  }

  // Only the active sketch registers the window listener. Every visible sketch
  // mounts a DrawPlane, so registering for all of them stacked N listeners
  // projecting through N planes on every move. The handler's featureId guard
  // stays as a backstop for the commit window where the active feature changes.
  useEffect(() => {
    if (featureId !== activeFeatureId) return
    const handler = (e: PointerEvent) => handleDrawMoveRef.current?.(e)
    window.addEventListener('pointermove', handler)
    return () => window.removeEventListener('pointermove', handler)
  }, [featureId, activeFeatureId])

  if (featureId !== activeFeatureId) return null

  // Non-drawing tools (drag, dimension) render the inert backplane; every
  // drawing tool (including project) renders the active draw plane. Derived
  // from the registry so a new tool lands on the right plane automatically.
  if (!isDrawingTool(effectiveTool)) {
    return (
      <mesh
        position={[0, 0, -1000]}
        onClick={(e) => { e.stopPropagation(); if (shouldClearSelectionOnBackplaneClick()) clearNormalSelection() }}
        onPointerOut={() => {}}
      >
        <planeGeometry args={[100000, 100000]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
    )
  }

  return (
    <mesh
      ref={meshRef}
      position={[0, 0, -0.002]}
      onPointerDown={e => {
        e.stopPropagation()
        // A drawing gesture places points on the primary button only. A
        // secondary press is the camera (the turntable orbits on right-drag);
        // the stationary right click that stamps a fit spline down is resolved
        // on pointer-up by the Viewport, so an orbit never commits the curve.
        // Middle and back/forward presses never place a point either.
        if (e.nativeEvent.button !== 0) return
        const group = resolvedGroupRef.current
        if (!group) return
        // The commit click resolves against the sketch PLANE, not against
        // whatever mesh R3F's raycast landed on. Same seam as the draw hover
        // above and the drag move in Dragging.tsx: no scene mesh takes part, so
        // no geometry in front of the plane can influence where the point goes.
        const rect = gl.domElement.getBoundingClientRect()
        const ndcX = ((e.nativeEvent.clientX - rect.left) / rect.width) * 2 - 1
        const ndcY = -((e.nativeEvent.clientY - rect.top) / rect.height) * 2 + 1
        const worldPt = projectCursorToSketchPlane(camera, group, { x: ndcX, y: ndcY })
        if (!worldPt) {
          failLoud('[DrawPlane] cursor ray does not meet the sketch plane; click dropped')
          return
        }
        const sanitized = sanitizePointerEvent(
          { point: worldPt, clientX: e.nativeEvent.clientX, clientY: e.nativeEvent.clientY },
          resolvedGroupRef,
        )
        if (!sanitized) {
          failLoud('[DrawPlane] plane intersection did not sanitize to a sketch point; click dropped')
          return
        }
        const [x, y] = sanitized.localPoint

        const tool = toolRegistry.get(effectiveTool)
        if (!tool?.handlers.onPointerDown) return

        // Every drawing tool commits on this pointer-down (project projects,
        // line/arc/rect/... add or advance their buffer), so claim the click:
        // the canvas click listener must not also toggle normal selection on
        // the sketch entity / vertex the gesture just acted on.
        markDrawToolClickConsumed()

        // Every store field the click resolves against comes from this one
        // snapshot. Render-time selectors lag the store until React re-renders,
        // so two clicks in one frame would pair a fresh ref list with a stale
        // point list and restart the gesture instead of continuing it.
        const state = useSketchEditorStore.getState()
        // One resolve seam for every drawing tool: read the ID buffer at THIS
        // press pixel with the tool's allowed layers, the same path a selection
        // click takes. The async hover lags a frame, can name an earlier pixel's
        // hit, and a solve commit nulls it, which is why a click on a vertex
        // sometimes authored no coincident (and why the project tool already
        // resolved its own pick).
        const hit = resolvePickAtEvent(
          e.nativeEvent as PointerEvent,
          gl.domElement,
          gl,
          effectiveAllowedLayers(PART_EDITOR_CONSUMED_LAYERS, effectiveTool),
        )
        const pressSnap = resolveDrawPressSnap(hit, state.activeOriginLocal, { sketch, otherSketches })
        // The preview and the snap indicator read the store. Publishing the
        // press resolution there keeps them on the same point the click commits,
        // instead of showing the hover the press superseded.
        state.setHoveredVertex(
          pressSnap.hoveredVertexId, pressSnap.hoveredVertexPosition, pressSnap.hoveredSnapKind,
        )
        state.setHoveredSelectionId(pressSnap.hoveredSelectionId)
        const context: DrawingToolContext = {
          normalSelection: state.normalSelection,
          hoveredSelectionId: pressSnap.hoveredSelectionId,
          hoveredSourceKind: findEdgeKindForQuery(pressSnap.hoveredSelectionId ?? '') ?? null,
          hoveredFaceEdges: findFaceBoundaryEdges(pressSnap.hoveredSelectionId ?? ''),
          isPointerDown: state.isPointerDown,
          activeFeatureId: state.activeFeatureId,
          hoveredVertexId: pressSnap.hoveredVertexId,
          hoveredVertexPosition: pressSnap.hoveredVertexPosition,
          hoveredSnapKind: pressSnap.hoveredSnapKind,
          onMutation,
          onMutationBatch,
          drawPoints: state.drawPoints,
          setDrawPoints: (pts: import('@/types/cad').Point[]) => {
            useSketchEditorStore.getState().setDrawPoints(pts)
          },
          drawSnapRefs: state.drawSnapRefs,
          setDrawHover,
          clearDraw,
          alignmentSnapPoint: state.alignmentSnapPoint,
          alignmentSnapKind: state.alignmentSnapKind,
          setDrawSnap: state.setDrawSnap,
          setActiveTool: (tool) => { useSketchEditorStore.getState().setActiveTool(tool) },
          sketch: sketch as Record<string, import('@/types/cad').Entity> | undefined,
          otherSketches: otherSketches as Record<string, Record<string, import('@/types/cad').Entity>> | undefined,
          ngonSides: useSketchUiStore.getState().ngonSides,
          // Same screen scale the preview uses, so the vertex gate is one rule.
          pixelSize: screenPixelSize(camera),
          // The mode stack is store-owned (activate/deactivate); the pointer-down
          // context never pushes or pops, so these are inert here.
          pushMode: () => {},
          popMode: () => {},
        }
        tool.handlers.onPointerDown(e.nativeEvent, [x, y], context)
        // A completed gesture clears the buffer. Remember it so the next press
        // knows it is the second half of a double click that already stamped
        // the curve down (see onDoubleClick below).
        const finishedOnThisPress = state.drawPoints.length > 0
          && useSketchEditorStore.getState().drawPoints.length === 0
        pressAfterFinishRef.current = previousPressFinishedRef.current
        previousPressFinishedRef.current = finishedOnThisPress
      }}
      onDoubleClick={e => {
        e.stopPropagation()
        if (pressAfterFinishRef.current) {
          // The first press stamped the curve and the second opened a fresh
          // gesture. Drop its lone point instead of leaving a preview dot that
          // Enter cannot finish.
          pressAfterFinishRef.current = false
          previousPressFinishedRef.current = false
          useSketchEditorStore.getState().clearDraw()
          return
        }
        // The second press of a double click normally lands on the last fit
        // point and finishes the spline through the click path. When the
        // pointer drifted between the two presses that press places a new
        // point instead, so this is the explicit stamp-down for the gesture.
        useSketchEditorStore.getState().finishDraw()
      }}
      onPointerOut={() => setDrawHover(null)}
    >
      <planeGeometry args={[100000, 100000]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  )
}
