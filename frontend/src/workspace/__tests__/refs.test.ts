import { describe, it, expect } from 'vitest'
import { addReference, referencesOf, referentsOf, removeReference, resolveReferences } from '../refs'
import { deserializeTree, serializeTree } from '../serializer'
import { documentEntry, treeWith } from './fixtures'

describe('uuid to uuid references (A7, C5 preview)', () => {
  it('addReference sorts and deduplicates target ids', () => {
    const tree = treeWith([documentEntry('a', 'A')])
    addReference(tree, 'a', 'z')
    addReference(tree, 'a', 'm')
    addReference(tree, 'a', 'm')
    expect(referencesOf(tree, 'a')).toEqual(['m', 'z'])

    removeReference(tree, 'a', 'm')
    expect(referencesOf(tree, 'a')).toEqual(['z'])
  })

  it('a document to document reference serializes and resolves', () => {
    const tree = treeWith([documentEntry('a', 'A'), documentEntry('b', 'B')])
    addReference(tree, 'b', 'a')

    const reopened = deserializeTree(serializeTree(tree))
    expect(resolveReferences(reopened)).toEqual([{ from: 'b', to: 'a', resolved: true }])
  })

  it('an assembly to assembly edge is legal: the format puts no kind on the edge', () => {
    const tree = treeWith([
      documentEntry('a', 'A', { docKind: 'assembly' }),
      documentEntry('b', 'B', { docKind: 'assembly' }),
    ])
    addReference(tree, 'a', 'b')
    const edge = tree.manifest.references.a
    expect(edge).toEqual(['b'])
    expect(edge.join()).not.toContain('assembly')
    expect(resolveReferences(tree)).toEqual([{ from: 'a', to: 'b', resolved: true }])
  })

  it('a dangling reference serializes and resolves as unresolved, without throwing', () => {
    const tree = treeWith([documentEntry('a', 'A')])
    addReference(tree, 'a', 'ghost')

    expect(() => serializeTree(tree)).not.toThrow()
    const reopened = deserializeTree(serializeTree(tree))
    expect(resolveReferences(reopened)).toEqual([{ from: 'a', to: 'ghost', resolved: false }])
  })

  it('referentsOf returns the where-used set', () => {
    const tree = treeWith([documentEntry('part', 'Part'), documentEntry('x', 'X'), documentEntry('y', 'Y')])
    addReference(tree, 'x', 'part')
    addReference(tree, 'y', 'part')
    expect(referentsOf(tree, 'part')).toEqual(['x', 'y'])
    expect(referentsOf(tree, 'nobody')).toEqual([])
  })
})
