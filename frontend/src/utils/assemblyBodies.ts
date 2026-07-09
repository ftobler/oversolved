// Bridge the anchor solver's per-part mesh payloads into the `BodyResult` dict
// the viewport's getBodiesToRender already consumes (bodyUtils.ts). Pure and
// viewport-free: the transforms are already baked into the vertices worker-side,
// so this is a relabelling, not geometry work.

import type { BodyResult } from '@/types/cad'
import type { EdgeCurve } from '@/kernel/partBundle'
import type { MeshPayload } from '@/kernel/solveAssembly'

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
