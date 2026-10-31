// The pure face-frame lookup every camera/plane feature shares: the section
// view, the flatness check on an armed section pick, and "Normal to".
//
// It reads the solve's body meshes, not the viewport's hover registry. The
// registry only holds bodies that are drawn and interactive, so a hidden body
// used to take its face frame with it even though the solve still had it.
import type { BodyResult, Mesh3D } from '@/types/cad'
import { planarFaceFrame } from '@/components/Geometry3D/bodyGeometry'
import { FACE_LAYER_NAME } from '@/picking/layerNames'
import { bodyKeyFor, parsePickKeyIndex } from '@/picking/pickKey'

export interface SolveFaceFrame {
  normal: [number, number, number]
  center: [number, number, number]
}

function featureIdFor(bodyId: string, body: BodyResult): string {
  return body.created_by || bodyId
}

function faceFrameAt(mesh: Mesh3D, index: number): SolveFaceFrame | null {
  return planarFaceFrame(mesh, index)
}

/**
 * The frame of the flat face `query` names, or null when it names none. A
 * `pickKey` names the exact primitive clicked when two faces share a query;
 * without one the first body that registered the query wins, matching the
 * order the hover registry used.
 */
export function faceFrameFromSolve(
  bodies: Record<string, BodyResult> | undefined,
  query: string,
  pickKey?: string,
): SolveFaceFrame | null {
  if (pickKey) {
    for (const [bodyId, body] of Object.entries(bodies ?? {})) {
      const mesh = body.mesh
      if (!mesh) continue
      const count = mesh.face_queries?.length ?? 0
      const prefix = `${bodyKeyFor(featureIdFor(bodyId, body), bodyId)}#${FACE_LAYER_NAME}#`
      const index = parsePickKeyIndex(pickKey, prefix, count)
      if (index >= 0) {
        const frame = faceFrameAt(mesh, index)
        if (frame) return frame
      }
    }
  }

  for (const body of Object.values(bodies ?? {})) {
    const mesh = body.mesh
    if (!mesh) continue
    const index = mesh.face_queries?.indexOf(query) ?? -1
    if (index < 0) continue
    const frame = faceFrameAt(mesh, index)
    if (frame) return frame
  }
  return null
}
