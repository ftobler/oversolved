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

import type { AssemblyDoc, PartResult, PartInstance, Transform3D } from '@/types/cad'
import type { AssemblyLeaf } from '@/kernel/assemblyBundle'
import type { AssemblyExportPartSpec } from '@/kernel/worker/solverProtocol'
import type { StlMesh } from '@/kernel/stl'
import { encodeBinaryStl } from '@/kernel/stl'
import { BUILTIN_FEATURE_IDS } from '@/utils/builtins'
import { backendBundle } from '@/adapters/backend'
import { docLoadErrorMessage, loadPartDocText } from '@/persistence/docSchema'
import { fileIdsInParts } from '@/stores/fileRegistry/resolve'

/** Visible part instances, in document order. */
export function exportableInstances(doc: AssemblyDoc): PartInstance[] {
  return (doc.features ?? [])
    .filter(f => f.kind === 'part_instance' && !!f.instance && f.instance.visible !== false)
    .map(f => f.instance!)
}

/** Load and validate each referenced PartDoc once, keyed by doc id, through the
 *  same loader the editors read through. A missing or invalid part rejects the
 *  whole export rather than silently omitting a body: a STEP file quietly short
 *  a component is worse than no file, and a spec that fails validation would
 *  otherwise rehydrate a half-parsed B-rep. */
export async function loadPartContents(
  instances: readonly { doc_id: string }[],
): Promise<Record<string, Record<string, unknown>>> {
  const ids = [...new Set(instances.map(i => i.doc_id))]
  const loaded = await Promise.all(ids.map(id => backendBundle.documents.load(id)))
  const out: Record<string, Record<string, unknown>> = {}
  ids.forEach((id, i) => {
    const parsed = loadPartDocText(loaded[i].content, { name: loaded[i].name })
    if (!parsed.ok) throw new Error(`Part ${id}: ${docLoadErrorMessage(parsed.error)}`)
    out[id] = parsed.doc
  })
  return out
}

/** One leaf part at the world pose the flattened export places it at. */
export interface AssemblyExportLeaf {
  doc_id: string
  transform: Transform3D
}

/**
 * Flatten a solved assembly's instances to their leaf parts at world poses. A
 * direct instance is one leaf at its solved transform; a rigid sub-assembly
 * contributes every leaf its own solve flattened, with the composed pose the
 * worker returned. Hidden child leaves (the child document's own `visible`) and
 * rows the tree's view-only eye hides are omitted, matching the drawn scene.
 *
 * Falls back to the instance's seed when the last solve left no leaves (a
 * never-solved assembly): exporting at the seed beats refusing.
 */
export function flattenExportLeaves(
  instances: readonly PartInstance[],
  leaves: Readonly<Record<string, readonly AssemblyLeaf[]>>,
  hiddenLeafPaths?: ReadonlySet<string>,
  solvedPoses: Record<string, Transform3D> = {},
): AssemblyExportLeaf[] {
  const out: AssemblyExportLeaf[] = []
  for (const inst of instances) {
    if (inst.visible === false) continue
    const solved = leaves[inst.handle]
    if (!solved || solved.length === 0) {
      out.push({ doc_id: inst.doc_id, transform: solvedPoses[inst.handle] ?? inst.transform })
      continue
    }
    for (const leaf of solved) {
      if (leaf.visible === false) continue
      if (leaf.path !== undefined && hiddenLeafPaths?.has(`${inst.handle}/${leaf.path}`)) continue
      out.push({ doc_id: leaf.doc_id, transform: leaf.transform })
    }
  }
  return out
}

/**
 * Worker payload for the analytic path: one entry per leaf whose PartDoc
 * content we could load, carrying its flattened world placement.
 *
 * Built-in features are stripped from the spec, as every build path does
 * (`useSolver`, `PartExportImport`): the origin and the three datum planes are
 * seeded by `initGlobalRepo`, not solved as features.
 */
export function buildExportPartsFromLeaves(
  leaves: readonly AssemblyExportLeaf[],
  contents: Record<string, Record<string, unknown>>,
): AssemblyExportPartSpec[] {
  const out: AssemblyExportPartSpec[] = []
  for (const leaf of leaves) {
    const content = contents[leaf.doc_id]
    if (!content) continue
    const features = Array.isArray(content.features)
      ? (content.features as { id: string }[]).filter(f => !BUILTIN_FEATURE_IDS.has(f.id))
      : []
    out.push({
      spec: { ...content, id: leaf.doc_id, features },
      transform: leaf.transform,
    })
  }
  return out
}

/** The direct-instance form, kept for callers that have not solved (tests, a
 *  non-editor export path). It is `flattenExportLeaves` with no leaves. */
export function buildExportParts(
  instances: PartInstance[],
  transforms: Record<string, Transform3D>,
  contents: Record<string, Record<string, unknown>>,
): AssemblyExportPartSpec[] {
  return buildExportPartsFromLeaves(
    instances.map(inst => ({ doc_id: inst.doc_id, transform: transforms[inst.handle] ?? inst.transform })),
    contents,
  )
}

// Every import file the export parts reference, deduped. One shared map means a
// part file referenced by N instances crosses the worker boundary once.
export function collectExportFileIds(parts: AssemblyExportPartSpec[]): string[] {
  return fileIdsInParts(parts)
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
  parts: Record<string, PartResult>,
  instances: PartInstance[],
  hiddenLeafPaths?: ReadonlySet<string>,
): StlMesh[] {
  const handles = new Set(instances.map(i => i.handle))
  const out: StlMesh[] = []
  for (const part of Object.values(parts)) {
    if (!handles.has(part.created_by)) continue
    // The tree's view-only eye hides one child leaf; the export mirrors the
    // scene, so its body is left out of the solid.
    if (part.leaf_path !== undefined && hiddenLeafPaths?.has(`${part.created_by}/${part.leaf_path}`)) continue
    const mesh = part.mesh
    if (!mesh) continue
    const { vertices, faces } = mesh
    if (!(vertices instanceof Float32Array) || !(faces instanceof Uint32Array)) {
      // Tuple form means the export would quietly miss bodies shown on screen.
      // Never mis-encode them as a flat buffer; make the gap visible instead of
      // handing the user an STL that is silently short a solid.
      if (import.meta.env.DEV) console.warn(`assemblyStlMeshes: skipping body "${part.id}" whose mesh is tuple form, not typed arrays`)
      continue
    }
    out.push({ vertices, indices: faces })
  }
  return out
}

/** The mesh fast path: solved bodies straight to binary STL, no OCC, no worker. */
export function assemblyStlBytes(
  parts: Record<string, PartResult>,
  instances: PartInstance[],
  hiddenLeafPaths?: ReadonlySet<string>,
): Uint8Array | null {
  const meshes = assemblyStlMeshes(parts, instances, hiddenLeafPaths)
  if (meshes.length === 0) return null
  return encodeBinaryStl(meshes)
}
