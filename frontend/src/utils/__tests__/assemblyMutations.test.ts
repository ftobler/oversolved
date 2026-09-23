import { describe, it, expect } from 'vitest'
import type { AssemblyDoc, AssemblyFeature, PartInstance } from '@/types/cad'
import {
  appendMate,
  appendPartInstance,
  assemblyDocEquals,
  bakeSolvedTransforms,
  defaultMateName,
  duplicateInstance,
  emptyAssemblyDoc,
  findMate,
  mateFeatures,
  mintFeatureId,
  mintInstanceHandle,
  partInstances,
  moveInstance,
  moveMate,
  reorderFeature,
  removeInstance,
  removeMate,
  replaceInstance,
  replaceMate,
  setBuiltinVisible,
  setInstanceVisible,
  setInstanceFixed,
  setInstanceFixedFromSolved,
  setInstancePosition,
  setInstanceRotation,
  setInstanceTransform,
  instanceRotation,
  setMateRef,
  setMateLabel,
  updateMate,
  IDENTITY_TRANSFORM,
} from '@/utils/assemblyMutations'
import { ASSEMBLY_HANDLE, ASSEMBLY_BUILTIN_DEFAULTS, ASSEMBLY_TOP_ID } from '@/utils/assemblyBuiltins'
import { EMPTY_MATE_REF } from '@/utils/mateKinds'

const emptyDoc: AssemblyDoc = { kind: 'assembly', features: [] }

function instances(doc: AssemblyDoc): PartInstance[] {
  return (doc.features ?? [])
    .filter(f => f.kind === 'part_instance' && f.instance)
    .map(f => f.instance!)
}

describe('appendPartInstance', () => {
  it('appends a part_instance feature with the picked doc_id, rev and identity transform', () => {
    const next = appendPartInstance(emptyDoc, 'doc-A', 7)
    const insts = instances(next)
    expect(insts).toHaveLength(1)
    expect(insts[0].doc_id).toBe('doc-A')
    expect(insts[0].doc_rev).toBe(7)
    expect(insts[0].transform).toEqual(IDENTITY_TRANSFORM)
    expect(insts[0].visible).toBe(true)
    expect(insts[0].handle).toMatch(/.+/)
  })

  it('mints a fresh feature id and a handle for the instance', () => {
    const next = appendPartInstance(emptyDoc, 'doc-A', 1)
    const feature = next.features!.find(f => f.kind === 'part_instance')!
    expect(feature.id).toMatch(/.+/)
    expect(feature.id).not.toBe(feature.instance!.handle)
  })

  it('gives two instances of the same part distinct handles', () => {
    let doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    doc = appendPartInstance(doc, 'doc-A', 1)
    const insts = instances(doc)
    expect(insts).toHaveLength(2)
    expect(insts[0].handle).not.toBe(insts[1].handle)
    expect(insts[0].doc_id).toBe(insts[1].doc_id)
  })

  it('does not mutate the input doc', () => {
    const next = appendPartInstance(emptyDoc, 'doc-A', 1)
    expect(emptyDoc.features).toEqual([])
    expect(next).not.toBe(emptyDoc)
  })

  it('treats an undefined features list as empty', () => {
    const doc: AssemblyDoc = { kind: 'assembly' }
    const next = appendPartInstance(doc, 'doc-A', 2)
    expect(instances(next)).toHaveLength(1)
  })
})

describe('mintInstanceHandle', () => {
  it('avoids collisions with existing instance handles', () => {
    const doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    const existing = instances(doc)[0].handle
    const fresh = mintInstanceHandle(doc)
    expect(fresh).not.toBe(existing)
  })
})

describe('removeInstance', () => {
  it('drops only the matching instance', () => {
    let doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    doc = appendPartInstance(doc, 'doc-B', 1)
    const [a, b] = instances(doc)
    const next = removeInstance(doc, a.handle)
    const insts = instances(next)
    expect(insts).toHaveLength(1)
    expect(insts[0].handle).toBe(b.handle)
  })

  it('is a no-op for an unknown handle', () => {
    const doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    const next = removeInstance(doc, 'nope')
    expect(instances(next)).toHaveLength(1)
  })

  it('leaves mate features in place', () => {
    let doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    const handle = instances(doc)[0].handle
    doc = {
      ...doc,
      features: [
        ...doc.features!,
        { id: 'm1', kind: 'mate', mate: { kind: 'fixed', ref_a: { part: handle, anchor: 'x' }, ref_b: { part: handle, anchor: 'y' } } },
      ],
    }
    const next = removeInstance(doc, handle)
    expect(next.features!.some(f => f.kind === 'mate')).toBe(true)
    expect(instances(next)).toHaveLength(0)
  })
})

