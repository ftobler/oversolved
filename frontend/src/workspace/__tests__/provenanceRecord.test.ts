import { describe, it, expect } from 'vitest'
import { emptyManifest, parseManifest, serializeManifest } from '../manifest'
import { remapTree } from '../import'
import type { ProvenanceRecord, WorkspaceManifest } from '../types'
import { documentEntry, treeWith } from './fixtures'

// The provenance record's new fields are C6's: the source entry id is the one
// the update path correlates on, so it must round-trip byte-stably (I4) and
// survive the id re-mint that a copy runs.

function manifestWith(records: ProvenanceRecord[]): WorkspaceManifest {
  return { ...emptyManifest('ws-1'), provenance: records }
}

describe('provenance record', () => {
  it('round-trips every field through the canonical manifest (I4)', () => {
    const records: ProvenanceRecord[] = [{
      entry: 'e1',
      origin: 'folder:cad',
      originEntry: 'src-1',
      originGroup: 'group-1',
      originName: 'cad',
      originWorkspace: 'src-ws',
      rev: 3,
      hash: 'abc',
      copiedAt: 1700000000000,
    }]
    const text = serializeManifest(manifestWith(records))
    const parsed = parseManifest(text)
    expect(parsed.provenance).toEqual(records)
    expect(serializeManifest(parsed)).toBe(text)
  })

  it('accepts a pre-C6 record without the new fields and re-emits it byte-stably', () => {
    const text = serializeManifest(manifestWith([{ entry: 'e1', origin: 'folder:cad' }]))
    const parsed = parseManifest(text)
    expect(parsed.provenance[0].originEntry).toBeUndefined()
    expect(parsed.provenance[0].originGroup).toBeUndefined()
    expect(parsed.provenance[0].originName).toBeUndefined()
    expect(parsed.provenance[0].copiedAt).toBeUndefined()
    expect(serializeManifest(parsed)).toBe(text)
  })

  it('rejects malformed new fields', () => {
    expect(() => serializeManifest(manifestWith([{ entry: 'e1', origin: 'o', originEntry: '' }])))
      .toThrow(/originEntry/)
    expect(() => serializeManifest(manifestWith([{ entry: 'e1', origin: 'o', originGroup: '' }])))
      .toThrow(/originGroup/)
    expect(() => serializeManifest(manifestWith([{ entry: 'e1', origin: 'o', originName: 1 as unknown as string }])))
      .toThrow(/originName/)
    expect(() => serializeManifest(manifestWith([{ entry: 'e1', origin: 'o', originWorkspace: 1 as unknown as string }])))
      .toThrow(/originWorkspace/)
    expect(() => serializeManifest(manifestWith([{ entry: 'e1', origin: 'o', copiedAt: 1.5 }])))
      .toThrow(/copiedAt/)
  })

  it('preserves originEntry, originGroup and originWorkspace through an id mint', () => {
    const tree = treeWith([documentEntry('a', 'A')])
    tree.manifest.provenance = [{
      entry: 'a',
      origin: 'folder:cad',
      originEntry: 'src-a',
      originGroup: 'group-a',
      originWorkspace: 'src-ws',
    }]
    const { tree: remapped, idMap } = remapTree(tree, { workspace: 'ws2', mintIds: true, origin: 'x' })
    const mapped = idMap.get('a')!
    expect(mapped).not.toBe('a')
    expect(remapped.manifest.provenance).toEqual([{
      entry: mapped,
      origin: 'folder:cad',
      originEntry: 'src-a',
      originGroup: 'group-a',
      originWorkspace: 'src-ws',
    }])
  })
})
