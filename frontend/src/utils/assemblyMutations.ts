// Pure mutations over an AssemblyDoc. Viewport-free and unit-testable: given a
// doc they return a new doc, never mutating the input. The AssemblyEditor wires
// these to executeCommand handlers and to the tree's per-instance controls.

import type { AssemblyDoc, AssemblyFeature, PartInstance } from '@/types/cad'
import { randomId } from '@/utils/yamlMutations/helpers'

// Identity placement: no rotation, no translation. Stage 6d makes it movable.
export const IDENTITY_TRANSFORM = {
  tx: 0, ty: 0, tz: 0,
  qx: 0, qy: 0, qz: 0, qw: 1,
} as const

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
    id: randomId(18),
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
