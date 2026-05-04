import { useRef, useEffect } from 'react'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import { sanitizePointerEvent } from './pointerAbstractionAdapters'
import { Dot } from './VertexDots'
import { DashedLine } from '../sketch_dimensions'
import { COLOR_PREVIEW } from './constants'
import { useAlignmentSnapEffect } from '../interaction/useAlignmentSnapEffect'
import type { Sketch } from '../../types/cad'
import { randomId } from '../../utils/yamlMutations'
import { computeDrawClick } from './drawLogic'
import type { DrawSnapState } from './drawLogic'
import { computePreviewPts } from './drawGeometry'

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
  const setDrawSnap = useSketchEditorStore(s => s.setDrawSnap)
  const clearDraw = useSketchEditorStore(s => s.clearDraw)
  const onMutation = useSketchEditorStore(s => s.onMutation)
  const setActiveTool = useSketchEditorStore(s => s.setActiveTool)
  const clearNormalSelection = useSketchEditorStore(s => s.clearNormalSelection)
  const hoveredVertexPosition = useSketchEditorStore(s => s.hoveredVertexPosition)
  const hoveredVertexId = useSketchEditorStore(s => s.hoveredVertexId)
  const hoveredSnapKind = useSketchEditorStore(s => s.hoveredSnapKind)
  const hoveredEntityId = useSketchEditorStore(s => s.hoveredEntityId)
  const drawHover = useSketchEditorStore(s => s.drawHover)
  const { camera, gl } = useThree()

  const drawLastPoint = drawPoints.length > 0 ? drawPoints[drawPoints.length - 1] : null
  useAlignmentSnapEffect(sketch, drawHover, drawLastPoint)

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
    const mesh = meshRef.current
    if (!mesh) return
    if (e.buttons & 6) { setDrawHover(null); return }

    // Live canvas bounds: not cached so sidebar resizes are reflected immediately.
    const rect = gl.domElement.getBoundingClientRect()
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1
    const ndcY = -((e.clientY - rect.top) / rect.height) * 2 + 1

    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera)
    const hits = raycaster.intersectObject(mesh, false)
    const worldPt = hits[0]?.point ?? null

    if (!worldPt) { setDrawHover(null); return }
    const sanitized = sanitizePointerEvent({ point: worldPt, clientX: e.clientX, clientY: e.clientY }, resolvedGroupRef)
    setDrawHover(sanitized?.localPoint ?? null)
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

        // Read alignment snap state imperatively -- set reactively by useAlignmentSnapEffect
        const state = useSketchEditorStore.getState()
        const snap: DrawSnapState = {
          hoveredVertexId,
          hoveredVertexPosition,
          hoveredSnapKind,
          hoveredEntityId,
          drawSnapVertexId: state.drawSnapVertexId,
          alignmentSnapPoint: state.alignmentSnapPoint,
          alignmentSnapKind: state.alignmentSnapKind,
          alignmentSnapVertexId: state.alignmentSnapVertexId,
        }

        const result = computeDrawClick(
          effectiveTool,
          drawPoints,
          [x, y],
          snap,
          featureId,
          () => randomId(12),
          sketch as Record<string, import('../../types/cad').Entity> | undefined,
          otherSketches as Record<string, Record<string, import('../../types/cad').Entity>> | undefined,
        )

        for (const m of result.mutations) {
          onMutation?.(m)
        }

        if (result.clearTool) {
          // Second click or single-click completion: clear draw state and tool
          clearDraw()
          setActiveTool(null)
        } else if (result.nextDrawPoints !== null) {
          // Replace draw points in place (preserves drawSnap for intermediate arc clicks)
          useSketchEditorStore.setState({ drawPoints: result.nextDrawPoints })
        }

        if (result.nextDrawSnap !== null) {
          setDrawSnap(result.nextDrawSnap.vertexId)
        }
      }}
      onPointerOut={() => setDrawHover(null)}
    >
      <planeGeometry args={[100000, 100000]} />
      <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  )
}
