import { describe, it, expect } from 'vitest'
import { fileKindOf, fileSizeOf, invertReferences, orphanFileIds, referrersOf } from '../filesModel'
import type { EntryMeta } from '@/workspace/types'

function file(id: string, name: string, extra: Partial<EntryMeta> = {}): EntryMeta {
  return { id, path: `files/${name}`, kind: 'file', name, ...extra }
}

describe('fileKindOf', () => {
  it('prefers the app fileKind over the wire mime, then falls back', () => {
    expect(fileKindOf(file('f1', 'a.step', { fileKind: 'step', mime: 'application/step' }))).toBe('step')
    expect(fileKindOf(file('f2', 'b.bin', { mime: 'application/octet-stream' }))).toBe('application/octet-stream')
    expect(fileKindOf(file('f3', 'c.bin'))).toBe('file')
  })
})

describe('fileSizeOf', () => {
  it('reports the derived size, zero when absent', () => {
    expect(fileSizeOf(file('f1', 'a.step', { size: 42 }))).toBe(42)
    expect(fileSizeOf(file('f2', 'b.step'))).toBe(0)
  })
})

describe('orphan detection', () => {
  it('labels only files with no referrer', () => {
    const referenced = file('f1', 'a.step')
    const orphan = file('f2', 'b.step')
    const inverse = invertReferences({ d1: ['f1'] })
    expect(orphanFileIds([referenced, orphan], inverse)).toEqual(['f2'])
    expect(referrersOf(inverse, 'f1')).toEqual(['d1'])
    expect(referrersOf(inverse, 'f2')).toEqual([])
  })
})
