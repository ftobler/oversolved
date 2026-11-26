import { useEffect, useRef } from 'react'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { useScreenScale } from '@/components/Geometry3D/useScreenScale'
import { Dot } from '@/components/Geometry3D/VertexDots'
import { OverlayHtml } from '@/components/Geometry3D/OverlayHtml'
import { COLOR_ERROR, COLOR_PREVIEW } from '@/components/Geometry3D/constants'
import type { SketchFeature } from '@/types/cad'
import type { SnapCandidate } from '@/utils/geometry/snapDetection'
import { resolveSplitPreview, splitSnapPoint, type SplitPreview } from '@/tools/SplitTool'

const CROSS_A: [number, number, number][] = [[-1, -1, 0], [1, 1, 0]]
const CROSS_B: [number, number, number][] = [[-1, 1, 0], [1, -1, 0]]

function Cross({ x, y, color }: { x: number; y: number; color: string }) {
  const groupRef = useScreenScale<THREE.Group>(5, { billboard: true })
  return (
    <group ref={groupRef} position={[x, y, 0]} renderOrder={10}>
      <Line points={CROSS_A} color={color} lineWidth={2} depthTest={false} />
      <Line points={CROSS_B} color={color} lineWidth={2} depthTest={false} />
    </group>
  )
}

function samePreview(a: SplitPreview | null, b: SplitPreview | null): boolean {
  if (a === null || b === null) return a === b
  return a.featureId === b.featureId && a.entityId === b.entityId
    && a.at[0] === b.at[0] && a.at[1] === b.at[1]
    && a.refusal === b.refusal && a.needsSecondPoint === b.needsSecondPoint
}

/**
 * The split tool's aim: resolves the preview from the hover (tools/SplitTool.ts
 * owns the rule) and publishes it for the click, then draws a cross at the cut
 * point, the held first point of a circle, and the refusal sentence when the
 * cut would be refused, so a click never fails silently.
 */
export function SplitMarker({ featureId, activeFeatureId, feature, inferredCandidates }: {
  featureId: string
  activeFeatureId?: string | null
  feature?: SketchFeature
  inferredCandidates: readonly SnapCandidate[]
}) {
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const hoveredSelectionId = useSketchEditorStore(s => s.hoveredSelectionId)
  const hoveredVertexId = useSketchEditorStore(s => s.hoveredVertexId)
  const cursor = useSketchEditorStore(s => s.drawHover)
  const pending = useSketchEditorStore(s => s.splitPending)
  const preview = useSketchEditorStore(s => s.splitPreview)
  const active = activeTool === 'split' && featureId === activeFeatureId && feature !== undefined

  // The cursor and document the last resolve saw. A document change under a
  // still cursor is the cut just committed (or its re-solve): the point is now
  // an end of the new piece, and announcing that as a refusal would read as the
  // click having failed, so the aim waits for the next move.
  const seen = useRef<{ feature: SketchFeature | undefined; cursor: typeof cursor }>({ feature, cursor })

  useEffect(() => {
    if (!active) return
    const state = useSketchEditorStore.getState()
    const stillCursor = seen.current.feature !== feature && seen.current.cursor === cursor
    seen.current = { feature, cursor }
    if (stillCursor) {
      if (state.splitPreview !== null) state.setSplitPreview(null)
      return
    }
    const next = resolveSplitPreview({
      activeFeatureId: activeFeatureId ?? null,
      feature: feature ?? null,
      hoveredSelectionId,
      hoveredVertexId,
      snapPoint: splitSnapPoint(hoveredVertexId, feature ?? null, inferredCandidates),
      cursor,
      previousEntityId: state.splitPreview?.entityId ?? null,
      pending,
    })
    if (!samePreview(next, state.splitPreview)) state.setSplitPreview(next)
  }, [active, activeFeatureId, feature, hoveredSelectionId, hoveredVertexId, cursor, pending, inferredCandidates])

  if (!active) return null
  const held = pending !== null && pending.featureId === featureId ? pending.at : []
  return (
    <>
      {held.map((p, i) => <Dot key={i} x={p[0]} y={p[1]} px={4} color={COLOR_PREVIEW} billboard transparent />)}
      {preview !== null && (
        <>
          <Cross x={preview.at[0]} y={preview.at[1]} color={preview.refusal === null ? COLOR_PREVIEW : COLOR_ERROR} />
          {(preview.refusal !== null || preview.needsSecondPoint) && (
            <OverlayHtml position={[preview.at[0], preview.at[1], 0]} style={{ pointerEvents: 'none' }}>
              <div style={{
                transform: 'translate(12px, 12px)',
                whiteSpace: 'nowrap',
                fontSize: 12,
                color: preview.refusal === null ? COLOR_PREVIEW : COLOR_ERROR,
              }}>
                {preview.refusal ?? 'click a second point to split the circle'}
              </div>
            </OverlayHtml>
          )}
        </>
      )}
    </>
  )
}