describe('duplicateInstance', () => {
  it('clones the part reference and pose under a fresh handle', () => {
    let doc = appendPartInstance(emptyDoc, 'doc-A', 3)
    const original = instances(doc)[0]
    doc = setInstancePosition(doc, original.handle, { tx: 5, ty: 6, tz: 7 })
    const posed = instances(doc)[0]

    const next = duplicateInstance(doc, posed.handle)
    const insts = instances(next)
    expect(insts).toHaveLength(2)
    const clone = insts[1]
    expect(clone.doc_id).toBe('doc-A')
    expect(clone.doc_rev).toBe(3)
    // A duplicate lands exactly on the original; the user drags or mates it off.
    expect(clone.transform).toEqual(posed.transform)
    expect(clone.handle).not.toBe(posed.handle)
  })

  it('gives the clone its own feature id so the two rows are separable', () => {
    const doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    const handle = instances(doc)[0].handle
    const next = duplicateInstance(doc, handle)
    const ids = next.features!.filter(f => f.kind === 'part_instance').map(f => f.id)
    expect(new Set(ids).size).toBe(2)
  })

  it('leaves the original instance untouched', () => {
    const doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    const before = instances(doc)[0]
    const next = duplicateInstance(doc, before.handle)
    expect(instances(next)[0]).toEqual(before)
  })

  it('comes in unfixed even when the original is fixed', () => {
    let doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    const handle = instances(doc)[0].handle
    doc = setInstanceFixed(doc, handle, true)
    const next = duplicateInstance(doc, handle)
    const [original, clone] = instances(next)
    expect(original.fixed).toBe(true)
    // Fixing is a statement about one part's role in the assembly, not a
    // property of the geometry, so it does not ride along on the copy.
    expect(clone.fixed).toBeFalsy()
  })

  it('does not clone mates that reference the original', () => {
    let doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    const handle = instances(doc)[0].handle
    doc = appendMate(doc, 'fixed', 'm1')
    doc = setMateRef(doc, 'm1', 'ref_a', { part: handle, anchor: 'face-1' })

    const next = duplicateInstance(doc, handle)
    const mates = next.features!.filter(f => f.kind === 'mate')
    expect(mates).toHaveLength(1)
    // The surviving mate still points at the original, never at the copy.
    expect(mates[0].mate!.ref_a.part).toBe(handle)
  })

  it('is a no-op for an unknown handle', () => {
    const doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    expect(duplicateInstance(doc, 'nope')).toEqual(doc)
  })
})

