// Unit coverage for the shared reference-sigil strip. Every call site that used
// to spell this inline (hole, postRegister, bodyResolution, faceProfile, sweep,
// bodySnapProjection, Geometry3D/utils, selectionId) now routes through it.

import { describe, it, expect } from 'vitest'
import { stripRefSigil } from '@/utils/refSigil'

describe('stripRefSigil', () => {
  it('drops a single leading sigil', () => {
    expect(stripRefSigil('@builtin_plane_front', '@')).toBe('builtin_plane_front')
    expect(stripRefSigil('$sketch1', '$')).toBe('sketch1')
  })

  it('drops a leading run of mixed sigils', () => {
    expect(stripRefSigil('@$foo', '@$')).toBe('foo')
    expect(stripRefSigil('@@foo', '@')).toBe('foo')
    expect(stripRefSigil('$$foo', '$')).toBe('foo')
  })

  it('leaves the ref untouched when no sigil matches', () => {
    expect(stripRefSigil('$foo', '@')).toBe('$foo')
    expect(stripRefSigil('plain', '@$')).toBe('plain')
    expect(stripRefSigil('', '@$')).toBe('')
  })

  it('keeps a sigil that appears after the leading run', () => {
    expect(stripRefSigil('@feature/entity$name', '@$')).toBe('feature/entity$name')
    expect(stripRefSigil('a@b', '@$')).toBe('a@b')
  })
})
