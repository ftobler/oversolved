import { describe, it, expect } from 'vitest'
import { remapTree } from '../import'
import { addReference } from '../refs'
import { documentEntry, fileEntry, bytesOf, treeWith } from './fixtures'

// remapTree is the one id re-mint pass: references, provenance and trash all go
// through the map in the same pass, and the workspace id is always replaced.

function source() {
  const tree = treeWith([
    documentEntry('a', 'A', { text: 'kind: part\n' }),
    fileEntry('b', 'b.step', bytesOf([1, 2, 3]), 'application/step'),
    documentEntry('c', 'C', { text: 'kind: assembly\n' }),
  ], 'old-ws')
  addReference(tree, 'c', 'a')
  addReference(tree, 'c', 'b')
  tree.manifest.provenance = [{ entry: 'a', origin: 'before' }]
  tree.manifest.trash = ['b']
  return tree
}

describe('remapTree', () => {
  it('keeps entry ids when mintIds is false but always re-mints the workspace', () => {
    const { tree } = remapTree(source(), { workspace: 'new-ws', mintIds: false, origin: 'x' })
    expect(tree.manifest.workspace).toBe('new-ws')
    expect(Object.keys(tree.manifest.entries).sort()).toEqual(['a', 'b', 'c'])
    expect(tree.manifest.references).toEqual({ c: ['a', 'b'] })
  })

  it('mints fresh ids and remaps references, provenance and trash', () => {
    const { tree, idMap } = remapTree(source(), { workspace: 'new-ws', mintIds: true, origin: 'x' })
    const oldIds = ['a', 'b', 'c']
    for (const id of oldIds) {
      expect(idMap.get(id)).toBeDefined()
      expect(idMap.get(id)).not.toBe(id)
      expect(tree.manifest.entries[id]).toBeUndefined()
    }
    const mappedA = idMap.get('a')!
    const mappedB = idMap.get('b')!
    const mappedC = idMap.get('c')!
    expect(tree.manifest.references).toEqual({ [mappedC]: [mappedA, mappedB].sort() })
    expect(tree.manifest.provenance).toEqual([{ entry: mappedA, origin: 'before' }])
    expect(tree.manifest.trash).toEqual([mappedB])
    expect(tree.contents.get(mappedB)?.bytes).toEqual(bytesOf([1, 2, 3]))
  })

  it('merges extraEdges before remapping so both endpoints resolve', () => {
    const tree = treeWith([
      documentEntry('a', 'A', { text: 'kind: part\n' }),
      documentEntry('c', 'C', { text: 'kind: assembly\n' }),
    ], 'ws')
    const { tree: mapped, idMap } = remapTree(tree, {
      workspace: 'ws2',
      mintIds: true,
      origin: 'x',
      extraEdges: { c: ['a'] },
    })
    expect(mapped.manifest.references).toEqual({ [idMap.get('c')!]: [idMap.get('a')!] })
  })
})
