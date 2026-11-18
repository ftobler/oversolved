import { describe, it, expect } from 'vitest'
import { addReference, cyclePath, referencesOf, referentsOf, removeReference, resolveReferences, wouldCreateCycle } from '../refs'
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

  it('removing edges never leaves an empty source key behind', () => {
    const tree = treeWith([documentEntry('a', 'A'), documentEntry('b', 'B')])

    // An edge that was never there is a no-op, not a new empty row.
    removeReference(tree, 'a', 'ghost')
    expect(tree.manifest.references).toEqual({})
    expect(referencesOf(tree, 'a')).toEqual([])

    addReference(tree, 'a', 'b')
    removeReference(tree, 'a', 'b')
    // The map omits the source entirely once its last target is gone, so no
    // reader has to know that an empty list means "no edges".
    expect('a' in tree.manifest.references).toBe(false)
    expect(referencesOf(tree, 'a')).toEqual([])
  })

  it('referencesOf returns a copy, not the live manifest array', () => {
    const tree = treeWith([documentEntry('a', 'A')])
    addReference(tree, 'a', 'z')
    referencesOf(tree, 'a').push('mutated')
    expect(tree.manifest.references.a).toEqual(['z'])
  })
})

describe('the assembly cycle rule', () => {
  it('refuses an assembly inside itself', () => {
    expect(wouldCreateCycle({}, 'A', 'A')).toBe(true)
    expect(cyclePath({}, 'A', 'A')).toEqual(['A'])
  })

  it('refuses a direct cycle: B already contains A, so A cannot contain B', () => {
    const edges = { B: ['A'] }
    expect(wouldCreateCycle(edges, 'A', 'B')).toBe(true)
    expect(cyclePath(edges, 'A', 'B')).toEqual(['B', 'A'])
    // The other direction is the ordinary placement, not a cycle.
    expect(wouldCreateCycle(edges, 'B', 'A')).toBe(false)
  })

  it('refuses an indirect three-deep cycle and names the path', () => {
    const edges = { C: ['B'], B: ['A'] }
    expect(cyclePath(edges, 'A', 'C')).toEqual(['C', 'B', 'A'])
  })

  it('allows a diamond: two containers of one assembly are not a cycle', () => {
    // left and right both contain leaf; neither reaches the other, so placing
    // one inside the other is a legal nested placement, not a cycle.
    const edges = { left: ['leaf'], right: ['leaf'] }
    expect(wouldCreateCycle(edges, 'right', 'left')).toBe(false)
    expect(wouldCreateCycle(edges, 'left', 'right')).toBe(false)
    // But the shared child cannot become a container of either parent.
    expect(wouldCreateCycle(edges, 'leaf', 'left')).toBe(true)
  })

  it('terminates on a pre-existing cycle in a hand-edited graph', () => {
    const edges = { A: ['B'], B: ['C'], C: ['A'] }
    expect(wouldCreateCycle(edges, 'X', 'A')).toBe(false)
    expect(wouldCreateCycle(edges, 'A', 'X')).toBe(false)
    expect(wouldCreateCycle(edges, 'C', 'A')).toBe(true)
  })

  it('parts and files never count: only an assembly edge is a container', () => {
    // A part references a file, and a file's bytes name an assembly id in some
    // text; neither is a container edge in the manifest.
    const edges = { part1: ['file1'] }
    expect(wouldCreateCycle(edges, 'part1', 'file1')).toBe(false)
  })
})
