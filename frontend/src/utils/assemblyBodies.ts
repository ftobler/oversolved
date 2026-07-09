// Bridge the anchor solver's per-part mesh payloads into the `BodyResult` dict
// the viewport's getBodiesToRender already consumes (bodyUtils.ts). Pure and
// viewport-free: the transforms are already baked into the vertices worker-side,
// so this is a relabelling, not geometry work.

import type { BodyResult } from '@/types/cad'
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
