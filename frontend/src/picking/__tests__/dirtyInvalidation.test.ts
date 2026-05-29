import { describe, it, expect } from 'vitest'
import { sceneSliceChanged } from '@/picking/dirtyInvalidation'
import type { ScenePartEditorSlice } from '@/picking/dirtyInvalidation'
import type { BodyResult, Sketch } from '@/types/cad'

function makeSlice(overrides: Partial<ScenePartEditorSlice> = {}): ScenePartEditorSlice {
  return {
    bodies: {},
    pickBodies: {},
    visibleBodies: new Set<string>(),
    visibleFeatures: new Set<string>(),
    rollbackPosition: null,
    otherSketches: {},
    ...overrides,
  }
}

function makeBody(id: string): BodyResult {
  return { id, created_by: 'f1', modified_by: [] }
}

describe('sceneSliceChanged', () => {
  it('returns false when all fields are identical', () => {
    const slice = makeSlice()
    expect(sceneSliceChanged(slice, slice)).toBe(false)
  })

  describe('each tracked field triggers true when it flips', () => {
    it('bodies', () => {
      const prev = makeSlice({ bodies: { a: makeBody('a') } })
      const next = makeSlice({ bodies: { b: makeBody('b') } })
      expect(sceneSliceChanged(prev, next)).toBe(true)
    })

    it('pickBodies', () => {
      const prev = makeSlice({ pickBodies: { a: makeBody('a') } })
      const next = makeSlice({ pickBodies: { b: makeBody('b') } })
      expect(sceneSliceChanged(prev, next)).toBe(true)
    })

    it('visibleBodies', () => {
      const prev = makeSlice({ visibleBodies: new Set(['a']) })
      const next = makeSlice({ visibleBodies: new Set(['b']) })
      expect(sceneSliceChanged(prev, next)).toBe(true)
    })

    it('visibleFeatures', () => {
      const prev = makeSlice({ visibleFeatures: new Set(['a']) })
      const next = makeSlice({ visibleFeatures: new Set(['b']) })
      expect(sceneSliceChanged(prev, next)).toBe(true)
    })

    it('rollbackPosition (null to number)', () => {
      const prev = makeSlice({ rollbackPosition: null })
      const next = makeSlice({ rollbackPosition: 5 })
      expect(sceneSliceChanged(prev, next)).toBe(true)
    })

    it('otherSketches', () => {
      const prev = makeSlice({ otherSketches: {} })
      const next = makeSlice({ otherSketches: { a: {} as Sketch } })
      expect(sceneSliceChanged(prev, next)).toBe(true)
    })
  })

  describe('untracked fields do NOT trigger sceneSliceChanged', () => {
    it('equal slices return false', () => {
      const slice = makeSlice()
      expect(sceneSliceChanged(slice, slice)).toBe(false)
    })
  })
})
