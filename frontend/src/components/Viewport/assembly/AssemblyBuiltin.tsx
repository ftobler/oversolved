// The assembly's own frame: an origin marker and three cardinal planes, drawn
// the way the part editor draws its built-ins. They are first-class mate refs
// (fasten a part's base to the assembly Top plane), so each one both renders
// and registers a pick id under `assemblyBuiltinEntityKey`, the same key
// `buildEntityMateRefs` maps to a `__assembly` reference.

import { Dot } from '@/components/Geometry3D/VertexDots'
import { COLOR_INACTIVE } from '@/components/Geometry3D/constants'
import { PlaneLabel, PlaneSurface } from '@/components/Viewport/PlaneVisual'
import { useOriginMarkerIdRegistration, usePlaneIdRegistration } from '@/picking'
import { assemblyBuiltinEntityKey } from '@/utils/anchorCandidates'
import { ASSEMBLY_PLANE_SIZE, type AssemblyBuiltinItem } from '@/utils/assemblyRender'

function AssemblyOriginMarker({ id }: { id: string }) {
  useOriginMarkerIdRegistration({ selectionId: assemblyBuiltinEntityKey(id) })
  return <Dot x={0} y={0} px={4} color={COLOR_INACTIVE} billboard renderOrder={999} depthTest={false} />
}

function AssemblyBuiltinPlane({ item }: { item: AssemblyBuiltinItem }) {
  usePlaneIdRegistration({
    selectionId: assemblyBuiltinEntityKey(item.id),
    size: ASSEMBLY_PLANE_SIZE,
    rotation: item.rotation,
  })
  return (
    <group rotation={item.rotation}>
      <PlaneSurface size={ASSEMBLY_PLANE_SIZE} />
      <PlaneLabel x={-ASSEMBLY_PLANE_SIZE / 2} y={ASSEMBLY_PLANE_SIZE / 2}>{item.label}</PlaneLabel>
    </group>
  )
}

export default function AssemblyBuiltin({ item }: { item: AssemblyBuiltinItem }) {
  return item.kind === 'origin'
    ? <AssemblyOriginMarker id={item.id} />
    : <AssemblyBuiltinPlane item={item} />
}
