import { Line } from '@react-three/drei'
import type { EdgeDataSpline } from '@/types/cad'
import { useEdgeIdRegistration } from '@/picking'

// A helix is a reference curve, not a body: it renders from the solve result's
// sampled polyline and registers on the edge ID layer under its own feature id
// (the viewport maps it beside the UserDefinedPlane loop). The small marker on
// the first point makes the start angle visible while it is tuned.
export default function HelixCurve({
  featureId,
  curve,
  visible = true,
}: {
  featureId: string
  curve: EdgeDataSpline
  visible?: boolean
}) {
  useEdgeIdRegistration({
    featureId,
    bodyId: featureId,
    edges: [curve],
    edgeQueries: [`@${featureId}`],
    enabled: visible,
  })

  if (!visible || curve.points.length < 2) return null
  const start = curve.points[0]

  return (
    <group>
      <Line points={curve.points} color="#2b7fff" lineWidth={1.5} />
      <mesh position={start}>
        <sphereGeometry args={[0.4, 12, 12]} />
        <meshStandardMaterial color="#ff9f1a" />
      </mesh>
    </group>
  )
}
