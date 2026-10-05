import { builtinSelectionId } from '@/components/Geometry3D/utils'
import PlaneBody from '@/components/Viewport/PlaneBody'
import { DEFAULT_PLANE_SIZE } from '@/components/Viewport/planeConstants'

interface ReferencePlaneProps {
  rotation: [number, number, number]
  label: string
}

export default function ReferencePlane({ rotation, label }: ReferencePlaneProps) {
  return (
    <PlaneBody
      selId={builtinSelectionId(label)}
      size={DEFAULT_PLANE_SIZE}
      rotation={rotation}
      label={label}
    />
  )
}
