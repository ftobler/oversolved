import { useMemo } from 'react'
import type { PlaneTransform } from '@/types/cad'
import { planeRotationFromTransform } from '@/components/Geometry3D/utils'
import { planeTransformKey } from '@/picking/planeTransformKey'
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
  // Keyed on the plane's value, not the prop reference: a fresh equal-valued
  // PlaneTransform per render must not rebuild the Matrix4 + Euler.
  const planeKey = useMemo(() => planeTransformKey(planeTransform), [planeTransform])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- planeKey stands in for planeTransform's value; see the note above
  const rotation = useMemo(() => planeRotationFromTransform(planeTransform), [planeKey])
  return (
    <PlaneBody
      selId={`@${featureId}`}
      size={size}
      rotation={rotation}
      origin={[ox, oy, oz]}
      label={label}
    />
  )
}
