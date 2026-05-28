import { useRef, useEffect } from 'react'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { useSketchEditorStore, getSketchCallback } from '@/stores/sketchEditorStore'
import { toolRegistry } from '@/registry/toolRegistry'
import { sanitizePointerEvent } from '@/components/Geometry3D/pointerAbstractionAdapters'
import { projectCursorToSketchPlane } from '@/components/Geometry3D/dragMathPlane'
import { Dot } from '@/components/Geometry3D/VertexDots'
import { DashedLine } from '@/components/sketch_dimensions'
import { COLOR_PREVIEW } from '@/components/Geometry3D/constants'
import { useAlignmentSnapEffect } from '@/components/interaction/useAlignmentSnapEffect'
import type { Sketch } from '@/types/cad'
import type { DrawingToolContext } from '@/tools/DrawingTool'
import { computePreviewPts } from '@/components/Geometry3D/drawGeometry'

export function DrawPreview({ activeFeatureId }: { activeFeatureId?: string }) {
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const effectiveTool = activeTool ?? 'drag'
  const drawPoints = useSketchEditorStore(s => s.drawPoints)
  const drawHover = useSketchEditorStore(s => s.drawHover)
  const alignmentSnapPoint = useSketchEditorStore(s => s.alignmentSnapPoint)
  const alignmentSnapKind = useSketchEditorStore(s => s.alignmentSnapKind)

  if (activeFeatureId === null) return null
  if (effectiveTool === 'select') return null

  const previewPts = computePreviewPts(effectiveTool, drawPoints, drawHover)
  const endpoint = drawHover

  return (
    <>
      {drawPoints.map((pt, i) => (
        <Dot key={i} x={pt[0]} y={pt[1]} px={4} color={COLOR_PREVIEW} billboard />
      ))}
      {drawHover && effectiveTool === 'point' && (
        <Dot x={drawHover[0]} y={drawHover[1]} px={4} color={COLOR_PREVIEW} billboard />
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
  const clearNormalSelection = useSketchEditorStore(s => s.clearNormalSelection)
  const hoveredVertexPosition = useSketchEditorStore(s => s.hoveredVertexPosition)
  const hoveredVertexId = useSketchEditorStore(s => s.hoveredVertexId)
  const hoveredSnapKind = useSketchEditorStore(s => s.hoveredSnapKind)
  const drawHover = useSketchEditorStore(s => s.drawHover)
  const { camera, gl } = useThree()

  const drawLastPoint = drawPoints.length > 0 ? drawPoints[drawPoints.length - 1] : null
  const isRectTool = effectiveTool === 'rect' || effectiveTool === 'center_rect'
  useAlignmentSnapEffect(isRectTool ? null : drawHover, drawLastPoint)

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

  if (effectiveTool === 'select' || effectiveTool === 'dimension' || effectiveTool === 'drag') {
    return (
      <mesh
        position={[0, 0, -1000]}
        onClick={(e) => { e.stopPropagation(); clearNormalSelection() }}
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
        const sanitized = sanitizePointerEvent(e, resolvedGroupRef)
        if (!sanitized) return
        const [x, y] = sanitized.localPoint

        const tool = toolRegistry.get(effectiveTool)
        if (!tool?.handlers.onPointerDown) return

        const state = useSketchEditorStore.getState()
        const context: DrawingToolContext = {
          normalSelection: state.normalSelection,
          hoveredSelectionId: state.hoveredSelectionId,
          isPointerDown: state.isPointerDown,
          activeFeatureId: state.activeFeatureId,
          hoveredVertexId,
          hoveredVertexPosition,
          hoveredSnapKind,
          onMutation,
          drawPoints,
          drawSnapVertexId: state.drawSnapVertexId,
          setDrawHover,
          clearDraw,
          alignmentSnapPoint: state.alignmentSnapPoint,
          alignmentSnapKind: state.alignmentSnapKind,
          alignmentSnapVertexId: state.alignmentSnapVertexId,
          setDrawSnap: useSketchEditorStore.getState().setDrawSnap,
          setActiveTool: (tool: string | null) => { useSketchEditorStore.getState().setActiveTool(tool as import('@/types/cad').ActiveTool) },
          sketch: sketch as Record<string, import('@/types/cad').Entity> | undefined,
          otherSketches: otherSketches as Record<string, Record<string, import('@/types/cad').Entity>> | undefined,
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
