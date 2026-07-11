// Pure mutations over an AssemblyDoc. Viewport-free and unit-testable: given a
// doc they return a new doc, never mutating the input. The AssemblyEditor wires
// these to executeCommand handlers and to the tree's per-instance controls.

import type {
  AssemblyDoc, AssemblyFeature, MateFeature, MateFeatureDef, MateKind, MateRef, MateRefField,
  PartInstance, Transform3D,
} from '@/types/cad'
import { randomId } from '@/utils/yamlMutations/helpers'
import { EMPTY_MATE_REF } from '@/utils/mateKinds'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'

export { IDENTITY_TRANSFORM }

/** Feature ids are randomId(18) everywhere in this project (code_guideline.md §5). */
export function mintFeatureId(): string {
  return randomId(18)
}

// The seed content of a freshly created assembly document. `kind` is what
// DocumentPage routes on, and an empty `features` is what makes useAssemblyDoc
// prepend ASSEMBLY_BUILTIN_DEFAULTS on load. Deliberately does NOT bake the
// built-ins in: two places minting the assembly origin could drift apart, and
// the loader is already the one source of truth for them.
export function emptyAssemblyDoc(): AssemblyDoc {
  return { kind: 'assembly', features: [] }
}

function features(doc: AssemblyDoc): AssemblyFeature[] {
  return doc.features ?? []
}

function existingHandles(doc: AssemblyDoc): Set<string> {
  const handles = new Set<string>()
  for (const f of features(doc)) {
    if (f.kind === 'part_instance' && f.instance) handles.add(f.instance.handle)
  }
  return handles
}

// Mint an assembly-local handle (randomId(8)) that no current instance uses.
export function mintInstanceHandle(doc: AssemblyDoc): string {
  const taken = existingHandles(doc)
  let handle = randomId(8)
  while (taken.has(handle)) handle = randomId(8)
  return handle
}

// Append a part instance for the picked part at its current rev. The instance
// drops at the assembly origin with an identity transform.
export function appendPartInstance(doc: AssemblyDoc, docId: string, docRev: number): AssemblyDoc {
  const instance: PartInstance = {
    handle: mintInstanceHandle(doc),
    doc_id: docId,
    doc_rev: docRev,
    transform: { ...IDENTITY_TRANSFORM },
    visible: true,
  }
  const feature: AssemblyFeature = {
    id: mintFeatureId(),
    kind: 'part_instance',
    instance,
  }
  return { ...doc, features: [...features(doc), feature] }
}

// Drop the part_instance feature (and, by construction, its instance) whose
// instance handle matches. Mates referencing it are left untouched here; a
// dangling mate ref surfaces as stale at solve time (fail-safe over fail-wrong).
export function removeInstance(doc: AssemblyDoc, handle: string): AssemblyDoc {
  return {
    ...doc,
    features: features(doc).filter(
      f => !(f.kind === 'part_instance' && f.instance?.handle === handle),
    ),
  }
}

function updateInstance(
  doc: AssemblyDoc,
  handle: string,
  patch: (inst: PartInstance) => PartInstance,
): AssemblyDoc {
  return {
    ...doc,
    features: features(doc).map(f => {
      if (f.kind !== 'part_instance' || f.instance?.handle !== handle) return f
      return { ...f, instance: patch(f.instance) }
    }),
  }
}

export function setInstanceVisible(doc: AssemblyDoc, handle: string, visible: boolean): AssemblyDoc {
  return updateInstance(doc, handle, inst => ({ ...inst, visible }))
}

export function setInstanceFixed(doc: AssemblyDoc, handle: string, fixed: boolean): AssemblyDoc {
  return updateInstance(doc, handle, inst => ({ ...inst, fixed }))
}

// Show or hide one of the assembly's own built-in features (an origin or a
// plane), keyed by feature id. Reference geometry is hidden by default, so this
// is what a tree eye toggle writes.
export function setBuiltinVisible(doc: AssemblyDoc, id: string, visible: boolean): AssemblyDoc {
  return {
    ...doc,
    features: features(doc).map(f => (
      f.id === id && (f.kind === 'origin' || f.kind === 'plane') ? { ...f, visible } : f
    )),
  }
}

// Write a manipulated seed transform. A `fixed` (grounded) instance is the
// assembly's static reference frame: it is pinned here rather than only in the
// UI, so no manipulation path can move it even by mistake.
export function setInstanceTransform(
  doc: AssemblyDoc,
  handle: string,
  transform: Transform3D,
): AssemblyDoc {
  return updateInstance(doc, handle, inst => (
    inst.fixed ? inst : { ...inst, transform: { ...transform } }
  ))
}

