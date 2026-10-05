import { describe, it, expect } from 'vitest'
import { isSnapshotObject, mergeSnapshot, pickOwnedFields } from '@/stores/storeSnapshot'

interface Mirror {
  features: string[]
  doc: string | null
  hover: string | null
  editing: string | null
}

const OWNED = ['editing'] as const

describe('isSnapshotObject', () => {
  it('accepts plain and frozen objects', () => {
    expect(isSnapshotObject({})).toBe(true)
    expect(isSnapshotObject(Object.freeze({ a: 1 }))).toBe(true)
  })

  it('rejects null, arrays and primitives', () => {
    expect(isSnapshotObject(null)).toBe(false)
    expect(isSnapshotObject(undefined)).toBe(false)
    expect(isSnapshotObject([])).toBe(false)
    expect(isSnapshotObject('snapshot')).toBe(false)
    expect(isSnapshotObject(7)).toBe(false)
  })
})

describe('mergeSnapshot', () => {
  const prev: Mirror = { features: ['old'], doc: 'oldDoc', hover: 'oldHover', editing: 'liveEdit' }
  const data: Mirror = { features: ['new'], doc: 'newDoc', hover: 'newHover', editing: 'snapshotEdit' }

  it('takes mirrored fields from data and owned fields from prev', () => {
    expect(mergeSnapshot(data, prev, OWNED)).toEqual({
      features: ['new'],
      doc: 'newDoc',
      hover: 'newHover',
      editing: 'liveEdit',
    })
  })

  it('returns a fresh top-level object and mutates neither input', () => {
    const merged = mergeSnapshot(data, prev, OWNED)
    expect(merged).not.toBe(data)
    expect(data.editing).toBe('snapshotEdit')
    expect(prev.features).toEqual(['old'])
    // Shallow copy, same as the spread it replaces: nested values are shared.
    expect(merged.features).toBe(data.features)
    merged.doc = 'rewritten'
    expect(data.doc).toBe('newDoc')
  })

  it('restores owned fields that data omitted', () => {
    const partial = { features: ['new'] } as unknown as Mirror
    expect(mergeSnapshot(partial, prev, OWNED).editing).toBe('liveEdit')
  })

  it('rejects a non-object snapshot instead of spreading it into nothing', () => {
    const bad = null as unknown as Mirror
    expect(() => mergeSnapshot(bad, prev, OWNED)).toThrow(TypeError)
  })

  it('rejects an owned field the live state does not carry', () => {
    const thin = { features: [], doc: null, hover: null } as unknown as Mirror
    expect(() => mergeSnapshot(data, thin, OWNED)).toThrow(/editing/)
  })
})

describe('pickOwnedFields', () => {
  const source: Mirror = { features: ['a'], doc: 'd', hover: 'h', editing: 'e' }

  it('copies the listed fields and omits the excluded ones', () => {
    expect(pickOwnedFields(source, ['editing', 'hover'] as const, ['hover'] as const)).toEqual({
      editing: 'e',
    })
  })

  it('returns a fresh object carrying only the picked keys', () => {
    const picked = pickOwnedFields(source, ['doc'] as const)
    expect(picked).toEqual({ doc: 'd' })
    expect('features' in picked).toBe(false)
  })
})
