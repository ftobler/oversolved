import { describe, it, expect } from 'vitest'
import type { AssemblyDoc, PartInstance } from '@/types/cad'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'
import {
  buildAssemblyTree,
  flattenAssemblyTree,
  leafPathOf,
  topHandleOf,
  type AssemblyTreeSource,
} from '@/utils/assemblyTreeModel'

function instance(handle: string, docId: string): PartInstance {
  return { handle, doc_id: docId, doc_rev: 0, transform: { ...IDENTITY_TRANSFORM } }
}

function assembly(handles: Array<[string, string]>): AssemblyDoc {
  return {
    kind: 'assembly',
    features: handles.map(([handle, docId], i) => ({
      id: `f${i}`,
      kind: 'part_instance' as const,
      instance: instance(handle, docId),
    })),
  }
}

function source(
  docs: Record<string, AssemblyDoc | null>,
  kinds: Record<string, 'part' | 'assembly'>,
): AssemblyTreeSource {
  return {
    docFor: docId => (docId in docs ? docs[docId] : undefined),
    kindOf: docId => kinds[docId],
    nameOf: (handle, docId) => docs[docId] ? handle : docId,
  }
}

describe('buildAssemblyTree', () => {
  const parent = [instance('sub', 'asm-sub'), instance('bracket', 'part-b')]
  const subDoc = assembly([['bolt', 'part-bolt']])
  const src = source(
    { 'asm-sub': subDoc },
    { 'asm-sub': 'assembly', 'part-b': 'part', 'part-bolt': 'part' },
  )

  it('nests a sub-assembly child at depth 1', () => {
    const tree = buildAssemblyTree(parent, src)
    expect(tree.map(node => node.key)).toEqual(['sub', 'bracket'])
    expect(tree[0].kind).toBe('assembly')
    expect(tree[0].depth).toBe(0)
    expect(tree[0].children).toHaveLength(1)
    expect(tree[0].children[0].key).toBe('sub/bolt')
    expect(tree[0].children[0].depth).toBe(1)
  })

  it('marks only top-level rows editable', () => {
    const tree = buildAssemblyTree(parent, src)
    expect(tree[0].editable).toBe(true)
    expect(tree[1].editable).toBe(true)
    expect(tree[0].children[0].editable).toBe(false)
  })

  it('the same sub-assembly placed twice gives distinct keys and subtrees', () => {
    const twice = [instance('left', 'asm-sub'), instance('right', 'asm-sub')]
    const tree = buildAssemblyTree(twice, src)
    expect(tree.map(node => node.key)).toEqual(['left', 'right'])
    expect(tree[0].children[0].key).toBe('left/bolt')
    expect(tree[1].children[0].key).toBe('right/bolt')
  })

  it('a missing child document yields a failed leaf node, not a throw', () => {
    const broken = source({ 'asm-sub': null }, { 'asm-sub': 'assembly' })
    const tree = buildAssemblyTree(parent, broken)
    expect(tree[0].failed).toBe(true)
    expect(tree[0].children).toEqual([])
  })

  it('a cycle in a hand-edited document stops at the repeated doc', () => {
    const self = assembly([['again', 'asm-self']])
    const cyclic = source({ 'asm-self': self }, { 'asm-self': 'assembly' })
    const tree = buildAssemblyTree([instance('top', 'asm-self')], cyclic)
    expect(tree[0].children[0].key).toBe('top/again')
    expect(tree[0].children[0].failed).toBe(true)
  })

  it('flatten reports render order, and the path helpers name the top and the leaf', () => {
    const tree = buildAssemblyTree(parent, src)
    expect(flattenAssemblyTree(tree).map(node => node.key)).toEqual(['sub', 'sub/bolt', 'bracket'])
    const child = tree[0].children[0]
    expect(topHandleOf(child)).toBe('sub')
    expect(leafPathOf(child)).toBe('bolt')
    expect(leafPathOf(tree[1])).toBeUndefined()
  })
})
