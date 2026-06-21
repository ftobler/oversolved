import { builtinSelectionId } from '@/components/Geometry3D/utils'
import PlaneBody from '@/components/Viewport/PlaneBody'

const PLANE_SIZE = 100

interface ReferencePlaneProps {
  rotation: [number, number, number]
  label: string
}

export default function ReferencePlane({ rotation, label }: ReferencePlaneProps) {
  return (
    <PlaneBody
      selId={builtinSelectionId(label)}
      size={PLANE_SIZE}
      rotation={rotation}
      label={label}
    />
  )
}
