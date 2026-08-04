// Assembly export, main-thread side. Pure and viewport-free: the document and
// the solved transforms in, either a worker request payload or STL bytes out.
//
// Two paths, deliberately asymmetric:
//
//   STEP is analytic, so it needs real B-rep. The anchor solver only ever held
//   meshes, so `exportAssemblyViaWorker` re-runs each part's feature stack on
//   the OCC worker and compounds the placed solids. Heavy; exports are rare.
//
//   STL is a triangle soup, and the solved bodies in `assemblyStore` are already
//   a triangle soup in world pose (the worker baked each part's transform into
//   its vertices). So the mesh path is a re-encode of data we hold, with no
//   rebuild, no OCC, and no worker round-trip.
//
// A hidden part is absent from both. The export mirrors the scene the user is
// looking at, which is the only reading of "hide" that does not surprise.

import { parse as parseYaml } from 'yaml'
import type { AssemblyDoc, BodyResult, PartDoc, PartInstance, Transform3D } from '@/types/cad'
import type { AssemblyExportPartSpec } from '@/kernel/worker/solverProtocol'
import type { StlMesh } from '@/kernel/stl'
import { encodeBinaryStl } from '@/kernel/stl'
import { BUILTIN_FEATURE_IDS } from '@/utils/builtins'
import { loadDocumentAnyDomain } from '@/adapters/documentLoad'
import { migrateLegacyBodyPicks } from '@/utils/yamlMutations'

/** Visible part instances, in document order. */
export function exportableInstances(doc: AssemblyDoc): PartInstance[] {
  return (doc.features ?? [])
    .filter(f => f.kind === 'part_instance' && !!f.instance && f.instance.visible !== false)
    .map(f => f.instance!)
}

/** Load and parse each referenced PartDoc once, keyed by doc id. Resolved
 * across both domains: a part instanced from the picker's cloud category has
 * no local mirror and would otherwise fail the whole STEP export. */
export async function loadPartContents(instances: PartInstance[]): Promise<Record<string, Record<string, unknown>>> {
  const ids = [...new Set(instances.map(i => i.doc_id))]
  const loaded = await Promise.all(ids.map(id => loadDocumentAnyDomain(id)))
  const out: Record<string, Record<string, unknown>> = {}
  ids.forEach((id, i) => {
    const doc = (parseYaml(loaded[i].data.content) ?? {}) as PartDoc
    // Same self-heal as the part load seam: the OCC worker that rehydrates the
    // part's B-rep reads only `bodies`, so a legacy singular `body` must be
    // migrated before export.
    migrateLegacyBodyPicks(doc)
    out[id] = doc as Record<string, unknown>
  })
  return out
}

/**
 * Worker payload for the analytic path: one entry per instance whose PartDoc
 * content we could load, carrying the solved placement.
 *
 * Falls back to the instance's own seed transform when the solve produced none
 * for that handle (a never-solved assembly, a handle added since the last
 * solve). Exporting at the seed pose beats refusing to export.
 *
 * Built-in features are stripped from the spec, as every build path does
 * (`useSolver`, `PartExportImport`): the origin and the three datum planes are
 * seeded by `initGlobalRepo`, not solved as features.
 */
export function buildExportParts(
  instances: PartInstance[],
  transforms: Record<string, Transform3D>,
  contents: Record<string, Record<string, unknown>>,
): AssemblyExportPartSpec[] {
  const out: AssemblyExportPartSpec[] = []
  for (const inst of instances) {
    const content = contents[inst.doc_id]
    if (!content) continue
    const features = Array.isArray(content.features)
      ? (content.features as { id: string }[]).filter(f => !BUILTIN_FEATURE_IDS.has(f.id))
      : []
    out.push({
      spec: { ...content, id: inst.doc_id, features },
      transform: transforms[inst.handle] ?? inst.transform,
    })
  }
  return out
}

/**
 * The solved meshes of the given instances, as the flat arrays the STL encoder
 * wants. `BodyResult.created_by` is the owning part handle (assemblyBodies.ts),
 * which is what scopes a body to its instance.
 *
 * A body whose mesh came back in the kernel's tuple form is skipped: the
 * assembly path always produces typed arrays, and silently mis-encoding a
 * `[x,y,z][]` as a flat buffer would write garbage triangles.
 */
export function assemblyStlMeshes(
  bodies: Record<string, BodyResult>,
  instances: PartInstance[],
): StlMesh[] {
  const handles = new Set(instances.map(i => i.handle))
  const out: StlMesh[] = []
  for (const body of Object.values(bodies)) {
    if (!handles.has(body.created_by)) continue
    const mesh = body.mesh
    if (!mesh) continue
    const { vertices, faces } = mesh
    if (!(vertices instanceof Float32Array) || !(faces instanceof Uint32Array)) continue
    out.push({ vertices, indices: faces })
  }
  return out
}

/** The mesh fast path: solved bodies straight to binary STL, no OCC, no worker. */
export function assemblyStlBytes(
  bodies: Record<string, BodyResult>,
  instances: PartInstance[],
): Uint8Array | null {
  const meshes = assemblyStlMeshes(bodies, instances)
  if (meshes.length === 0) return null
  return encodeBinaryStl(meshes)
}