describe('setInstanceVisible / setInstanceFixed', () => {
  it('toggles visibility on the matching instance only', () => {
    let doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    doc = appendPartInstance(doc, 'doc-B', 1)
    const [a, b] = instances(doc)
    const next = setInstanceVisible(doc, a.handle, false)
    const map = Object.fromEntries(instances(next).map(i => [i.handle, i.visible]))
    expect(map[a.handle]).toBe(false)
    expect(map[b.handle]).toBe(true)
  })

  it('sets the instance-level fixed flag', () => {
    const doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    const handle = instances(doc)[0].handle
    const next = setInstanceFixed(doc, handle, true)
    expect(instances(next)[0].fixed).toBe(true)
    const cleared = setInstanceFixed(next, handle, false)
    expect(instances(cleared)[0].fixed).toBe(false)
  })

  it('does not mutate the input doc', () => {
    const doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    const handle = instances(doc)[0].handle
    setInstanceFixed(doc, handle, true)
    expect(instances(doc)[0].fixed).toBeUndefined()
  })

  // Toggling the fixed flag must not move anything: it bakes every part's current
  // solved pose into its seed so the next solve restarts at the current, already
  // mate-satisfying configuration, and only the toggled part's flag changes.
  it('setInstanceFixedFromSolved bakes all solved poses and flips one flag', () => {
    let doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    doc = appendPartInstance(doc, 'doc-B', 1)
    const [a, b] = instances(doc)
    const poseA = { tx: 5, ty: -2, tz: 3, qx: 0, qy: 0, qz: 0, qw: 1 }
    const poseB = { tx: 1, ty: 1, tz: 1, qx: 0, qy: 0, qz: 0, qw: 1 }
    const next = setInstanceFixedFromSolved(doc, a.handle, true, {
      [a.handle]: poseA,
      [b.handle]: poseB,
    })
    const map = Object.fromEntries(instances(next).map(i => [i.handle, i]))
    // Both seeds are updated to their solved poses; only A's flag flips.
    expect(map[a.handle].transform).toEqual(poseA)
    expect(map[a.handle].fixed).toBe(true)
    expect(map[b.handle].transform).toEqual(poseB)
    expect(map[b.handle].fixed).toBeUndefined()
    // The written transforms are copies, not aliases of the solved map.
    expect(map[a.handle].transform).not.toBe(poseA)
    // Input doc is untouched.
    expect(instances(doc)[0].fixed).toBeUndefined()
  })

  // A part missing from the solved map (e.g. never solved) keeps its own seed
  // rather than losing its pose.
  it('setInstanceFixedFromSolved keeps the seed when no solved pose exists', () => {
    const doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    const handle = instances(doc)[0].handle
    const seed = instances(doc)[0].transform
    const next = setInstanceFixedFromSolved(doc, handle, true, {})
    expect(instances(next)[0].transform).toEqual(seed)
    expect(instances(next)[0].fixed).toBe(true)
  })

  // Same invariant as bakeSolvedTransforms: a fixed instance's seed is authored
  // truth. Toggling one part must not bake the (possibly divergent) solver pose
  // of every OTHER fixed part over its seed.
  it('setInstanceFixedFromSolved does NOT overwrite an already-fixed instance seed except the toggled one', () => {
    let doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    doc = appendPartInstance(doc, 'doc-B', 1)
    doc = setInstanceFixed(doc, instances(doc)[0].handle, true)
    const [a, b] = instances(doc)
    const seedA = { ...a.transform }
    const divergent = { tx: 0.0001, ty: 0, tz: 0, qx: 0.01, qy: 0, qz: 0, qw: 0.99995 }
    const poseB = { tx: 9, ty: 8, tz: 7, qx: 0, qy: 0, qz: 0, qw: 1 }

    const next = setInstanceFixedFromSolved(doc, b.handle, true, {
      [a.handle]: divergent,
      [b.handle]: poseB,
    })
    const map = Object.fromEntries(instances(next).map(i => [i.handle, i]))
    expect(map[a.handle].fixed).toBe(true)
    expect(map[a.handle].transform).toEqual(seedA)  // fixed seed untouched
    expect(map[b.handle].fixed).toBe(true)
    expect(map[b.handle].transform).toEqual(poseB)  // free: baked
    // Input doc is untouched.
    expect(instances(doc)[1].fixed).toBeUndefined()
    expect(instances(doc)[0].transform).toEqual(seedA)
  })

  // The toggled instance itself must still receive the solved transform even
  // when it was already fixed: un-fixing (or re-fixing) it has to freeze the
  // pose on screen into the seed, not leave a stale one behind.
  it('setInstanceFixedFromSolved still bakes the toggled instance when it is fixed', () => {
    let doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    doc = setInstanceFixed(doc, instances(doc)[0].handle, true)
    const a = instances(doc)[0]
    const divergent = { tx: 7, ty: 8, tz: 9, qx: 0, qy: 0, qz: 0, qw: 1 }

    const next = setInstanceFixedFromSolved(doc, a.handle, true, { [a.handle]: divergent })
    const inst = instances(next)[0]
    expect(inst.fixed).toBe(true)
    expect(inst.transform).toEqual(divergent)
  })

  // Same f32-rounding rule as bakeSolvedTransforms: a solve that only re-rounds
  // the seed must not be written while flipping the flag, or the fix toggle
  // ratchets the pose like the drag bake used to.
  it('setInstanceFixedFromSolved leaves a rounding-only solved pose untouched', () => {
    const doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    const handle = instances(doc)[0].handle
    const seed = instances(doc)[0].transform
    const rounding = { tx: 1e-8, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }

    const next = setInstanceFixedFromSolved(doc, handle, true, { [handle]: rounding })
    const inst = instances(next)[0]
    expect(inst.fixed).toBe(true)
    expect(inst.transform).toBe(seed)
  })

  // Re-setting fixed=false on an already-unfixed part changes nothing. The
  // materialized `{ fixed: undefined }` on the untouched sibling must not read
  // as a change, and every untouched feature object must keep its reference.
  it('setInstanceFixedFromSolved is a no-op for a no-op unfix', () => {
    let doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    doc = appendPartInstance(doc, 'doc-B', 1)
    const [a, b] = instances(doc)

    const next = setInstanceFixedFromSolved(doc, a.handle, false, { [b.handle]: { ...b.transform } })

    expect(next.features![0]).toBe(doc.features![0])
    expect(next.features![1]).toBe(doc.features![1])
    expect(assemblyDocEquals(doc, next)).toBe(true)
  })

  // The funnel's compare ignores a key set to undefined: the YAML round-trip
  // cannot tell `{ fixed: undefined }` from an absent `fixed`, so neither may
  // the no-op guard.
  it('assemblyDocEquals ignores an undefined-valued key', () => {
    const doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    const withUndefined: AssemblyDoc = {
      ...doc,
      features: (doc.features ?? []).map(f => f.kind === 'part_instance'
        ? { ...f, instance: { ...f.instance!, fixed: undefined } }
        : f),
    }
    expect(assemblyDocEquals(doc, withUndefined)).toBe(true)
  })

  // An array is order-significant: a reorder IS a change. Unlike an undefined
  // key, it must not be waved through by the touched-slice compare.
  it('assemblyDocEquals treats a reordered array as a change', () => {
    const doc: AssemblyDoc = {
      kind: 'assembly',
      features: [{ id: 'f1', kind: 'origin', tags: ['a', 'b'] } as unknown as AssemblyFeature],
    }
    const same: AssemblyDoc = {
      kind: 'assembly',
      features: [{ id: 'f1', kind: 'origin', tags: ['a', 'b'] } as unknown as AssemblyFeature],
    }
    const reordered: AssemblyDoc = {
      kind: 'assembly',
      features: [{ id: 'f1', kind: 'origin', tags: ['b', 'a'] } as unknown as AssemblyFeature],
    }

    expect(assemblyDocEquals(doc, same)).toBe(true)
    expect(assemblyDocEquals(doc, reordered)).toBe(false)
  })

  // The assembly frame's reserved MateRef handle must never be a value a real
  // instance can be minted with, or a part-anchor lookup would shadow the
  // assembly built-ins. randomId(8) is an 11-char base64url string; the
  // reserved handle is a distinct literal, so they cannot collide.
  it('mints handles that never collide with the reserved assembly handle', () => {
    let doc = emptyDoc
    for (let i = 0; i < 200; i++) {
      const handle = mintInstanceHandle(doc)
      expect(handle).not.toBe(ASSEMBLY_HANDLE)
      doc = appendPartInstance(doc, `doc-${i}`, 1)
    }
  })
})

