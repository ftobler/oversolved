// A sub-assembly entering its parent as one rigid body: the child's solved
// leaves flattened into a single bundle the parent's mate solve can move as a
// unit. The child's own mates were solved inside its document, so the flattening
// is a relabelling plus a path prefix, not another solve.
//
// The composite is keyed by its own recursive content key (contentHash.ts's
// `assemblyBundleKey`), so editing a deep part invalidates every ancestor by
// pull, exactly like a part bundle. It is never written to IndexedDb: the leaf
// part bundles it is built from are cached there, and the composite is a cheap
// re-flatten of their solved output.

import type { MateAnchorDescriptor, PartInstance, Transform3D } from '@/types/cad'
import type { AssemblySolveStatus, MeshPayload } from './solveAssembly'
import type { Anchor, AnchorPose, EntityAnchorIndex, PartBundle, PartMesh } from './partBundle'
import { BUNDLE_SCHEMA, PART_FRAME_ANCHORS, partFrameAnchorId } from './partBundle'

/**
 * The recursion ceiling for a solve. A hand-edited workspace cannot make a
 * cycle through the picker, but a file could still be authored that way; the
 * cap refuses with the cycle wording instead of overflowing the stack. 32 is
 * far past any real assembly and small enough to fail fast.
 */
export const MAX_SUBASSEMBLY_DEPTH = 32

/** One leaf part of a rigid sub-assembly, with the pose the child solved it at. */
export interface AssemblyLeaf {
  doc_id: string
  transform: Transform3D
  visible: boolean
  // The child handle path relative to the top-level instance. Absent for a
  // direct part. The tree's view eye and export both key on it.
  path?: string
}

/**
 * A sub-assembly's solved leaves as one `PartBundle`-shaped body: meshes, edges
 * and anchors already expressed in the sub-assembly's own frame, so the parent
 * solver only applies the instance placement. `leaves` carries the flat export
 * list through the same bundle, and `warning` the child's own verdict.
 */
export interface AssemblyBundle extends PartBundle {
  leaves: AssemblyLeaf[]
  warning?: string
}

/** The solved child document the composite is flattened from. */
export interface SubassemblySolvePayload {
  transforms: Record<string, Transform3D>
  bodies: Record<string, MeshPayload[]>
  anchors: Record<string, Record<string, AnchorPose>>
  anchorDescriptors?: Record<string, Record<string, MateAnchorDescriptor>>
  // The child's own flat leaves, already posed in the child frame. Absent for a
  // test double or a payload produced before leaves existed; the builder then
  // synthesizes one leaf per visible instance.
  leaves?: Record<string, AssemblyLeaf[]>
  status?: AssemblySolveStatus
}

/**
 * A child solve that finished but did not converge is still a usable rigid
 * body: it enters at its last solved poses. The parent row shows this warning
 * so the child's verdict is not silently swallowed by the parent's own.
 */
export function subassemblyWarning(status: AssemblySolveStatus | undefined): string | undefined {
  if (!status) return undefined
  if (status.verdict !== 'failed' && status.verdict !== 'unavailable' && status.verdict !== 'overconstrained') {
    return undefined
  }
  const detail = status.error ? `: ${status.error}` : ''
  return `child assembly ${status.verdict}${detail}`
}

function prefixIds(handle: string, lists: string[][]): string[][] {
  return lists.map(list => list.map(id => `${handle}/${id}`))
}

/**
 * Prefix the positional entity index with the instance handle. The anchor ids
 * inside it are the child bundle's own ids; the parent's picks and mate refs
 * name them with the same path the composite's anchor dict uses.
 */
function prefixEntityAnchors(handle: string, index: EntityAnchorIndex | undefined): EntityAnchorIndex | undefined {
  if (!index) return undefined
  return {
    faces: prefixIds(handle, index.faces),
    edges: prefixIds(handle, index.edges),
    vertices: prefixIds(handle, index.vertices),
  }
}

/**
 * Flatten a solved child document into one rigid bundle. Anchor ids gain the
 * child instance handle as a path prefix (`<handle>/<anchorId>`), so a parent
 * mate can name a leaf at any depth; the sub-assembly's own frame anchors stay
 * bare (`Origin`, `Top`, ...) because a parent mate reaches them through the
 * top-level instance handle, not through a leaf.
 *
 * A hidden child instance contributes no drawn geometry but keeps its anchors:
 * visibility is a view state, and a mate authored on that part must still
 * resolve. That is also why the anchors are not filtered with the meshes.
 */
export function buildAssemblyBundle(
  contentHash: string,
  instances: readonly PartInstance[],
  child: SubassemblySolvePayload,
): AssemblyBundle {
  const meshes: PartMesh[] = []
  const anchors: Record<string, Anchor> = {}
  const leaves: AssemblyLeaf[] = []

  for (const inst of instances) {
    const handle = inst.handle
    if (inst.visible !== false) {
      for (const mesh of child.bodies[handle] ?? []) {
        meshes.push({
          mesh: {
            vertices: mesh.vertices,
            indices: mesh.indices,
            faceIdsPerTriangle: mesh.faceIdsPerTriangle,
          },
          edges: mesh.edges ?? [],
          hiddenEdges: mesh.hiddenEdges,
          hiddenVertices: mesh.hiddenVertices,
          // A nested composite already carries its own inner path; prefix it
          // with this handle so the tree key is the full path from the parent.
          leafPath: mesh.leafPath === undefined ? handle : `${handle}/${mesh.leafPath}`,
          ...(mesh.color !== undefined && { color: mesh.color }),
          entityAnchors: prefixEntityAnchors(handle, mesh.entityAnchors),
        })
      }
    }
    for (const [id, pose] of Object.entries(child.anchors[handle] ?? {})) {
      const descriptor = child.anchorDescriptors?.[handle]?.[id]
      anchors[`${handle}/${id}`] = {
        kind: pose.kind,
        point: [...pose.point],
        axis: [...pose.axis],
        // The descriptor is the durable identity a parent ref can re-find; the
        // pose payload deliberately drops it. A missing descriptor (a legacy
        // payload, a test double) degrades to an id-only anchor.
        geom_hash: descriptor?.geom_hash ?? '',
        created_by: descriptor?.created_by ?? handle,
      }
    }
    const childLeaves = child.leaves?.[handle]
    if (childLeaves) {
      for (const leaf of childLeaves) {
        leaves.push({
          ...leaf,
          // A nested composite's leaf already carries its inner path; prefix it
          // with this handle so the path stays relative to the parent's top.
          path: leaf.path === undefined ? handle : `${handle}/${leaf.path}`,
          visible: leaf.visible && inst.visible !== false,
        })
      }
    } else {
      leaves.push({
        doc_id: inst.doc_id,
        transform: child.transforms[handle] ?? inst.transform,
        visible: inst.visible !== false,
        path: handle,
      })
    }
  }

  // The sub-assembly's own frame, minted like a part's: a parent mate can fix
  // the whole child to the assembly origin/planes. The ids are deterministic
  // and cannot collide with a prefixed leaf id.
  for (const [name, anchor] of Object.entries(PART_FRAME_ANCHORS)) {
    const id = partFrameAnchorId(name)
    if (id === undefined) continue
    anchors[id] = {
      ...anchor,
      point: [...anchor.point],
      axis: [...anchor.axis],
    }
  }

  return {
    // The composite is never cached under doc_id; the key is its identity.
    doc_id: '',
    content_hash: contentHash,
    schema: BUNDLE_SCHEMA,
    bodies: meshes,
    anchors,
    leaves,
    warning: subassemblyWarning(child.status),
  }
}
