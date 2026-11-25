// The assembly's own frame: an origin marker and three cardinal planes, drawn
// the way the part editor draws its built-ins. They are first-class mate refs
// (fasten a part's base to the assembly Top plane), so each one both renders
// and registers a pick id under `assemblyBuiltinEntityKey`, the same key
// `buildEntityMateRefs` maps to a `__assembly` reference.

import { Dot } from '@/components/Geometry3D/VertexDots'
import {
  COLOR_HOVER, COLOR_INACTIVE, COLOR_SELECTED, RENDER_ORDER_HIGHLIGHT, highlightState,
} from '@/components/Geometry3D/constants'
import { PlaneLabel, PlaneSurface } from '@/components/Viewport/PlaneVisual'
import { useOriginMarkerIdRegistration, usePlaneIdRegistration } from '@/picking'
import { useAssemblyStore } from '@/stores/assemblyStore'
import { assemblyBuiltinEntityKey } from '@/utils/anchorCandidates'
import { ASSEMBLY_PLANE_SIZE, type AssemblyBuiltinItem } from '@/utils/assemblyRender'

// The origin is a mate target, so it highlights under the assembly's own hover
// and selection the same way the part editor's OriginMarker does. Both read the
// entity key their pick id registers, never the part editor's selection stores.
function AssemblyOriginMarker({ id }: { id: string }) {
  const selId = assemblyBuiltinEntityKey(id)
  const selected = useAssemblyStore(s => s.entitySelection.has(selId))
  const hoveredEntity = useAssemblyStore(s => s.hoveredEntity)
  useOriginMarkerIdRegistration({ selectionId: selId })

  const state = highlightState(selected, hoveredEntity === selId)
  const color = state === 'selected' ? COLOR_SELECTED
    : state === 'hovered' ? COLOR_HOVER
    : COLOR_INACTIVE
  return <Dot x={0} y={0} px={state === 'hovered' ? 6 : 4} color={color} billboard renderOrder={RENDER_ORDER_HIGHLIGHT} depthTest={false} />
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