describe('bakeSolvedTransforms', () => {
  it('writes each free instance solved pose into its seed, leaving flags alone', () => {
    let doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    doc = appendPartInstance(doc, 'doc-B', 1)
    const [a, b] = instances(doc)
    const poseA = { tx: 5, ty: -2, tz: 3, qx: 0, qy: 0, qz: 0, qw: 1 }
    const poseB = { tx: 9, ty: 8, tz: 7, qx: 0, qy: 0, qz: 0, qw: 1 }

    const next = bakeSolvedTransforms(doc, { [a.handle]: poseA, [b.handle]: poseB })
    const map = Object.fromEntries(instances(next).map(i => [i.handle, i]))
    expect(map[a.handle].transform).toEqual(poseA)
    expect(map[b.handle].transform).toEqual(poseB)
    // Fixed flag untouched: baking is not a fix toggle.
    expect(map[a.handle].fixed).toBeUndefined()
    expect(map[b.handle].fixed).toBeUndefined()
    // The written transform is a copy, not an alias of the solved map.
    expect(map[a.handle].transform).not.toBe(poseA)
    // Input doc is untouched.
    expect(instances(doc)[0].transform).toEqual(IDENTITY_TRANSFORM)
  })

  // A fixed instance's seed is the authored truth. Baking a solved pose over
  // it can only write solver error into the document, and each bake compounds
  // the last -- the ratchet that makes a fixed part visibly drift over a
  // session. solveAssembly echoes a fixed part's seed verbatim, so in the
  // real pipeline the two poses agree; this is the guard for everything else.
  it('does NOT overwrite a fixed instance seed, even with a divergent solved pose', () => {
    let doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    doc = appendPartInstance(doc, 'doc-B', 1)
    doc = setInstanceFixed(doc, instances(doc)[0].handle, true)
    const [a, b] = instances(doc)
    const drifted = { tx: 0.0001, ty: 0, tz: 0, qx: 0.01, qy: 0, qz: 0, qw: 0.99995 }
    const poseB = { tx: 9, ty: 8, tz: 7, qx: 0, qy: 0, qz: 0, qw: 1 }

    const next = bakeSolvedTransforms(doc, { [a.handle]: drifted, [b.handle]: poseB })
    const map = Object.fromEntries(instances(next).map(i => [i.handle, i]))
    expect(map[a.handle].transform).toEqual(a.transform)  // fixed: untouched
    expect(map[b.handle].transform).toEqual(poseB)        // free: baked
  })

  it('keeps the seed for a part missing from the solved map', () => {
    const doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    const seed = instances(doc)[0].transform
    const next = bakeSolvedTransforms(doc, {})
    expect(instances(next)[0].transform).toEqual(seed)
  })

  // The mate wire is f32, so a free DOF returns a pose a few f32 ulps off its
  // f64 seed. Baking that rounding persists it, and each commit re-rounds, so
  // the DOF walks and every part churns its document diff. A rounding-only
  // delta must be skipped; a real move must still bake.
  it('skips a solved pose that differs from the seed only by f32 rounding', () => {
    let doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    doc = appendPartInstance(doc, 'doc-B', 1)
    const [a, b] = instances(doc)
    const moved = { tx: 0.001, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }
    const rounding = { tx: 1e-8, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }

    const next = bakeSolvedTransforms(doc, { [a.handle]: moved, [b.handle]: rounding })
    const map = Object.fromEntries(instances(next).map(i => [i.handle, i]))
    expect(map[a.handle].transform).toEqual(moved)
    // Untouched by reference: the feature (and its instance) is the same object.
    expect(map[b.handle].transform).toBe(b.transform)
    expect(map[b.handle].transform).toEqual({ ...IDENTITY_TRANSFORM })
  })
})

describe('setBuiltinVisible', () => {
  const withBuiltins: AssemblyDoc = { kind: 'assembly', features: ASSEMBLY_BUILTIN_DEFAULTS.map(f => ({ ...f })) }

  it('shows and hides the named built-in only', () => {
    const shown = setBuiltinVisible(withBuiltins, ASSEMBLY_TOP_ID, true)
    const map = Object.fromEntries((shown.features ?? []).map(f => [f.id, f.visible]))
    expect(map[ASSEMBLY_TOP_ID]).toBe(true)
    expect(map.AssemblyFront).toBeUndefined()  // untouched, still hidden

    const hidden = setBuiltinVisible(shown, ASSEMBLY_TOP_ID, false)
    expect((hidden.features ?? []).find(f => f.id === ASSEMBLY_TOP_ID)!.visible).toBe(false)
  })

  it('leaves a part instance that shares no id untouched, and does not mutate the input', () => {
    const doc = appendPartInstance(withBuiltins, 'doc-A', 1)
    const next = setBuiltinVisible(doc, ASSEMBLY_TOP_ID, true)
    expect((next.features ?? []).filter(f => f.kind === 'part_instance')).toHaveLength(1)
    expect((withBuiltins.features ?? []).find(f => f.id === ASSEMBLY_TOP_ID)!.visible).toBeUndefined()
  })
})

// ─── Mate features (Stage 8) ───

describe('appendMate', () => {
  it('appends a mate of the requested kind with both references empty', () => {
    const doc = appendMate(emptyDoc, 'fixed', 'm1')
    const mates = mateFeatures(doc)
    expect(mates).toHaveLength(1)
    expect(mates[0].id).toBe('m1')
    expect(mates[0].mate.kind).toBe('fixed')
    expect(mates[0].mate.ref_a).toEqual({ part: '', anchor: '' })
    expect(mates[0].mate.ref_b).toEqual({ part: '', anchor: '' })
  })

  // Each mate owns its own ref objects. A shared EMPTY_MATE_REF would let a pick
  // on one mate silently fill the slot of every other unpicked mate.
  it('gives each mate its own reference objects', () => {
    let doc = appendMate(emptyDoc, 'fixed', 'm1')
    doc = appendMate(doc, 'spherical', 'm2')
    const [a, b] = mateFeatures(doc)
    expect(a.mate.ref_a).not.toBe(b.mate.ref_a)
    doc = setMateRef(doc, 'm1', 'ref_a', { part: 'h1', anchor: 'x' })
    expect(findMate(doc, 'm2')!.ref_a).toEqual({ part: '', anchor: '' })
  })

  it('keeps part instances and mates side by side in one feature list', () => {
    let doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    doc = appendMate(doc, 'fixed', 'm1')
    expect(doc.features).toHaveLength(2)
    expect(mateFeatures(doc)).toHaveLength(1)
  })

  it('does not mutate the input doc', () => {
    appendMate(emptyDoc, 'fixed', 'm1')
    expect(emptyDoc.features).toEqual([])
  })

  // The default name is minted and stored at append time, not derived from the
  // render position. That is what stops deleting an earlier mate of the same
  // kind from renumbering every later one.
  it('mints and stores a stable default label at creation', () => {
    let doc = appendMate(emptyDoc, 'fixed', 'm1')
    expect(findMate(doc, 'm1')!.label).toBe('Fixed 1')
    doc = appendMate(doc, 'fixed', 'm2')
    expect(findMate(doc, 'm2')!.label).toBe('Fixed 2')
    doc = appendMate(doc, 'parallel', 'm3')
    expect(findMate(doc, 'm3')!.label).toBe('Parallel 1')
  })
})

