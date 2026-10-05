import type { PlaneTransform } from '@/types/cad'
import { planeRotationFromTransform } from '@/components/Geometry3D/utils'
import PlaneBody from '@/components/Viewport/PlaneBody'
import { DEFAULT_PLANE_SIZE } from '@/components/Viewport/planeConstants'

export default function UserDefinedPlane({
  featureId,
  label,
  planeTransform,
  size = DEFAULT_PLANE_SIZE,
}: {
  featureId: string
  label: string
  planeTransform: PlaneTransform
  size?: number
}) {
  const [ox, oy, oz] = planeTransform.origin
  return (
    <PlaneBody
      selId={`@${featureId}`}
      size={size}
      rotation={planeRotationFromTransform(planeTransform)}
      origin={[ox, oy, oz]}
      label={label}
    />
  )
}
