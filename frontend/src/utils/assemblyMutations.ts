// Pure mutations over an AssemblyDoc. Viewport-free and unit-testable: given a
// doc they return a new doc, never mutating the input. The AssemblyEditor wires
// these to executeCommand handlers and to the tree's per-instance controls.

import type {
  AssemblyDoc, AssemblyFeature, MateFeature, MateFeatureDef, MateKind, MateRef, MateRefField,
  PartInstance, Transform3D,
} from '@/types/cad'
import { randomId } from '@/utils/yamlMutations/helpers'
import { EMPTY_MATE_REF } from '@/utils/mateKinds'
import { IDENTITY_TRANSFORM, quatFromEulerXyz, quatToEulerXyz } from '@/utils/transform3d'

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

// Copy an existing instance: same part at the same revision, landing on the
// original's pose so the copy appears exactly on top of it, which is where CAD
// users expect to find it before dragging or mating it into place.
//
// Two things deliberately do NOT ride along. `fixed` is a claim about one part
// anchoring the assembly, so a second fixed copy at the same pose would
// over-constrain the solve. Mates are relationships between parts rather than
// properties of one, so they stay pointed at the original.
export function duplicateInstance(doc: AssemblyDoc, handle: string): AssemblyDoc {
  const source = features(doc).find(
    f => f.kind === 'part_instance' && f.instance?.handle === handle,
  )?.instance
  if (!source) return doc
  const instance: PartInstance = {
    handle: mintInstanceHandle(doc),
    doc_id: source.doc_id,
    doc_rev: source.doc_rev,
    transform: { ...source.transform },
    visible: source.visible ?? true,
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

// Toggle a part's instance-level `fixed` flag while keeping the doc's seeds in
// step with what is on screen.
//
// The seed transforms in the doc go stale between solves: only the dragged
// part's seed is written back, so every other part is displayed at its solved
// pose while its seed still holds an old value. Left alone, the next solve would
// restart the mate solver from those stale seeds and relax the whole assembly
// off its current configuration.
//
// So we bake the current solved pose of every instance into its seed
// (`transforms`, keyed by handle) and set the toggled part's flag. The caller
// does not re-solve on the toggle itself (nothing needs to move); the next real
// solve then starts from the exact current, already mate-satisfying
// configuration and holds it.
export function setInstanceFixedFromSolved(
  doc: AssemblyDoc,
  handle: string,
  fixed: boolean,
  transforms: Record<string, Transform3D>,
): AssemblyDoc {
  return {
    ...doc,
    features: features(doc).map(f => {
      if (f.kind !== 'part_instance' || !f.instance) return f
      const inst = f.instance
      const solved = transforms[inst.handle]
      return {
        ...f,
        instance: {
          ...inst,
          transform: solved ? { ...solved } : inst.transform,
          fixed: inst.handle === handle ? fixed : inst.fixed,
        },
      }
    }),
  }
}

// Freeze every instance's current solved pose into its seed transform, mirroring
// what setInstanceFixedFromSolved bakes but without touching any `fixed` flag.
//
// The doc's seeds go stale between solves: only a dragged part's seed is written
// back on pointer-up, so every other part is drawn at its solved pose while its
// seed still holds the placement pose. A re-solve after a structural edit (a mate
// deleted) restarts the mate solver from those stale seeds, which relaxes the
// whole assembly off the configuration on screen -- a part positioned only by the
// removed mate snaps back to its drop pose and looks like it vanished. Baking
// first makes the next solve start from the current, already mate-satisfying
// poses and only relax the freed DOF. A part with no solved pose (never solved)
// keeps its own seed rather than losing it.
export function bakeSolvedTransforms(
  doc: AssemblyDoc,
  transforms: Record<string, Transform3D>,
): AssemblyDoc {
  return {
    ...doc,
    features: features(doc).map(f => {
      if (f.kind !== 'part_instance' || !f.instance) return f
      // A `fixed` instance's seed IS the authored truth: baking a solved pose
      // over it can only ever write solver error back into the document, and
      // every bake compounds the last one. solveAssembly already echoes a
      // fixed part's seed verbatim, so this is belt-and-braces -- but it is
      // the write that would make any leak permanent.
      if (f.instance.fixed) return f
      const solved = transforms[f.instance.handle]
      if (!solved) return f
      return { ...f, instance: { ...f.instance, transform: { ...solved } } }
    }),
  }
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

// Write a manipulated seed transform. An instance carrying the `fixed` flag
// (the per-instance flag, not the fixed mate) is the assembly's static
// reference frame: it is pinned here rather than only in the UI, so no
// manipulation path can move it even by mistake.
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
// explicit reseat, not a solver manipulation, so the `fixed` pin must not veto
// it. Orientation is left to setInstanceRotation.
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

/** Authoring unit for instance orientation: degrees, like the mate editor's angle. */
export interface EulerDeg {
  rx: number
  ry: number
  rz: number
}

// The orientation half of the numeric reseat, and the ONLY way to orient a
// fixed part: the triad gizmo is refused for a `fixed` instance
// (isManipulable, partManipulation.ts), so without this a part fixed at the
// wrong angle could never be re-aimed -- and everything mates onto that frame.
// Ignores the `fixed` veto for the same reason setInstancePosition does.
export function setInstanceRotation(doc: AssemblyDoc, handle: string, euler: EulerDeg): AssemblyDoc {
  const [qx, qy, qz, qw] = quatFromEulerXyz([
    (euler.rx * Math.PI) / 180,
    (euler.ry * Math.PI) / 180,
    (euler.rz * Math.PI) / 180,
  ])
  return updateInstance(doc, handle, inst => ({
    ...inst,
    transform: { ...inst.transform, qx, qy, qz, qw },
  }))
}

/** The instance's orientation as the editor's degree triple. */
export function instanceRotation(inst: PartInstance): EulerDeg {
  const t = inst.transform
  const [rx, ry, rz] = quatToEulerXyz([t.qx, t.qy, t.qz, t.qw])
  return { rx: (rx * 180) / Math.PI, ry: (ry * 180) / Math.PI, rz: (rz * 180) / Math.PI }
}

// Restore a whole instance to a prior snapshot. The inline editor's Cancel path
// reverts the live edits it applied (position, `fixed` flag) in one write.
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

// ─── Reordering ───

// Move the feature `movingId` so it sits immediately before `beforeId` in the
// document's authored feature order, or at the end of its own kind group when
// `beforeId` is null. Feature-array order IS the assembly's authored order (the
// tree renders it and the solver applies mates in it), so a tree drag-reorder is
// just a splice here. A no-op when the moving feature is absent, when it is
// dropped onto itself, or when the named target vanished between grab and drop.
export function reorderFeature(
  doc: AssemblyDoc,
  movingId: string,
  beforeId: string | null,
): AssemblyDoc {
  const list = features(doc)
  const from = list.findIndex(f => f.id === movingId)
  if (from < 0 || beforeId === movingId) return doc
  const moving = list[from]
  const without = list.filter((_, i) => i !== from)
  let insertAt: number
  if (beforeId === null) {
    // Land past the last sibling of the same kind, so a part dropped below the
    // last row stays among the parts and a mate stays among the mates rather
    // than sinking to the bottom of the whole feature list.
    let last = -1
    without.forEach((f, i) => { if (f.kind === moving.kind) last = i })
    insertAt = last + 1
  } else {
    insertAt = without.findIndex(f => f.id === beforeId)
    if (insertAt < 0) return doc
  }
  const next = [...without.slice(0, insertAt), moving, ...without.slice(insertAt)]
  return { ...doc, features: next }
}

// The feature id of the part_instance carrying `handle`, if any. The tree keys
// part rows by handle, not feature id, so a part drag arrives in handle space.
function featureIdForInstance(doc: AssemblyDoc, handle: string): string | undefined {
  return features(doc).find(f => f.kind === 'part_instance' && f.instance?.handle === handle)?.id
}

// Reorder a part instance (by its handle) to sit before the instance carrying
// `beforeHandle`, or last among the parts when null. Resolves both handles to
// their feature ids and defers to reorderFeature; a stale `beforeHandle` no-ops.
export function moveInstance(
  doc: AssemblyDoc,
  movingHandle: string,
  beforeHandle: string | null,
): AssemblyDoc {
  const movingId = featureIdForInstance(doc, movingHandle)
  if (!movingId) return doc
  if (beforeHandle === null) return reorderFeature(doc, movingId, null)
  const beforeId = featureIdForInstance(doc, beforeHandle)
  if (!beforeId) return doc
  return reorderFeature(doc, movingId, beforeId)
}

// Reorder a mate (by feature id) before `beforeId`, or last among the mates when
// null. Mate rows are already keyed by feature id, so this is a thin pass-through.
export function moveMate(
  doc: AssemblyDoc,
  movingId: string,
  beforeId: string | null,
): AssemblyDoc {
  return reorderFeature(doc, movingId, beforeId)
}