describe('defaultMateName', () => {
  it('picks the lowest free ordinal for the kind', () => {
    expect(defaultMateName(emptyDoc, 'fixed')).toBe('Fixed 1')
    const doc = appendMate(appendMate(emptyDoc, 'fixed', 'm1'), 'parallel', 'm2')
    expect(defaultMateName(doc, 'fixed')).toBe('Fixed 2')
    expect(defaultMateName(doc, 'parallel')).toBe('Parallel 2')
    expect(defaultMateName(doc, 'spherical')).toBe('Spherical 1')
  })

  // A gap left by an earlier clear is reused, not skipped: this is what keeps
  // names collision-free when `exceptId` excludes the mate being renamed.
  it('reuses the lowest free ordinal after a gap', () => {
    let doc = appendMate(appendMate(emptyDoc, 'fixed', 'm1'), 'fixed', 'm2')
    doc = setMateLabel(doc, 'm1', '')
    expect(findMate(doc, 'm1')!.label).toBe('Fixed 1')
    expect(defaultMateName(doc, 'fixed')).toBe('Fixed 3')
  })

  // A custom name must not reserve an ordinal.
  it('ignores labels that are not the kind label plus a number', () => {
    const doc = setMateLabel(appendMate(emptyDoc, 'fixed', 'm1'), 'm1', 'Base clamp')
    expect(defaultMateName(doc, 'fixed')).toBe('Fixed 1')
  })
})

describe('setMateLabel', () => {
  it('stores a non-empty label verbatim', () => {
    const doc = setMateLabel(appendMate(emptyDoc, 'fixed', 'm1'), 'm1', 'Base')
    expect(findMate(doc, 'm1')!.label).toBe('Base')
  })

  // Clearing a name must not delete the key and fall back to a render ordinal:
  // re-mint the same stable default the mate would have been given at append.
  it('re-mints a stable default when cleared, not a render ordinal', () => {
    let doc = appendMate(appendMate(emptyDoc, 'fixed', 'm1'), 'fixed', 'm2')
    doc = setMateLabel(doc, 'm2', 'Renamed')
    expect(findMate(doc, 'm2')!.label).toBe('Renamed')

    doc = setMateLabel(doc, 'm2', '')
    expect(findMate(doc, 'm2')!.label).toBe('Fixed 2')

    // Removing the first mate does not renumber the stored second label.
    doc = removeMate(doc, 'm1')
    expect(findMate(doc, 'm2')!.label).toBe('Fixed 2')
  })

  // Clearing the FIRST of two mates must not mint the second's ordinal: the
  // old count-based re-mint would store "Fixed 2" and duplicate m2.
  it('re-mints a non-last cleared mate without duplicating an existing name', () => {
    let doc = appendMate(appendMate(emptyDoc, 'fixed', 'm1'), 'fixed', 'm2')
    doc = setMateLabel(doc, 'm1', '')

    const labels = mateFeatures(doc).map(m => m.mate.label)
    expect(new Set(labels).size).toBe(labels.length)
    expect(findMate(doc, 'm1')!.label).toBe('Fixed 1')
    expect(findMate(doc, 'm2')!.label).toBe('Fixed 2')

    // A later append still finds a free ordinal above both.
    doc = appendMate(doc, 'fixed', 'm3')
    expect(findMate(doc, 'm3')!.label).toBe('Fixed 3')
  })
})

describe('mintFeatureId', () => {
  it('mints distinct ids', () => {
    expect(mintFeatureId()).not.toBe(mintFeatureId())
  })
})

describe('setMateRef', () => {
  it('writes the picked reference into the named slot only', () => {
    let doc = appendMate(emptyDoc, 'fixed', 'm1')
    doc = setMateRef(doc, 'm1', 'ref_b', { part: 'h2', anchor: 'a2' })
    const mate = findMate(doc, 'm1')!
    expect(mate.ref_b).toEqual({ part: 'h2', anchor: 'a2' })
    expect(mate.ref_a).toEqual({ part: '', anchor: '' })
  })

  it('overwrites a previous pick, which is how the corner cycle re-aims', () => {
    let doc = appendMate(emptyDoc, 'fixed', 'm1')
    doc = setMateRef(doc, 'm1', 'ref_a', { part: 'h1', anchor: 'vertex' })
    doc = setMateRef(doc, 'm1', 'ref_a', { part: 'h1', anchor: 'edge' })
    expect(findMate(doc, 'm1')!.ref_a.anchor).toBe('edge')
  })

  it('copies the reference rather than aliasing the caller object', () => {
    const ref = { part: 'h1', anchor: 'a1' }
    const doc = setMateRef(appendMate(emptyDoc, 'fixed', 'm1'), 'm1', 'ref_a', ref)
    ref.anchor = 'mutated'
    expect(findMate(doc, 'm1')!.ref_a.anchor).toBe('a1')
  })

  it('is a no-op for an unknown feature id', () => {
    const doc = appendMate(emptyDoc, 'fixed', 'm1')
    const next = setMateRef(doc, 'nope', 'ref_a', { part: 'h1', anchor: 'a1' })
    expect(findMate(next, 'm1')!.ref_a).toEqual({ part: '', anchor: '' })
  })

  it('accepts the reserved assembly handle as a reference', () => {
    let doc = appendMate(emptyDoc, 'fixed', 'm1')
    doc = setMateRef(doc, 'm1', 'ref_b', { part: ASSEMBLY_HANDLE, anchor: 'AssemblyTop' })
    expect(findMate(doc, 'm1')!.ref_b.part).toBe(ASSEMBLY_HANDLE)
  })
})

