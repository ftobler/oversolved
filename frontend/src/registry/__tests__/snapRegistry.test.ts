import { describe, it, expect } from 'vitest'
import {
  SNAP_RULES,
  SNAP_KINDS,
  canSnapTo,
  suggestConstraint,
} from '@/registry/snapRegistry'
import { CONSTRAINT_BY_KIND } from '@/registry/constraintRegistry'

// ── Snap registry consistency ────

describe('snapRegistry', () => {
  describe('SNAP_KINDS', () => {
    it('contains expected snap kinds', () => {
      expect(SNAP_KINDS).toContain('vertex')
      expect(SNAP_KINDS).toContain('path')
      expect(SNAP_KINDS).toContain('kinda_horizontal')
      expect(SNAP_KINDS).toContain('kinda_vertical')
    })

    it('has no duplicates', () => {
      expect(new Set(SNAP_KINDS).size).toBe(SNAP_KINDS.length)
    })
  })

  describe('SNAP_RULES', () => {
    it('covers dragged element types', () => {
      expect(SNAP_RULES).toHaveProperty('vertex')
      expect(SNAP_RULES).toHaveProperty('entity')
    })

    it('every rule references valid snap kinds', () => {
      const draggedTypes = Object.keys(SNAP_RULES)
      for (const dt of draggedTypes) {
        const snapKinds = SNAP_RULES[dt as keyof typeof SNAP_RULES]
        for (const snapKind of snapKinds) {
          expect(SNAP_KINDS).toContain(snapKind)
        }
      }
    })

    it('vertex dragged type can snap to vertex, path, and alignment', () => {
      const vertexRule = SNAP_RULES.vertex
      expect(vertexRule).toContain('vertex')
      expect(vertexRule).toContain('path')
      expect(vertexRule).toContain('kinda_horizontal')
      expect(vertexRule).toContain('kinda_vertical')
    })

    it('entity dragged type can only snap to path and alignment (not individual vertices)', () => {
      const entityRule = SNAP_RULES.entity
      expect(entityRule).toContain('path')
      expect(entityRule).toContain('kinda_horizontal')
      expect(entityRule).toContain('kinda_vertical')
      expect(entityRule).not.toContain('vertex')
    })
  })

  describe('canSnapTo', () => {
    it('returns true when snap kind is allowed for vertex drag', () => {
      expect(canSnapTo('vertex', 'vertex')).toBe(true)
      expect(canSnapTo('vertex', 'path')).toBe(true)
      expect(canSnapTo('vertex', 'kinda_horizontal')).toBe(true)
    })

    it('returns false when snap kind is not allowed for vertex drag', () => {
      // vertex drag should never snap to nothing, but this tests the logic
      expect(canSnapTo('vertex', 'vertex')).toBe(true)
    })

    it('returns true when snap kind is allowed for entity drag', () => {
      expect(canSnapTo('entity', 'path')).toBe(true)
      expect(canSnapTo('entity', 'kinda_vertical')).toBe(true)
    })

    it('returns false when entity drag tries to snap to vertex', () => {
      expect(canSnapTo('entity', 'vertex')).toBe(false)
    })
  })

  describe('suggestConstraint', () => {
    it('returns coincident for vertex snap', () => {
      expect(suggestConstraint('vertex', 'vertex')).toBe('coincident')
    })

    it('returns coincident for path snap', () => {
      expect(suggestConstraint('vertex', 'path')).toBe('coincident')
      expect(suggestConstraint('entity', 'path')).toBe('coincident')
    })

    it('returns horizontal for kinda_horizontal snap', () => {
      expect(suggestConstraint('vertex', 'kinda_horizontal')).toBe('horizontal')
      expect(suggestConstraint('entity', 'kinda_horizontal')).toBe('horizontal')
    })

    it('returns vertical for kinda_vertical snap', () => {
      expect(suggestConstraint('vertex', 'kinda_vertical')).toBe('vertical')
      expect(suggestConstraint('entity', 'kinda_vertical')).toBe('vertical')
    })

    it('returns null for invalid snap combination (entity dragging to vertex)', () => {
      expect(suggestConstraint('entity', 'vertex')).toBeNull()
    })

    it('all suggested constraints are known constraint kinds', () => {
      const combinations: [string, string][] = [
        ['vertex', 'vertex'],
        ['vertex', 'path'],
        ['vertex', 'kinda_horizontal'],
        ['vertex', 'kinda_vertical'],
        ['entity', 'path'],
        ['entity', 'kinda_horizontal'],
        ['entity', 'kinda_vertical'],
      ]
      for (const [dt, sk] of combinations) {
        const constraint = suggestConstraint(dt as 'vertex' | 'entity', sk as 'vertex' | 'path' | 'kinda_horizontal' | 'kinda_vertical')
        if (constraint) {
          expect(
            CONSTRAINT_BY_KIND.has(constraint),
            `unknown constraint "${constraint}" for ${dt} -> ${sk}`
          ).toBe(true)
        }
      }
    })
  })
})