import { describe, it, expect } from 'vitest'
import { dirtyEntryIds, groupEntries, invertReferences, isOpenEntry, orphanFileIds } from '../workspaceTreeModel'
import type { EntryMeta } from '@/workspace/types'

function meta(id: string, name: string, extra: Partial<EntryMeta> = {}): EntryMeta {
  return { id, path: `documents/${name}.yaml`, kind: 'document', name, ...extra }
}

const part = meta('p1', 'Bracket', { docKind: 'part' })
const assembly = meta('a1', 'Gearbox', { docKind: 'assembly' })
const drawing = meta('d1', 'Layout', { docKind: 'drawing' })
const file = meta('f1', 'shaft.step', { kind: 'file', mime: 'application/step', fileKind: 'step', size: 10 })

describe('groupEntries', () => {
  it('groups documents by docKind and keeps files separate', () => {
    const grouped = groupEntries([part, assembly, file])
    expect(grouped.parts).toEqual([part])
    expect(grouped.assemblies).toEqual([assembly])
    expect(grouped.files).toEqual([file])
    expect(grouped.otherDocs).toEqual([])
  })

  it('lists an unknown docKind in otherDocs rather than dropping it', () => {
    const grouped = groupEntries([drawing])
    expect(grouped.otherDocs).toEqual([drawing])
    expect(grouped.parts).toEqual([])
  })
})

describe('invertReferences', () => {
  it('maps each target to the entries that reference it', () => {
    const inverse = invertReferences({ d1: ['f1'], d2: ['f1', 'f2'] })
    expect(inverse.get('f1')).toEqual(['d1', 'd2'])
    expect(inverse.get('f2')).toEqual(['d2'])
  })
})

describe('orphanFileIds', () => {
  it('returns exactly the files with no incoming edge', () => {
    const inverse = invertReferences({ d1: ['f1'] })
    expect(orphanFileIds([file, meta('f2', 'old.step', { kind: 'file' })], inverse)).toEqual(['f2'])
  })
})

describe('open-entry marking', () => {
  it('marks only the entry whose id matches the open entry', () => {
    expect(isOpenEntry(part, 'p1')).toBe(true)
    expect(isOpenEntry(part, 'a1')).toBe(false)
    expect(isOpenEntry(part, undefined)).toBe(false)
  })
})

describe('dirtyEntryIds', () => {
  it('dots an entry whose working rev differs from its checkpoint rev', () => {
    const working = [meta('p1', 'A', { rev: 3 }), meta('p2', 'B', { rev: 1 }), meta('p3', 'C', { rev: 1 })]
    const saved = new Map([['p1', 2], ['p2', 1]])
    expect([...dirtyEntryIds(working, saved)].sort()).toEqual(['p1', 'p3'])
  })
})