describe('updateMate', () => {
  it('sets a scalar parameter', () => {
    let doc = appendMate(emptyDoc, 'fixed', 'm1')
    doc = updateMate(doc, 'm1', { offset: 12 })
    expect(findMate(doc, 'm1')!.offset).toBe(12)
  })

  // A YAML round-trip turns `offset: undefined` into `offset: null`, which reads
  // back as a value the solver would coerce. Unsetting has to delete the key.
  it('deletes a key rather than storing undefined', () => {
    let doc = appendMate(emptyDoc, 'fixed', 'm1')
    doc = updateMate(doc, 'm1', { offset: 12 })
    doc = updateMate(doc, 'm1', { offset: undefined })
    expect('offset' in findMate(doc, 'm1')!).toBe(false)
  })

  it('leaves the references and the kind alone', () => {
    let doc = appendMate(emptyDoc, 'fixed', 'm1')
    doc = setMateRef(doc, 'm1', 'ref_a', { part: 'h1', anchor: 'a1' })
    doc = updateMate(doc, 'm1', { offset: 90 })
    const mate = findMate(doc, 'm1')!
    expect(mate.kind).toBe('fixed')
    expect(mate.ref_a).toEqual({ part: 'h1', anchor: 'a1' })
  })

  it('sets a boolean parameter and unsets it by deleting the key', () => {
    let doc = appendMate(emptyDoc, 'parallel', 'm1')
    doc = updateMate(doc, 'm1', { flip: true })
    expect(findMate(doc, 'm1')!.flip).toBe(true)
    doc = updateMate(doc, 'm1', { flip: undefined })
    expect('flip' in findMate(doc, 'm1')!).toBe(false)
  })

  it('touches only the named mate', () => {
    let doc = appendMate(appendMate(emptyDoc, 'fixed', 'm1'), 'fixed', 'm2')
    doc = updateMate(doc, 'm1', { offset: 5 })
    expect(findMate(doc, 'm2')!.offset).toBeUndefined()
  })

  it('does not mutate the input doc', () => {
    const doc = appendMate(emptyDoc, 'fixed', 'm1')
    updateMate(doc, 'm1', { offset: 3 })
    expect(findMate(doc, 'm1')!.offset).toBeUndefined()
  })

  // `offset` widened from a scalar to a 3D vector, so the patch path now carries
  // an object. It must be stored verbatim: the components are individually
  // optional, and filling in the missing ones would author values the user
  // never asked for.
  it('stores a vector offset with only the components it was given', () => {
    let doc = appendMate(emptyDoc, 'fixed', 'm1')
    doc = updateMate(doc, 'm1', { offset: { x: 1, z: 3 } })
    expect(findMate(doc, 'm1')!.offset).toEqual({ x: 1, z: 3 })
  })

  it('deletes a vector offset rather than storing an all-zero one', () => {
    let doc = appendMate(emptyDoc, 'fixed', 'm1')
    doc = updateMate(doc, 'm1', { offset: { x: 1, y: 2, z: 3 } })
    doc = updateMate(doc, 'm1', { offset: undefined })
    expect('offset' in findMate(doc, 'm1')!).toBe(false)
  })
})

describe('removeMate', () => {
  it('drops only the matching mate', () => {
    let doc = appendMate(appendMate(emptyDoc, 'fixed', 'm1'), 'spherical', 'm2')
    doc = removeMate(doc, 'm1')
    expect(mateFeatures(doc).map(m => m.id)).toEqual(['m2'])
  })

  it('leaves part instances in place', () => {
    let doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    doc = appendMate(doc, 'fixed', 'm1')
    doc = removeMate(doc, 'm1')
    expect(instances(doc)).toHaveLength(1)
  })

  it('is a no-op for an unknown feature id', () => {
    const doc = removeMate(appendMate(emptyDoc, 'fixed', 'm1'), 'nope')
    expect(mateFeatures(doc)).toHaveLength(1)
  })
})

describe('mateFeatures / findMate', () => {
  it('pairs each mate with the feature id the solver keys its result by', () => {
    const doc = appendMate(emptyDoc, 'rotating', 'm7')
    expect(mateFeatures(doc)[0]).toMatchObject({ id: 'm7', mate: { kind: 'rotating' } })
  })

  it('returns undefined for an unknown id', () => {
    expect(findMate(appendMate(emptyDoc, 'fixed', 'm1'), 'nope')).toBeUndefined()
  })

  it('treats an undefined features list as empty', () => {
    expect(mateFeatures({ kind: 'assembly' } as AssemblyDoc)).toEqual([])
  })
})

