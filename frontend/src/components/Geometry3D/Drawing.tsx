import { useRef, useEffect } from 'react'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { useSketchEditorStore, getSketchCallback } from '@/stores/sketchEditorStore'
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
import { computePreviewPts } from '@/components/Geometry3D/drawGeometry'
import { resolveDrawCursor } from '@/components/Geometry3D/drawLogic'
import { markDrawToolClickConsumed } from '@/components/Viewport/idDispatch/drawToolClickGuard'
import {
  shouldClearSelectionOnBackplaneClick, resolvePickAtEvent, PART_EDITOR_CONSUMED_LAYERS,
} from '@/components/Viewport/idDispatch/useIdBufferPointerDispatch'
import { findEdgeKindForQuery, findFaceBoundaryEdges } from '@/components/Viewport/idDispatch/bodyDispatchCallbacks'
import { effectiveAllowedLayers } from '@/registry/toolPickConfig'

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
  const ngonSides = useSketchEditorStore(s => s.ngonSides)
  const hoveredVertexId = useSketchEditorStore(s => s.hoveredVertexId)
  const hoveredVertexPosition = useSketchEditorStore(s => s.hoveredVertexPosition)
  const hoveredSnapKind = useSketchEditorStore(s => s.hoveredSnapKind)
  const hoveredSelectionId = useSketchEditorStore(s => s.hoveredSelectionId)
  const drawSnapRefs = useSketchEditorStore(s => s.drawSnapRefs)

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
  const cursor = drawHover && resolveDrawCursor(effectiveTool, drawPoints, drawHover, {
    hoveredVertexId, hoveredVertexPosition, hoveredSnapKind, hoveredSelectionId,
    drawSnapRefs, alignmentSnapPoint, alignmentSnapKind, ngonSides,
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
  const { camera, gl } = useThree()

  const drawLastPoint = drawPoints.length > 0 ? drawPoints[drawPoints.length - 1] : null
  useAlignmentSnapEffect(toolTakesAlignmentSnap(effectiveTool) ? drawHover : null, drawLastPoint)

  // Resolve the sketch group ref: prefer explicit prop, fall back to mesh parent.
  const resolvedGroupRef: React.RefObject<THREE.Object3D | null> = sketchGroupRef ?? {
    get current() { return meshRef.current?.parent ?? null },
  }

  // Window-level pointermove: bypasses R3F event bubbling so Body3D/Surfaces meshes
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
    if (e.buttons & 6) { setDrawHover(null); return }

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

  // Attach once per mount; handler ref provides fresh values on every call.
  useEffect(() => {
    const handler = (e: PointerEvent) => handleDrawMoveRef.current?.(e)
    window.addEventListener('pointermove', handler)
    return () => window.removeEventListener('pointermove', handler)
  }, [])

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
        // The project tool picks B-rep / sketch identity to project. Resolve the
        // ID buffer at THIS click pixel instead of reading the async hover the
        // move-handler last wrote: hover lags a frame and can hold a different
        // pixel's hit, which made edge picks flaky. Same resolve seam the
        // click-selection path uses -- one identity source, no dual path.
        let pickedSelectionId = state.hoveredSelectionId
        if (effectiveTool === 'project') {
          const hit = resolvePickAtEvent(
            e.nativeEvent as PointerEvent,
            gl.domElement,
            gl,
            effectiveAllowedLayers(PART_EDITOR_CONSUMED_LAYERS, 'project'),
          )
          pickedSelectionId = hit?.entityKey ?? null
        }
        const context: DrawingToolContext = {
          normalSelection: state.normalSelection,
          hoveredSelectionId: pickedSelectionId,
          hoveredSourceKind: findEdgeKindForQuery(pickedSelectionId ?? '') ?? null,
          hoveredFaceEdges: findFaceBoundaryEdges(pickedSelectionId ?? ''),
          isPointerDown: state.isPointerDown,
          activeFeatureId: state.activeFeatureId,
          hoveredVertexId: state.hoveredVertexId,
          hoveredVertexPosition: state.hoveredVertexPosition,
          hoveredSnapKind: state.hoveredSnapKind,
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
          ngonSides: state.ngonSides,
          pushMode: () => {},
          popMode: () => {},
        }
        tool.handlers.onPointerDown(e.nativeEvent, [x, y], context)
      }}
      onPointerOut={() => setDrawHover(null)}
    >
      <planeGeometry args={[100000, 100000]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  )
}
