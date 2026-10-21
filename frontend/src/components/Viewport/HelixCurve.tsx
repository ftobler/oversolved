import { Line } from '@react-three/drei'
import type { EdgeDataSpline } from '@/types/cad'
import { useEdgeIdRegistration } from '@/picking'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import {
  COLOR_HOVER, COLOR_INACTIVE, COLOR_PROJECTED, COLOR_SELECTED, COLOR_SOLVED, entityRenderLayer,
} from '@/components/Geometry3D/constants'

// A helix is a reference curve, not a body: it renders from the solve result's
// sampled polyline and registers on the edge ID layer under its own feature id
// (the viewport maps it beside the UserDefinedPlane loop).
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
  // Hover is written by the shared ID-buffer dispatcher through the edge layer
  // (the helix registers as an edge body), so there is one hover path, not a
  // second R3F pointer one here.
  const hovered = useSketchEditorStore(s => s.hoveredSelectionId === selectionId)
  const selected = useSketchEditorStore(s => s.normalSelection.has(selectionId))

  useEdgeIdRegistration({
    featureId,
    bodyId: featureId,
    edges: [curve],
    edgeQueries: [`@${featureId}`],
    enabled: visible,
  })

  if (!visible || curve.points.length < 2) return null
  const start = curve.points[0]

  const color = hovered ? COLOR_HOVER : selected ? COLOR_SELECTED : isEditing ? COLOR_SOLVED : COLOR_INACTIVE
  const { depthTest, renderOrder } = entityRenderLayer({ isEditing, selected, hovered })

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
