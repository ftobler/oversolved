// The explicit-id half of the assembly mutators, added for the drive: a script
// step authors the handle, the feature id, the pose and the whole mate in one
// call, so one step is one undo entry and a rerun mints the same ids (D9, D10).
// The no-options call is the UI path and must keep its minted identity.

import { describe, it, expect } from 'vitest'
import type { AssemblyDoc, MateRef, Transform3D } from '@/types/cad'
import { appendMate, appendPartInstance, duplicateInstance, findMate, partInstances } from '../assemblyMutations'
import { IDENTITY_TRANSFORM } from '../transform3d'

const EMPTY: AssemblyDoc = { kind: 'assembly', features: [] }

const POSE: Transform3D = { tx: 1, ty: 2, tz: 3, qx: 0, qy: 0, qz: 0, qw: 1 }

const REF_A: MateRef = { part: 'left', anchor: 'a_left' }
const REF_B: MateRef = { part: 'right', anchor: 'a_right' }

describe('appendPartInstance with explicit identity', () => {
  it('writes exactly the authored handle, feature id, pose and fixed flag', () => {
    const doc = appendPartInstance(EMPTY, 'rail_400', 0, {
      handle: 'left',
      featureId: 'inst_left',
      transform: POSE,
      fixed: true,
    })
    expect(doc.features).toHaveLength(1)
    expect(doc.features![0]).toEqual({
      id: 'inst_left',
      kind: 'part_instance',
      instance: { handle: 'left', doc_id: 'rail_400', doc_rev: 0, transform: POSE, visible: true, fixed: true },
    })
  })

  it('keeps the old minted shape when the caller passes no options', () => {
    const doc = appendPartInstance(EMPTY, 'rail_400', 0)
    const feature = doc.features![0]
    expect(Object.keys(feature).sort()).toEqual(['id', 'instance', 'kind'])
    const instance = feature.instance!
    expect(Object.keys(instance).sort()).toEqual(['doc_id', 'doc_rev', 'handle', 'transform', 'visible'])
    expect(instance.handle).not.toBe('')
    expect(instance.handle).not.toBe('left')
    expect(instance.transform).toEqual(IDENTITY_TRANSFORM)
    expect(instance.fixed).toBeUndefined()
  })

  it('duplicates onto an authored handle and feature id', () => {
    const base = appendPartInstance(EMPTY, 'rail', 0, { handle: 'left', featureId: 'inst_left', transform: POSE })
    const copy = duplicateInstance(base, 'left', { handle: 'right', featureId: 'inst_right' })
    expect(copy.features![1]).toMatchObject({
      id: 'inst_right',
      instance: { handle: 'right', doc_id: 'rail', transform: POSE },
    })
    // A copy never carries the source's fixed claim.
    expect(copy.features![1].instance!.fixed).toBeUndefined()
  })
})

describe('appendMate with refs, label and patch', () => {
  it('writes one complete mate and defaults the label through defaultMateName', () => {
    const doc = appendMate(EMPTY, 'fixed', 'm1', { ref_a: REF_A, ref_b: REF_B, patch: { flip: true } })
    const mate = findMate(doc, 'm1')!
    expect(mate).toEqual({ kind: 'fixed', label: 'Fixed 1', ref_a: REF_A, ref_b: REF_B, flip: true })
  })

  it('keeps an authored label', () => {
    const doc = appendMate(EMPTY, 'fixed', 'm1', { label: 'seat' })
    expect(findMate(doc, 'm1')!.label).toBe('seat')
  })

  it('deletes a patched key whose value is undefined, like updateMate', () => {
    const doc = appendMate(EMPTY, 'fixed', 'm1', { patch: { flip: true, angle: undefined } })
    const mate = findMate(doc, 'm1')!
    expect(mate.flip).toBe(true)
    expect('angle' in mate).toBe(false)
  })

  it('leaves both refs empty when a bare mate is inserted', () => {
    const doc = appendMate(EMPTY, 'spherical', 'm1')
    expect(findMate(doc, 'm1')!.ref_a).toEqual({ part: '', anchor: '' })
    expect(partInstances(doc)).toEqual([])
  })
})