// Write the instance's translation from a numeric edit in the inline editor.
// Unlike setInstanceTransform this ignores `fixed`: a manual position edit is an
// explicit reseat, not a solver manipulation, so the grounded pin must not veto
// it. Orientation is left untouched (still gizmo-driven).
export function setInstancePosition(
  doc: AssemblyDoc,
  handle: string,
  pos: { tx: number; ty: number; tz: number },
): AssemblyDoc {
  return updateInstance(doc, handle, inst => ({
    ...inst,
    transform: { ...inst.transform, tx: pos.tx, ty: pos.ty, tz: pos.tz },
  }))
}

// Restore a whole instance to a prior snapshot. The inline editor's Cancel path
// reverts the live edits it applied (position, grounded flag) in one write.
export function replaceInstance(doc: AssemblyDoc, handle: string, inst: PartInstance): AssemblyDoc {
  return updateInstance(doc, handle, () => ({ ...inst }))
}

export function findInstance(doc: AssemblyDoc, handle: string): PartInstance | undefined {
  for (const f of features(doc)) {
    if (f.kind === 'part_instance' && f.instance?.handle === handle) return f.instance
  }
  return undefined
}

// ─── Mate features (Stage 8) ───

/** The mates of an assembly, paired with the feature id `mateResults` is keyed by. */
export function mateFeatures(doc: AssemblyDoc): MateFeature[] {
  return features(doc)
    .filter((f): f is AssemblyFeature & { mate: MateFeatureDef } => f.kind === 'mate' && !!f.mate)
    .map(f => ({ id: f.id, mate: f.mate }))
}

export function findMate(doc: AssemblyDoc, featureId: string): MateFeatureDef | undefined {
  for (const f of features(doc)) {
    if (f.kind === 'mate' && f.id === featureId) return f.mate
  }
  return undefined
}

/**
 * Append a mate with both references empty. A mate is authored before it is
 * aimed: the user inserts the kind, then picks `ref_a` and `ref_b`. Until both
 * resolve, the solve reports it stale and it renders red, which is the same
 * signal a mate whose geometry was deleted gives.
 *
 * The caller mints `id` so it can select and arm the new mate in the same event.
 */
export function appendMate(doc: AssemblyDoc, kind: MateKind, id: string): AssemblyDoc {
  const feature: AssemblyFeature = {
    id,
    kind: 'mate',
    mate: { kind, ref_a: { ...EMPTY_MATE_REF }, ref_b: { ...EMPTY_MATE_REF } },
  }
  return { ...doc, features: [...features(doc), feature] }
}

export function removeMate(doc: AssemblyDoc, featureId: string): AssemblyDoc {
  return {
    ...doc,
    features: features(doc).filter(f => !(f.kind === 'mate' && f.id === featureId)),
  }
}

function updateMateFeature(
  doc: AssemblyDoc,
  featureId: string,
  patch: (mate: MateFeatureDef) => MateFeatureDef,
): AssemblyDoc {
  return {
    ...doc,
    features: features(doc).map(f => {
      if (f.kind !== 'mate' || f.id !== featureId || !f.mate) return f
      return { ...f, mate: patch(f.mate) }
    }),
  }
}

// Restore a whole mate def to a prior snapshot. The inline editor's Cancel path
// reverts every live edit (refs, params) it applied since editing began.
export function replaceMate(doc: AssemblyDoc, featureId: string, def: MateFeatureDef): AssemblyDoc {
  return updateMateFeature(doc, featureId, () => ({ ...def }))
}

// Rename a mate. An empty/undefined label deletes the key so the tree falls back
// to the computed default ('Fixed 1'); a YAML round-trip must not leave `null`.
export function setMateLabel(doc: AssemblyDoc, featureId: string, label: string | undefined): AssemblyDoc {
  return updateMateFeature(doc, featureId, m => {
    const next = { ...m }
    if (label && label.trim()) next.label = label
    else delete next.label
    return next
  })
}

/** Write a picked reference into one of the mate's two slots. */
export function setMateRef(
  doc: AssemblyDoc,
  featureId: string,
  field: MateRefField,
  ref: MateRef,
): AssemblyDoc {
  return updateMateFeature(doc, featureId, m => ({ ...m, [field]: { ...ref } }))
}

/**
 * The tunable half of a mate: `kind` and the two refs have their own setters.
 * Bounded by what `encodeMateInput` puts on the wire (see utils/mateKinds.ts).
 */
export type MateParamPatch = Partial<Pick<MateFeatureDef, 'flip' | 'ratio' | 'offset' | 'radius' | 'angle'>>

/**
 * Patch a mate's parameters. An `undefined` value deletes the key rather than
 * storing it: the doc is serialized to YAML, where a present-but-undefined field
 * round-trips as `null` and reads back as a value the solver would use.
 */
export function updateMate(
  doc: AssemblyDoc,
  featureId: string,
  patch: MateParamPatch,
): AssemblyDoc {
  return updateMateFeature(doc, featureId, m => {
    const next: MateFeatureDef = { ...m, ...patch }
    for (const key of Object.keys(patch) as (keyof MateParamPatch)[]) {
      if (patch[key] === undefined) delete next[key]
    }
    return next
  })
}
