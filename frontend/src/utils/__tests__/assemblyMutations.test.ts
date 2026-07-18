import { describe, it, expect } from 'vitest'
import type { AssemblyDoc, PartInstance } from '@/types/cad'
import {
  appendMate,
  appendPartInstance,
  bakeSolvedTransforms,
  emptyAssemblyDoc,
  findMate,
  mateFeatures,
  mintFeatureId,
  mintInstanceHandle,
  removeInstance,
  removeMate,
  setBuiltinVisible,
  setInstanceVisible,
  setInstanceFixed,
  setInstanceFixedFromSolved,
  setInstancePosition,
  setInstanceRotation,
  setInstanceTransform,
  instanceRotation,
  setMateRef,
  updateMate,
  IDENTITY_TRANSFORM,
} from '@/utils/assemblyMutations'
import { ASSEMBLY_HANDLE, ASSEMBLY_BUILTIN_DEFAULTS, ASSEMBLY_TOP_ID } from '@/utils/assemblyBuiltins'

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

  it('sets the fixed (ground) flag', () => {
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

  // Toggling ground must not move anything: it bakes every part's current
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
    // Grounded flag untouched: baking is not a ground toggle.
    expect(map[a.handle].fixed).toBeUndefined()
    expect(map[b.handle].fixed).toBeUndefined()
    // The written transform is a copy, not an alias of the solved map.
    expect(map[a.handle].transform).not.toBe(poseA)
    // Input doc is untouched.
    expect(instances(doc)[0].transform).toEqual(IDENTITY_TRANSFORM)
  })

  // A grounded instance's seed is the authored truth. Baking a solved pose over
  // it can only write solver error into the document, and each bake compounds
  // the last -- the ratchet that makes a grounded part visibly drift over a
  // session. solveAssembly echoes a grounded part's seed verbatim, so in the
  // real pipeline the two poses agree; this is the guard for everything else.
  it('does NOT overwrite a grounded instance seed, even with a divergent solved pose', () => {
    let doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    doc = appendPartInstance(doc, 'doc-B', 1)
    doc = setInstanceFixed(doc, instances(doc)[0].handle, true)
    const [a, b] = instances(doc)
    const drifted = { tx: 0.0001, ty: 0, tz: 0, qx: 0.01, qy: 0, qz: 0, qw: 0.99995 }
    const poseB = { tx: 9, ty: 8, tz: 7, qx: 0, qy: 0, qz: 0, qw: 1 }

    const next = bakeSolvedTransforms(doc, { [a.handle]: drifted, [b.handle]: poseB })
    const map = Object.fromEntries(instances(next).map(i => [i.handle, i]))
    expect(map[a.handle].transform).toEqual(a.transform)  // grounded: untouched
    expect(map[b.handle].transform).toEqual(poseB)        // free: baked
  })

  it('keeps the seed for a part missing from the solved map', () => {
    const doc = appendPartInstance(emptyDoc, 'doc-A', 1)
    const seed = instances(doc)[0].transform
    const next = bakeSolvedTransforms(doc, {})
    expect(instances(next)[0].transform).toEqual(seed)
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
  function groundedDoc(): { doc: AssemblyDoc; handle: string } {
    const base = appendPartInstance(emptyDoc, 'doc-A', 1)
    const handle = instances(base)[0].handle
    return { doc: setInstanceFixed(base, handle, true), handle }
  }

  it('orients a GROUNDED instance: the gizmo refuses it, so this is the only way', () => {
    const { doc, handle } = groundedDoc()
    // setInstanceTransform is vetoed for a grounded part...
    const vetoed = setInstanceTransform(doc, handle, { ...IDENTITY_TRANSFORM, qz: 1, qw: 0 })
    expect(instances(vetoed)[0].transform).toEqual(IDENTITY_TRANSFORM)
    // ...but the explicit numeric reseat is not.
    const turned = setInstanceRotation(doc, handle, { rx: 0, ry: 0, rz: 90 })
    expect(instances(turned)[0].fixed).toBe(true)
    expect(instanceRotation(instances(turned)[0]).rz).toBeCloseTo(90, 9)
  })

  it('round-trips degrees through the stored quaternion', () => {
    const { doc, handle } = groundedDoc()
    const next = setInstanceRotation(doc, handle, { rx: 30, ry: -45, rz: 120 })
    const back = instanceRotation(instances(next)[0])
    expect(back.rx).toBeCloseTo(30, 6)
    expect(back.ry).toBeCloseTo(-45, 6)
    expect(back.rz).toBeCloseTo(120, 6)
  })

  it('stores a unit quaternion', () => {
    const { doc, handle } = groundedDoc()
    const t = instances(setInstanceRotation(doc, handle, { rx: 10, ry: 20, rz: 30 }))[0].transform
    expect(Math.hypot(t.qx, t.qy, t.qz, t.qw)).toBeCloseTo(1, 12)
  })

  it('rotation leaves the translation alone, and position leaves the orientation alone', () => {
    const { doc, handle } = groundedDoc()
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
