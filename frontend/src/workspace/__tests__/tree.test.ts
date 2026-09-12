import { describe, it, expect } from 'vitest'
import {
  addEntry, assertTree, createTree, entryById, moveEntry, putEntry, removeEntry, renameEntry, restoreEntry,
} from '../tree'
import { emptyManifest } from '../manifest'
import { addReference, referencesOf, resolveReferences } from '../refs'
import { documentEntry, fileEntry, treeWith } from './fixtures'

describe('tree mutation and uuid addressing (I3, A7)', () => {
  it('renameEntry changes name and path and leaves references untouched', () => {
    const tree = treeWith([documentEntry('a', 'A'), documentEntry('b', 'B')])
    addReference(tree, 'b', 'a')
    const before = JSON.stringify(tree.manifest.references)

    renameEntry(tree, 'a', 'Bracket Two')

    expect(tree.manifest.entries.a.name).toBe('Bracket Two')
    expect(tree.manifest.entries.a.path).toBe('documents/Bracket_Two.yaml')
    expect(JSON.stringify(tree.manifest.references)).toBe(before)
    expect(referencesOf(tree, 'b')).toEqual(['a'])
  })

  it('moveEntry changes path and leaves references untouched', () => {
    const tree = treeWith([documentEntry('a', 'A'), documentEntry('b', 'B')])
    addReference(tree, 'b', 'a')
    const before = JSON.stringify(tree.manifest.references)

    moveEntry(tree, 'a', 'documents/nested/A.yaml')

    expect(tree.manifest.entries.a.path).toBe('documents/nested/A.yaml')
    expect(tree.manifest.entries.a.name).toBe('A')
    expect(JSON.stringify(tree.manifest.references)).toBe(before)
  })

  it('every reference still resolves after a rename and a move', () => {
    const tree = treeWith([documentEntry('a', 'A'), documentEntry('b', 'B')])
    addReference(tree, 'b', 'a')

    renameEntry(tree, 'a', 'A Renamed')
    moveEntry(tree, 'a', 'documents/deep/A.yaml')

    expect(referencesOf(tree, 'b')).toEqual(['a'])
    expect(resolveReferences(tree)).toEqual([{ from: 'b', to: 'a', resolved: true }])
    expect(entryById(tree, 'a').name).toBe('A Renamed')
  })

  it('removeEntry hides the entry and keeps it in the trash area', () => {
    const tree = treeWith([documentEntry('a', 'A')])
    removeEntry(tree, 'a')

    expect(tree.manifest.trash).toContain('a')
    expect(tree.manifest.entries.a).toBeDefined()
    expect(tree.contents.get('a')).toBeDefined()
    expect(() => assertTree(tree)).not.toThrow()

    restoreEntry(tree, 'a')
    expect(tree.manifest.trash).not.toContain('a')
  })

  it('putEntry keeps manifest metadata and content in sync', () => {
    const tree = treeWith([])
    putEntry(tree, documentEntry('a', 'A', { text: 'kind: part\n' }))
    expect(tree.manifest.entries.a).toMatchObject({ kind: 'document', name: 'A' })
    expect(tree.contents.get('a')?.text).toBe('kind: part\n')

    putEntry(tree, documentEntry('a', 'A2', { text: 'kind: assembly\n', docKind: 'assembly' }))
    expect(tree.manifest.entries.a.name).toBe('A2')
    expect(tree.manifest.entries.a.docKind).toBe('assembly')
    expect(tree.contents.get('a')?.text).toBe('kind: assembly\n')
    expect(() => assertTree(tree)).not.toThrow()
  })

  it('assertTree rejects a content entry with no manifest row', () => {
    const tree = treeWith([documentEntry('a', 'A')])
    tree.contents.set('ghost', { text: 'kind: part\n' })
    expect(() => assertTree(tree)).toThrow(/no manifest row/)
  })

  it('assertTree rejects content whose type does not match the manifest kind', () => {
    const document = treeWith([documentEntry('a', 'A')])
    document.contents.set('a', { bytes: new Uint8Array([1]) })
    expect(() => assertTree(document)).toThrow(/must carry text/)

    const file = treeWith([fileEntry('b', 'b.step', new Uint8Array([1]))])
    file.contents.set('b', { text: 'kind: part\n' })
    expect(() => assertTree(file)).toThrow(/must carry bytes/)
  })

  it('createTree accepts an empty manifest and refuses a populated one', () => {
    const empty = createTree(emptyManifest('ws-1'))
    expect(empty.contents.size).toBe(0)
    expect(() => assertTree(empty)).not.toThrow()

    const populated = treeWith([documentEntry('a', 'A')]).manifest
    expect(() => createTree(populated)).toThrow(/empty manifest/)
  })

  it('addEntry derives the path and does not reject a reserved-looking name', () => {
    const tree = treeWith([])
    addEntry(tree, documentEntry('a', '.oversolved-index.json'))
    expect(tree.manifest.entries.a.path).toBe('documents/oversolved-index.json.yaml')
    expect(() => assertTree(tree)).not.toThrow()
  })

  it('addEntry rejects a duplicate id', () => {
    const tree = treeWith([documentEntry('a', 'A')])
    expect(() => addEntry(tree, documentEntry('a', 'Other'))).toThrow(/already exists/)
  })
})
