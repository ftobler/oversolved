import { describe, it, expect } from 'vitest'
import {
  SNAP_RULES,
  SNAP_KINDS,
  getSnapRule,
  canSnapTo,
  suggestConstraint,
} from '../snapRegistry'
import { CONSTRAINT_BY_KIND } from '../constraintRegistry'

// ── Snap registry consistency ────

describe('snapRegistry', () => {
  describe('SNAP_KINDS', () => {
    it('contains expected snap kinds', () => {
      expect(SNAP_KINDS).toContain('vertex')
      expect(SNAP_KINDS).toContain('midpoint')
      expect(SNAP_KINDS).toContain('center')
      expect(SNAP_KINDS).toContain('path')
      expect(SNAP_KINDS).toContain('grid')
    })

    it('has no duplicates', () => {
      expect(new Set(SNAP_KINDS).size).toBe(SNAP_KINDS.length)
    })
  })

  describe('SNAP_RULES', () => {
    it('covers known entity kinds', () => {
      expect(SNAP_RULES).toHaveProperty('line')
      expect(SNAP_RULES).toHaveProperty('circle')
      expect(SNAP_RULES).toHaveProperty('arc')
      expect(SNAP_RULES).toHaveProperty('point')
    })

    it('every rule references valid snap kinds', () => {
      const entityKinds = Object.keys(SNAP_RULES)
      for (const ek of entityKinds) {
        const vertices = SNAP_RULES[ek as keyof typeof SNAP_RULES]
        const vertexKeys = Object.keys(vertices)
        for (const vk of vertexKeys) {
          const rule = vertices[vk as keyof typeof vertices]
          for (const snapKind of rule.snapKinds) {
            expect(SNAP_KINDS).toContain(snapKind)
          }
        }
      }
    })

    it('every suggested constraint is a known constraint kind', () => {
      const entityKinds = Object.keys(SNAP_RULES)
      for (const ek of entityKinds) {
        const vertices = SNAP_RULES[ek as keyof typeof SNAP_RULES]
        const vertexKeys = Object.keys(vertices)
        for (const vk of vertexKeys) {
          const rule = vertices[vk as keyof typeof vertices]
          expect(
            CONSTRAINT_BY_KIND.has(rule.suggest),
            `unknown constraint "${rule.suggest}" for ${ek}.${vk}`
          ).toBe(true)
        }
      }
    })

    it('line vertices have both start and end rules', () => {
      expect(SNAP_RULES.line).toHaveProperty('start')
      expect(SNAP_RULES.line).toHaveProperty('end')
    })

    it('circle has center rule', () => {
      expect(SNAP_RULES.circle).toHaveProperty('center')
    })

    it('arc has start, end, and center rules', () => {
      expect(SNAP_RULES.arc).toHaveProperty('start')
      expect(SNAP_RULES.arc).toHaveProperty('end')
      expect(SNAP_RULES.arc).toHaveProperty('center')
    })

    it('point has xy rule', () => {
      expect(SNAP_RULES.point).toHaveProperty('xy')
    })
  })

  describe('getSnapRule', () => {
    it('returns rule for known entity+vertex combination', () => {
      const rule = getSnapRule('line', 'start')
      expect(rule).toBeDefined()
      expect(rule!.snapKinds).toBeDefined()
    })

    it('returns undefined for unknown entity kind', () => {
      expect(getSnapRule('unknown', 'start')).toBeUndefined()
    })

    it('returns undefined for unknown vertex key', () => {
      expect(getSnapRule('line', 'unknown')).toBeUndefined()
    })
  })

  describe('canSnapTo', () => {
    it('returns true when snap kind is in rule', () => {
      const rule = getSnapRule('line', 'start')
      expect(canSnapTo(rule!, 'vertex')).toBe(true)
    })

    it('returns false when snap kind is not in rule', () => {
      const rule = getSnapRule('circle', 'center')
      expect(canSnapTo(rule!, 'midpoint')).toBe(false)
    })
  })

  describe('suggestConstraint', () => {
    it('returns constraint for valid snap combination', () => {
      const constraint = suggestConstraint('line', 'start', 'vertex')
      expect(constraint).toBe('coincident')
    })

    it('returns constraint for invalid snap combination when it makes sense', () => {
      const constraint = suggestConstraint('circle', 'center', 'vertex')
      expect(constraint).toBe('concentric')
    })

    it('returns null for unknown entity kind', () => {
      expect(suggestConstraint('unknown', 'start', 'vertex')).toBeNull()
    })

    it('returns null for unknown vertex key', () => {
      expect(suggestConstraint('line', 'unknown', 'vertex')).toBeNull()
    })

    it('line vertex suggests coincident for vertex snap', () => {
      expect(suggestConstraint('line', 'start', 'vertex')).toBe('coincident')
      expect(suggestConstraint('line', 'end', 'vertex')).toBe('coincident')
    })

    it('line vertex suggests coincident for midpoint snap', () => {
      expect(suggestConstraint('line', 'start', 'midpoint')).toBe('coincident')
      expect(suggestConstraint('line', 'end', 'midpoint')).toBe('coincident')
    })

    it('line vertex suggests coincident for center snap (circle/arc centers)', () => {
      expect(suggestConstraint('line', 'start', 'center')).toBe('coincident')
      expect(suggestConstraint('line', 'end', 'center')).toBe('coincident')
    })

    it('line vertex suggests coincident for path snap (edge snapping)', () => {
      expect(suggestConstraint('line', 'start', 'path')).toBe('coincident')
      expect(suggestConstraint('line', 'end', 'path')).toBe('coincident')
    })

    it('arc endpoints suggest coincident for path snap', () => {
      expect(suggestConstraint('arc', 'start', 'path')).toBe('coincident')
      expect(suggestConstraint('arc', 'end', 'path')).toBe('coincident')
    })

    it('circle center does not suggest path snap', () => {
      expect(suggestConstraint('circle', 'center', 'path')).toBeNull()
    })

    it('point suggests coincident for path snap', () => {
      expect(suggestConstraint('point', 'xy', 'path')).toBe('coincident')
    })

    it('circle center suggests concentric for center snap', () => {
      expect(suggestConstraint('circle', 'center', 'center')).toBe('concentric')
    })

    it('arc endpoints suggest coincident for vertex snap', () => {
      expect(suggestConstraint('arc', 'start', 'vertex')).toBe('coincident')
      expect(suggestConstraint('arc', 'end', 'vertex')).toBe('coincident')
    })

    it('arc center suggests concentric for center snap', () => {
      expect(suggestConstraint('arc', 'center', 'center')).toBe('concentric')
    })

    it('point suggests coincident for vertex snap', () => {
      expect(suggestConstraint('point', 'xy', 'vertex')).toBe('coincident')
    })
  })
})