// The one extraction the page and the doc hook both read through. Document
// ORDER is the property that matters most and is the least obvious: the store's
// `sameInstances` compares position by position, so a reordering extraction
// would report every reorder as no change at all.
describe('partInstances', () => {
  const mixed: AssemblyDoc = {
    kind: 'assembly',
    features: [
      { id: ASSEMBLY_TOP_ID, kind: 'plane' },
      { id: 'f1', kind: 'part_instance', instance: { handle: 'h1', doc_id: 'd1', doc_rev: 1, transform: { ...IDENTITY_TRANSFORM } } },
      { id: 'm1', kind: 'mate', mate: { kind: 'fixed', ref_a: EMPTY_MATE_REF, ref_b: EMPTY_MATE_REF } },
      { id: 'f2', kind: 'part_instance', instance: { handle: 'h2', doc_id: 'd2', doc_rev: 1, transform: { ...IDENTITY_TRANSFORM } } },
    ],
  }

  it('keeps document order and skips every other feature kind', () => {
    expect(partInstances(mixed).map(i => i.handle)).toEqual(['h1', 'h2'])
  })

  it('hands on the doc\'s own instance objects rather than copies', () => {
    // What lets `sameInstances` take its identity fast path: an untouched
    // feature survives a doc mutation by reference, so the instance inside it
    // is the very same object on both sides of the comparison.
    expect(partInstances(mixed)[0]).toBe(mixed.features![1].instance)
  })

  it('agrees with the extraction the rest of this file uses as its oracle', () => {
    expect(partInstances(mixed)).toEqual(instances(mixed))
  })

  it('reads a null doc, an absent features list and a kind-only feature as no parts', () => {
    expect(partInstances(null)).toEqual([])
    expect(partInstances({ kind: 'assembly' } as AssemblyDoc)).toEqual([])
    // A `part_instance` feature with no `instance` payload is malformed user
    // YAML, not a part: it is dropped rather than yielding an undefined entry
    // that every downstream reader would have to guard against.
    expect(partInstances({ kind: 'assembly', features: [{ id: 'f1', kind: 'part_instance' }] })).toEqual([])
  })
})

describe('emptyAssemblyDoc', () => {
  it('is what DocumentPage routes to the assembly editor on', () => {
    expect(emptyAssemblyDoc().kind).toBe('assembly')
  })

  it('leaves features empty so useAssemblyDoc prepends the assembly built-ins', () => {
    // Baking the origin + 3 planes in here would give them a second minting site.
    expect(emptyAssemblyDoc().features).toEqual([])
  })

  it('returns a fresh doc each call (no shared features array)', () => {
    const a = emptyAssemblyDoc()
    const b = emptyAssemblyDoc()
    expect(a.features).not.toBe(b.features)
  })
})

describe('setInstancePosition / setInstanceRotation (numeric reseat)', () => {
  // The handle has to come from the same doc the mutation runs on.
  function fixedDoc(): { doc: AssemblyDoc; handle: string } {
    const base = appendPartInstance(emptyDoc, 'doc-A', 1)
    const handle = instances(base)[0].handle
    return { doc: setInstanceFixed(base, handle, true), handle }
  }

  it('orients a FIXED instance: the gizmo refuses it, so this is the only way', () => {
    const { doc, handle } = fixedDoc()
    // setInstanceTransform is vetoed for a fixed part...
    const vetoed = setInstanceTransform(doc, handle, { ...IDENTITY_TRANSFORM, qz: 1, qw: 0 })
    expect(instances(vetoed)[0].transform).toEqual(IDENTITY_TRANSFORM)
    // ...but the explicit numeric reseat is not.
    const turned = setInstanceRotation(doc, handle, { rx: 0, ry: 0, rz: 90 })
    expect(instances(turned)[0].fixed).toBe(true)
    expect(instanceRotation(instances(turned)[0]).rz).toBeCloseTo(90, 9)
  })

  it('round-trips degrees through the stored quaternion', () => {
    const { doc, handle } = fixedDoc()
    const next = setInstanceRotation(doc, handle, { rx: 30, ry: -45, rz: 120 })
    const back = instanceRotation(instances(next)[0])
    expect(back.rx).toBeCloseTo(30, 6)
    expect(back.ry).toBeCloseTo(-45, 6)
    expect(back.rz).toBeCloseTo(120, 6)
  })

  it('stores a unit quaternion', () => {
    const { doc, handle } = fixedDoc()
    const t = instances(setInstanceRotation(doc, handle, { rx: 10, ry: 20, rz: 30 }))[0].transform
    expect(Math.hypot(t.qx, t.qy, t.qz, t.qw)).toBeCloseTo(1, 12)
  })

  it('rotation leaves the translation alone, and position leaves the orientation alone', () => {
    const { doc, handle } = fixedDoc()
    const placed = setInstancePosition(doc, handle, { tx: 1, ty: 2, tz: 3 })
    const turned = setInstanceRotation(placed, handle, { rx: 0, ry: 0, rz: 90 })
    const t = instances(turned)[0].transform
    expect([t.tx, t.ty, t.tz]).toEqual([1, 2, 3])

    const moved = setInstancePosition(turned, handle, { tx: 9, ty: 9, tz: 9 })
    const m = instances(moved)[0].transform
    expect([m.qx, m.qy, m.qz, m.qw]).toEqual([t.qx, t.qy, t.qz, t.qw])
  })

  it('touches only the addressed instance and no-ops on an unknown handle', () => {
    let doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    doc = appendPartInstance(doc, 'doc-B', 1)
    const [a, b] = instances(doc)
    const next = setInstanceRotation(doc, a.handle, { rx: 0, ry: 0, rz: 90 })
    const map = Object.fromEntries(instances(next).map(i => [i.handle, i.transform]))
    expect(map[b.handle]).toEqual(b.transform)
    expect(map[a.handle]).not.toEqual(a.transform)
    expect(instances(setInstanceRotation(doc, 'nope', { rx: 0, ry: 0, rz: 90 }))).toEqual(instances(doc))
  })

  it('reads identity as all-zero degrees', () => {
    const doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    const r = instanceRotation(instances(doc)[0])
    expect(r.rx).toBeCloseTo(0, 12)
    expect(r.ry).toBeCloseTo(0, 12)
    expect(r.rz).toBeCloseTo(0, 12)
  })
})

