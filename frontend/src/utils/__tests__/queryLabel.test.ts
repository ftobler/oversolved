import { describe, it, expect } from 'vitest'
import { queryLabel } from '@/utils/queryLabel'
import type { PartFeature } from '@/types/cad'

const features: PartFeature[] = [
  { id: 'extrude1', kind: 'extrude', label: 'My Extrude' },
  { id: 'sk1', kind: 'sketch', label: 'Sketch 1' },
  { id: 'fillet2', kind: 'fillet', label: 'Fillet 2' },
  { id: 'sketch3', kind: 'sketch' },
]

describe('queryLabel', () => {
  describe('builtin planes', () => {
    it('returns Front for @builtin_plane_front', () => {
      expect(queryLabel('@builtin_plane_front', features)).toBe('Front')
    })

    it('returns Top for @builtin_plane_top', () => {
      expect(queryLabel('@builtin_plane_top', features)).toBe('Top')
    })

    it('returns Right for @builtin_plane_right', () => {
      expect(queryLabel('@builtin_plane_right', features)).toBe('Right')
    })
  })

  describe('ancestry queries', () => {
    it('returns Face of <feature label> for ancestry face query', () => {
      // @extrude1face0 = 14 chars → hex "e"
      const q = '?e,e;@extrude1face0@extrude1face1:flatface'
      expect(queryLabel(q, features)).toBe('Face of My Extrude')
    })

    it('returns Edge of <feature label> for ancestry edge query', () => {
      // @fillet2edge0 = 13 chars → hex "d"
      const q = '?d,d;@fillet2edge0@fillet2edge1:straightedge'
      expect(queryLabel(q, features)).toBe('Edge of Fillet 2')
    })

    it('returns Vertex of <feature label> for ancestry vertex query', () => {
      // @sk1vertex0 = 11 chars → hex "b"
      const q = '?b;@sk1vertex0:vertex'
      expect(queryLabel(q, features)).toBe('Vertex of Sketch 1')
    })

    it('uses feature ID when feature has no label', () => {
      // @sketch3face0 = 13 chars → hex "d"
      const q = '?d;@sketch3face0:flatface'
      expect(queryLabel(q, features)).toBe('Face of sketch3')
    })

    it('returns raw query when feature ID cannot be extracted', () => {
      const q = '?2;?!:flatface'
      expect(queryLabel(q, features)).toBe(q)
    })
  })

  describe('absolute queries', () => {
    it('returns feature label for feature reference', () => {
      expect(queryLabel('@extrude1', features)).toBe('My Extrude')
    })

    it('returns feature ID when feature has no label', () => {
      expect(queryLabel('@sketch3', features)).toBe('sketch3')
    })

    it('returns feature ID for unknown feature', () => {
      expect(queryLabel('@nonexistent', features)).toBe('nonexistent')
    })
  })

  describe('body references via partLabels', () => {
    it('returns part label from partLabels map keyed by bare body ID', () => {
      const partLabels = { body_ex1: 'Part 3' }
      expect(queryLabel('@body_ex1', features, partLabels)).toBe('Part 3')
    })
  })

  describe('local queries', () => {
    it('returns entity ID for local query', () => {
      expect(queryLabel('$line1', features)).toBe('line1')
    })

    it('returns entity ID with sub-element', () => {
      expect(queryLabel('$line1start', features)).toBe('line1')
    })
  })

  describe('edge cases', () => {
    it('returns None for empty string', () => {
      expect(queryLabel('', features)).toBe('None')
    })

    it('returns None for "None" string', () => {
      expect(queryLabel('None', features)).toBe('None')
    })

    it('returns raw query for unrecognized query format', () => {
      expect(queryLabel('!invalid', features)).toBe('!invalid')
    })

    it('returns raw query for plain text', () => {
      expect(queryLabel('just some text', features)).toBe('just some text')
    })
  })
})
