// The pure face-frame lookup every camera/plane feature shares: the section
// view, the flatness check on an armed section pick, and "Normal to".
//
// It reads the solve's body meshes, not the viewport's hover registry. The
// registry only holds bodies that are drawn and interactive, so a hidden body
// used to take its face frame with it even though the solve still had it.
import type { PartResult } from '@/types/cad'
import { planarFaceFrame } from '@/components/Geometry3D/partGeometry'
import { FACE_LAYER_NAME } from '@/picking/layerNames'
import { partKeyFor, parsePickKeyIndex } from '@/picking/pickKey'

export interface SolveFaceFrame {
  normal: [number, number, number]
  center: [number, number, number]
}

function featureIdFor(partId: string, part: PartResult): string {
  return part.created_by || partId
}

/**
 * The frame of the flat face `query` names, or null when it names none. A
 * `pickKey` names the exact primitive clicked when two faces share a query.
 * When its body prefix matches, it is authoritative: a curved clicked face is
 * a refusal, never a reason to fall back to another face of the same body (an
 * imported body can give every one of its faces the same query). The query
 * fallback only runs when no body owns the pickKey, as in a legacy source from
 * a body the current solve no longer has.
 */
export function faceFrameFromSolve(
  parts: Record<string, PartResult> | undefined,
  query: string,
  pickKey?: string,
): SolveFaceFrame | null {
  if (pickKey) {
    for (const [bodyId, body] of Object.entries(parts ?? {})) {
      const mesh = body.mesh
      const prefix = `${partKeyFor(featureIdFor(bodyId, body), bodyId)}#${FACE_LAYER_NAME}#`
      if (!pickKey.startsWith(prefix)) continue
      const count = mesh?.face_queries?.length ?? 0
      const index = parsePickKeyIndex(pickKey, prefix, count)
      return mesh && index >= 0 ? planarFaceFrame(mesh, index) : null
    }
  }

  // The solve map's own order, the same first-owner rule the old registry
  // followed for a query that several bodies carry.
  for (const part of Object.values(parts ?? {})) {
    const mesh = part.mesh
    if (!mesh) continue
    const index = mesh.face_queries?.indexOf(query) ?? -1
    if (index < 0) continue
    const frame = planarFaceFrame(mesh, index)
    if (frame) return frame
  }
  return null
}
