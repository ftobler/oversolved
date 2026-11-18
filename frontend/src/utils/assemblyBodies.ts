// Bridge the anchor solver's per-part mesh payloads into the `BodyResult` dict
// the viewport's getBodiesToRender already consumes (partUtils.ts). Pure and
// viewport-free: the transforms are already baked into the vertices worker-side,
// so this is a relabelling, not geometry work.

import type { PartResult, MateAnchorDescriptor } from '@/types/cad'
import type { BundleFaceFact, EdgeCurve, EntityAnchorIndex } from '@/kernel/partBundle'
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

// Part ids are scoped by part handle, so two instances of the same part never
// collide in the flat dict.
export function assemblyPartId(handle: string, index: number): string {
  return `${handle}:body_${index}`
}

export function toPartResults(parts: Record<string, MeshPayload[]>): Record<string, PartResult> {
  const out: Record<string, PartResult> = {}
  for (const [handle, meshes] of Object.entries(parts)) {
    meshes.forEach((m, i) => {
      const id = assemblyPartId(handle, i)
      out[id] = {
        id,
        created_by: handle,
        modified_by: [],
        mesh: { vertices: m.vertices, faces: m.indices },
        ...(m.leafPath !== undefined && { leaf_path: m.leafPath }),
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
 *
 * A hidden seam is dropped here, for the beauty pass only: the pick payload
 * (`assemblyPick.buildEdges`) keeps the whole curve list so a tree-selected
 * seam can still draw its highlight, and its ID registration applies the same
 * skip separately.
 */
export function toEdgeCurves(parts: Record<string, MeshPayload[]>): Record<string, EdgeCurve[]> {
  const out: Record<string, EdgeCurve[]> = {}
  for (const [handle, meshes] of Object.entries(parts)) {
    meshes.forEach((m, i) => {
      const edges = m.edges ?? []
      const hidden = m.hiddenEdges
      out[assemblyPartId(handle, i)] = hidden && hidden.length > 0
        ? edges.filter((_edge, index) => !hidden.includes(index))
        : edges
    })
  }
  return out
}

/** The analytic bundle facts one solved body offers a measurement. */
export interface AssemblyEntityFacts {
  // The UNFILTERED edge list: `adapters/bundle` addresses an edge by its bundle
  // index, and the beauty-pass `edgeCurves` above has the hidden seams dropped.
  edges: EdgeCurve[]
  faces?: BundleFaceFact[]
}

/**
 * The measurement facts of every solved body, under the same body ids
 * `toPartResults` mints. The mesh payload already carries them in the solved
 * pose, so this is a relabelling beside `toEdgeCurves`, not geometry work.
 */
export function toEntityFacts(parts: Record<string, MeshPayload[]>): Record<string, AssemblyEntityFacts> {
  const out: Record<string, AssemblyEntityFacts> = {}
  for (const [handle, meshes] of Object.entries(parts)) {
    meshes.forEach((m, i) => {
      out[assemblyPartId(handle, i)] = {
        edges: m.edges ?? [],
        ...(m.faces && { faces: m.faces }),
      }
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
  parts: Record<string, MeshPayload[]>,
  anchorDescriptors?: Record<string, Record<string, MateAnchorDescriptor>>,
): EntityMateRefs {
  const out: EntityMateRefs = {}
  for (const id of ASSEMBLY_BUILTIN_IDS) {
    out[assemblyBuiltinEntityKey(id)] = [{ part: ASSEMBLY_HANDLE, anchor: id }]
  }
  for (const [handle, meshes] of Object.entries(parts)) {
    meshes.forEach((m, partIndex) => {
      if (!m.entityAnchors) return
      for (const [kind, slot] of ENTITY_SLOTS) {
        m.entityAnchors[slot].forEach((anchorIds, index) => {
          if (anchorIds.length === 0) return  // not matable; no pick id at all
          out[assemblyEntityKey(handle, partIndex, kind, index)] =
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
