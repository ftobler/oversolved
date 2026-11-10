import { Line } from '@react-three/drei'
import { useMemo } from 'react'
import type { EdgeDataSpline } from '@/types/cad'
import { useEdgeIdRegistration } from '@/picking'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import {
  COLOR_HINT, COLOR_HOVER, COLOR_INACTIVE, COLOR_PROJECTED, COLOR_SELECTED, COLOR_SOLVED, entityRenderLayer, highlightState,
} from '@/components/Geometry3D/constants'
import { useHintedFeatureIds } from '@/hooks/useRelationHint'

// A helix is a reference curve, not a body: it renders from the solve result's
// sampled polyline and registers on the reference-edge ID layer under its own
// feature id (the viewport maps it beside the UserDefinedPlane loop). That
// layer is not clipped by the section, matching this curve's unclipped draw.
//
// It looks and behaves like sketch geometry (utils/sketchClass): selection and
// hover paint it in the sketch colours and entityRenderLayer lifts it above the
// B-rep, so a body can no longer hide the highlighted curve. The start marker
// exists to tune the start angle, so it is only drawn while this feature's own
// editor is open; its amber is the projected-geometry hue, deliberately not the
// orange selection hue.
export default function HelixCurve({
  featureId,
  curve,
  visible = true,
  isEditing = false,
}: {
  featureId: string
  curve: EdgeDataSpline
  visible?: boolean
  isEditing?: boolean
}) {
  const selectionId = `@${featureId}`
  // Hover is written by the shared ID-buffer dispatcher through the
  // reference-edge layer, so there is one hover path, not a second R3F pointer
  // one here.
  const hovered = useSketchEditorStore(s => s.hoveredSelectionId === selectionId)
  const selected = useSketchEditorStore(s => s.normalSelection.has(selectionId))
  // A selected sweep draws its helix path in the hint colour, the same as the
  // profile sketch lines; the sketch-class helix would otherwise stay grey.
  const hinted = useHintedFeatureIds().has(featureId)

  // Identity-stable registration payloads: useEdgeIdRegistration's effect keys
  // on `edges` and `edgeQueries`, so a fresh array every render (a hover flip
  // re-renders this component) would unregister and rebuild the pick geometry
  // on every hover.
  const edges = useMemo(() => [curve], [curve])
  const edgeQueries = useMemo(() => [`@${featureId}`], [featureId])

  useEdgeIdRegistration({
    featureId,
    bodyId: featureId,
    edges,
    edgeQueries,
    enabled: visible,
    // Reference curve: the section clips bodies, not this, so its pick must
    // stay on the unclipped layer the curve is drawn on.
    layer: 'reference',
  })

  if (!visible || curve.points.length < 2) return null
  const start = curve.points[0]

  const state = highlightState(selected, hovered, hinted)
  const color = state === 'selected' ? COLOR_SELECTED
    : state === 'hovered' ? COLOR_HOVER
    : state === 'hinted' ? COLOR_HINT
    : isEditing ? COLOR_SOLVED : COLOR_INACTIVE
  const { depthTest, renderOrder } = entityRenderLayer({ isEditing, selected, hovered, hinted })

  return (
    <group>
      <Line
        points={curve.points}
        color={color}
        lineWidth={hovered ? 2 : 1}
        depthTest={depthTest}
        renderOrder={renderOrder}
      />
      {isEditing && (
        <mesh position={start} renderOrder={renderOrder}>
          <sphereGeometry args={[0.4, 12, 12]} />
          <meshStandardMaterial color={COLOR_PROJECTED} depthTest={depthTest} />
        </mesh>
      )}
    </group>
  )
}
