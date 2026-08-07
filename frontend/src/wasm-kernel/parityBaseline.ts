// Shared baseline-building helpers for the full-doc parity gate
// (occ/fullDocParity.test.ts) and the corpus generator
// (scripts/regenCorpus.ts). Both must agree on how a live TS body is reduced
// to a frozen golden baseline body; keeping it here single-sources the replay
// and the regen so a drift on one side cannot hide a divergence.

import { faceGeometryHash, edgeGeometryHash } from '../kernel/geomHash'

export interface BaselineBody {
  id: string
  created_by: string
  modified_by: string[]
  mesh: { vertices: number[][]; faces: number[][] }
  face_count: number
  edge_count: number
  face_hashes: string[]
  edge_hashes: string[]
}

/** Reduce a live TS body result to the golden baseline body shape. */
export function buildBaselineBody(bid: string, body: Record<string, unknown>): BaselineBody {
  const mesh = body.mesh as Record<string, unknown> | undefined
  const faceData = (mesh?.face_data ?? []) as Array<{ centroid: number[]; normal: number[] }>
  const edges = (body.edges ?? []) as Record<string, unknown>[]
  return {
    id: bid,
    created_by: (body.created_by as string | undefined) ?? '',
    modified_by: (body.modified_by as string[] | undefined) ?? [],
    mesh: {
      vertices: (mesh?.vertices as number[][]) ?? [],
      faces: (mesh?.faces as number[][]) ?? [],
    },
    face_count: faceData.length,
    edge_count: edges.length,
    face_hashes: faceData.map((fd) => faceGeometryHash(fd.centroid, fd.normal)).sort(),
    edge_hashes: edges.map((ed) => edgeGeometryHash(ed)).sort(),
  }
}
