import { describe, it, expect } from 'vitest'
import type { AssemblyDoc, PartInstance } from '@/types/cad'
import {
  appendPartInstance,
  removeInstance,
  setInstanceVisible,
  setInstanceFixed,
  mintInstanceHandle,
  IDENTITY_TRANSFORM,
} from '@/utils/assemblyMutations'

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
})
