// What the assembly viewport draws, computed without a viewport: the assembly's
// own built-in origin + planes (Stage 6c's deferred render item) and one render
// group per part instance.
//
// Part meshes arrive with their solved transform already baked into the vertices
// (solveAssembly applies it worker-side), so a group needs no transform at rest.
// During a drag the mate solve does not re-run per frame; the group instead
// carries the pointer's offset from the seed pose, which lands the part exactly
// where the pointer put it without re-meshing anything.

import type { AssemblyDoc, BodyResult, PartInstance, Transform3D } from '@/types/cad'
import type { BodyRenderItem } from '@/components/Viewport/bodyUtils'
import { getBodiesToRender } from '@/components/Viewport/bodyUtils'
import type { ManipulationSession } from '@/utils/partManipulation'
import {
  composeTransforms,
  IDENTITY_TRANSFORM,
  makeTransform,
  relativeTransform,
  transformQuat,
  transformTranslation,
  type Quat,
  type Vec3,
} from '@/utils/transform3d'
import {
  ASSEMBLY_FRONT_ID,
  ASSEMBLY_ORIGIN_ID,
  ASSEMBLY_RIGHT_ID,
  ASSEMBLY_TOP_ID,
} from '@/utils/assemblyBuiltins'

/** Matches the part editor's reference planes (ReferencePlane.tsx). */
export const ASSEMBLY_PLANE_SIZE = 100

export interface AssemblyBuiltinItem {
  id: string
  kind: 'origin' | 'plane'
  label: string
  /** Euler rotation of the plane quad; unused for the origin. */
  rotation: [number, number, number]
}

// Same convention as the part editor's built-ins (Viewport/index.tsx): Front
// faces +Z, Top faces +Y, Right faces +X. The assembly anchors in
// kernel/solveAssembly.ts carry the matching normals.
const BUILTIN_RENDER: Record<string, AssemblyBuiltinItem> = {
  [ASSEMBLY_ORIGIN_ID]: { id: ASSEMBLY_ORIGIN_ID, kind: 'origin', label: 'Origin', rotation: [0, 0, 0] },
  [ASSEMBLY_FRONT_ID]:  { id: ASSEMBLY_FRONT_ID,  kind: 'plane',  label: 'Front',  rotation: [0, 0, 0] },
  [ASSEMBLY_TOP_ID]:    { id: ASSEMBLY_TOP_ID,    kind: 'plane',  label: 'Top',    rotation: [-Math.PI / 2, 0, 0] },
  [ASSEMBLY_RIGHT_ID]:  { id: ASSEMBLY_RIGHT_ID,  kind: 'plane',  label: 'Right',  rotation: [0, Math.PI / 2, 0] },
}

/** The assembly's own frame, in document order. Non-builtin features are ignored. */
export function getAssemblyBuiltinsToRender(doc: AssemblyDoc | null): AssemblyBuiltinItem[] {
  const items: AssemblyBuiltinItem[] = []
  for (const f of doc?.features ?? []) {
    const item = BUILTIN_RENDER[f.id]
    if (item && item.kind === f.kind) items.push(item)
  }
  return items
}

export interface AssemblyPartGroup {
  handle: string
  /** Live drag offset over the already-baked solved pose; identity at rest. */
  position: Vec3
  quaternion: Quat
  selected: boolean
  /** True while this part is the one under the pointer. */
  manipulating: boolean
  items: BodyRenderItem[]
}

/**
 * `manipulation` offsets only the part being dragged; everything else keeps its
 * solved pose. The offset is measured against the session seed rather than the
 * solved transform, so the part tracks the pointer by exactly the drag delta
 * even when a mate had pulled it off its seed.
 */
export function getAssemblyPartGroups(
  bodies: Record<string, BodyResult> | undefined,
  instances: PartInstance[],
  manipulation: ManipulationSession | null,
  selectedPartHandle: string | null,
): AssemblyPartGroup[] {
  const byHandle = new Map<string, BodyRenderItem[]>()
  for (const item of getBodiesToRender(bodies, undefined, undefined, undefined)) {
    const list = byHandle.get(item.featureId)
    if (list) list.push(item)
    else byHandle.set(item.featureId, [item])
  }

  const groups: AssemblyPartGroup[] = []
  for (const inst of instances) {
    if (inst.visible === false) continue
    const items = byHandle.get(inst.handle)
    if (!items || items.length === 0) continue

    const manipulating = manipulation?.handle === inst.handle
    const offset: Transform3D = manipulating
      ? relativeTransform(manipulation!.current, manipulation!.seed)
      : IDENTITY_TRANSFORM

    groups.push({
      handle: inst.handle,
      position: transformTranslation(offset),
      quaternion: transformQuat(offset),
      selected: inst.handle === selectedPartHandle,
      manipulating,
      items,
    })
  }
  return groups
}

// The part's current world pose: its solved transform carried along by any live
// drag offset. The triad gizmo reads both its origin and its orientation off
// this, so the gizmo sits on the part and turns with it. Null when the handle
// has no pose yet.
function gizmoPose(
  handle: string | null,
  groups: AssemblyPartGroup[],
  transforms: Record<string, Transform3D>,
  instances: PartInstance[],
): Transform3D | null {
  if (!handle) return null
  const group = groups.find(g => g.handle === handle)
  if (!group) return null
  const solved = transforms[handle] ?? instances.find(i => i.handle === handle)?.transform
  if (!solved) return null
  const offset = makeTransform(group.position, group.quaternion)
  return composeTransforms(offset, solved)
}

/**
 * Where the triad gizmo sits: the part's drawn origin, i.e. its solved origin
 * carried along by any live drag offset. Null when the handle has no pose yet.
 */
export function gizmoOrigin(
  handle: string | null,
  groups: AssemblyPartGroup[],
  transforms: Record<string, Transform3D>,
  instances: PartInstance[],
): Vec3 | null {
  const pose = gizmoPose(handle, groups, transforms, instances)
  return pose ? transformTranslation(pose) : null
}

/**
 * The part's world orientation, so the triad's arrows and rings align with the
 * part's own axes rather than the world's. Null when the handle has no pose yet.
 */
export function gizmoOrientation(
  handle: string | null,
  groups: AssemblyPartGroup[],
  transforms: Record<string, Transform3D>,
  instances: PartInstance[],
): Quat | null {
  const pose = gizmoPose(handle, groups, transforms, instances)
  return pose ? transformQuat(pose) : null
}
