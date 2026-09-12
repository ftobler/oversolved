// Bridge the anchor solver's per-part mesh payloads into the `BodyResult` dict
// the viewport's getBodiesToRender already consumes (bodyUtils.ts). Pure and
// viewport-free: the transforms are already baked into the vertices worker-side,
// so this is a relabelling, not geometry work.

import type { BodyResult, MateAnchorDescriptor } from '@/types/cad'
import type { EdgeCurve, EntityAnchorIndex } from '@/kernel/partBundle'
import type { MeshPayload } from '@/kernel/solveAssembly'
import {
  assemblyBuiltinEntityKey,
  assemblyEntityKey,
  type AssemblyEntityKind,
  type EntityMateRefs,
} from '@/utils/anchorCandidates'
import {
  ASSEMBLY_BUILTIN_IDS,
  ASSEMBLY_HANDLE,
} from '@/utils/assemblyBuiltins'

// Body ids are scoped by part handle, so two instances of the same part never
// collide in the flat dict.
export function assemblyBodyId(handle: string, index: number): string {
  return `${handle}:body_${index}`
}

export function toBodyResults(bodies: Record<string, MeshPayload[]>): Record<string, BodyResult> {
  const out: Record<string, BodyResult> = {}
  for (const [handle, meshes] of Object.entries(bodies)) {
    meshes.forEach((m, i) => {
      const id = assemblyBodyId(handle, i)
      out[id] = {
        id,
        created_by: handle,
        modified_by: [],
        mesh: { vertices: m.vertices, faces: m.indices },
      }
    })
  }
  return out
}

/**
 * The bundle's analytic edges, under the same body ids `toBodyResults` mints.
 * They ride beside the `BodyResult` dict rather than in it: `BodyResult.edges`
 * is the part editor's `EdgeData`, a different shape, and round-tripping an
 * `EdgeCurve` through it would buy nothing but a lossy conversion.
 */
export function toEdgeCurves(bodies: Record<string, MeshPayload[]>): Record<string, EdgeCurve[]> {
  const out: Record<string, EdgeCurve[]> = {}
  for (const [handle, meshes] of Object.entries(bodies)) {
    meshes.forEach((m, i) => {
      out[assemblyBodyId(handle, i)] = m.edges ?? []
    })
  }
  return out
}

const ENTITY_SLOTS: [AssemblyEntityKind, keyof EntityAnchorIndex][] = [
  ['face', 'faces'],
  ['edge', 'edges'],
  ['vertex', 'vertices'],
]

/**
 * The pick-side lookup Stage 7 resolves candidates through: every entity of
 * every part instance, plus the assembly's own built-ins, mapped to the mate
 * references it offers.
 *
 * The built-ins are matable ground (fasten a part's base to the assembly Top
 * plane), so they belong in the same table as part geometry. The pick path must
 * not care which side of the `ASSEMBLY_HANDLE` split a reference came from.
 * A bundle built before Stage 7 carries no `entityAnchors`; its parts simply
 * offer no picks until the part is rebuilt at a new rev.
 *
 * `anchorDescriptors` is the authoring-only descriptor table keyed like the
 * anchors payload. When present it stamps each part ref with the identity its
 * id was minted from, so a committed mate can re-resolve after a geom_hash
 * move; built-ins carry none (their ids are static).
 */
export function buildEntityMateRefs(
  bodies: Record<string, MeshPayload[]>,
  anchorDescriptors?: Record<string, Record<string, MateAnchorDescriptor>>,
): EntityMateRefs {
  const out: EntityMateRefs = {}
  for (const id of ASSEMBLY_BUILTIN_IDS) {
    out[assemblyBuiltinEntityKey(id)] = [{ part: ASSEMBLY_HANDLE, anchor: id }]
  }
  for (const [handle, meshes] of Object.entries(bodies)) {
    meshes.forEach((m, bodyIndex) => {
      if (!m.entityAnchors) return
      for (const [kind, slot] of ENTITY_SLOTS) {
        m.entityAnchors[slot].forEach((anchorIds, index) => {
          if (anchorIds.length === 0) return  // not matable; no pick id at all
          out[assemblyEntityKey(handle, bodyIndex, kind, index)] =
            anchorIds.map(anchor => {
              const descriptor = anchorDescriptors?.[handle]?.[anchor]
              return descriptor ? { part: handle, anchor, anchor_descriptor: descriptor } : { part: handle, anchor }
            })
        })
      }
    })
  }
  return out
}