describe('reorderFeature / moveInstance / moveMate', () => {
  function inst(handle: string): PartInstance {
    return { handle, doc_id: 'd', doc_rev: 1, transform: { ...IDENTITY_TRANSFORM }, visible: true }
  }
  // origin, three parts, two mates: enough to prove a moved feature stays inside
  // its own kind group and that "before" lands on either side of the target.
  const sample = (): AssemblyDoc => ({
    kind: 'assembly',
    features: [
      { id: 'origin', kind: 'origin' },
      { id: 'fp1', kind: 'part_instance', instance: inst('h1') },
      { id: 'fp2', kind: 'part_instance', instance: inst('h2') },
      { id: 'fp3', kind: 'part_instance', instance: inst('h3') },
      { id: 'fm1', kind: 'mate' },
      { id: 'fm2', kind: 'mate' },
    ],
  })
  const order = (d: AssemblyDoc) => (d.features ?? []).map(f => f.id)

  it('moves a feature before a later target', () => {
    expect(order(reorderFeature(sample(), 'fp1', 'fp3')))
      .toEqual(['origin', 'fp2', 'fp1', 'fp3', 'fm1', 'fm2'])
  })

  it('moves a feature before an earlier target', () => {
    expect(order(reorderFeature(sample(), 'fp3', 'fp1')))
      .toEqual(['origin', 'fp3', 'fp1', 'fp2', 'fm1', 'fm2'])
  })

  it('a null target lands past the last sibling of the moved feature kind', () => {
    // A part dropped past the last row stays before the mates, not below them.
    expect(order(reorderFeature(sample(), 'fp1', null)))
      .toEqual(['origin', 'fp2', 'fp3', 'fp1', 'fm1', 'fm2'])
    expect(order(reorderFeature(sample(), 'fm1', null)))
      .toEqual(['origin', 'fp1', 'fp2', 'fp3', 'fm2', 'fm1'])
  })

  it('no-ops on a self-drop or a missing id', () => {
    expect(order(reorderFeature(sample(), 'fp2', 'fp2'))).toEqual(order(sample()))
    expect(order(reorderFeature(sample(), 'nope', 'fp1'))).toEqual(order(sample()))
    expect(order(reorderFeature(sample(), 'fp1', 'nope'))).toEqual(order(sample()))
  })

  it('moveInstance reorders by handle, before a sibling and to the end', () => {
    expect(order(moveInstance(sample(), 'h3', 'h1')))
      .toEqual(['origin', 'fp3', 'fp1', 'fp2', 'fm1', 'fm2'])
    expect(order(moveInstance(sample(), 'h1', null)))
      .toEqual(['origin', 'fp2', 'fp3', 'fp1', 'fm1', 'fm2'])
  })

  it('moveInstance no-ops on an unknown moving or target handle', () => {
    expect(order(moveInstance(sample(), 'nope', 'h1'))).toEqual(order(sample()))
    expect(order(moveInstance(sample(), 'h1', 'nope'))).toEqual(order(sample()))
  })

  it('moveMate reorders by feature id', () => {
    expect(order(moveMate(sample(), 'fm2', 'fm1')))
      .toEqual(['origin', 'fp1', 'fp2', 'fp3', 'fm2', 'fm1'])
  })

  it('does not mutate the input document', () => {
    const doc = sample()
    const before = order(doc)
    reorderFeature(doc, 'fp1', 'fp3')
    expect(order(doc)).toEqual(before)
  })
})

// The inline editor's Cancel path reverts the live edits it applied in one write,
// so each replace has to restore the whole prior snapshot rather than patch the
// fields it happens to remember.
describe('replaceInstance / replaceMate (inline editor cancel)', () => {
  it('replaceInstance restores a whole prior instance snapshot over live edits', () => {
    const doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    const handle = instances(doc)[0].handle
    const snapshot = instances(doc)[0]

    let edited = setInstancePosition(doc, handle, { tx: 9, ty: 8, tz: 7 })
    edited = setInstanceVisible(edited, handle, false)
    edited = setInstanceFixed(edited, handle, true)
    // The live edits really did move the addressed instance away from the snapshot.
    expect(instances(edited)[0]).not.toEqual(snapshot)

    const restored = instances(replaceInstance(edited, handle, snapshot))[0]
    expect(restored).toEqual(snapshot)
    // Stored as a copy, so a later edit to the restored instance cannot alias the
    // snapshot the caller still holds.
    expect(restored).not.toBe(snapshot)
  })

  it('replaceMate restores a whole mate def, overwriting live ref and param edits', () => {
    const doc = appendMate(emptyDoc, 'fixed', 'm1')
    const snapshot = findMate(doc, 'm1')!

    let edited = setMateRef(doc, 'm1', 'ref_a', { part: 'h1', anchor: 'a_f' })
    edited = updateMate(edited, 'm1', { offset: 5 })
    expect(findMate(edited, 'm1')).not.toEqual(snapshot)

    const restored = findMate(replaceMate(edited, 'm1', snapshot), 'm1')!
    expect(restored).toEqual(snapshot)
    expect(restored).not.toBe(snapshot)
  })
})
