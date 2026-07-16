import { describe, it, expect } from 'vitest'
import { Repository, makeAncestryQuery, constructionUuidToken, AmbiguousQueryError } from './query'

describe('resolver UUID-first tier', () => {
  it('short-circuits on a UUID match even when ancestral tokens do not match', () => {
    const repo = new Repository()
    const face = { type: 'face', body_id: 'body_b', created_by: 'f1' }
    repo.registerAncestor(['@f1', '@body_b'], face, 'gface_x', 'u_X')
    // The ancestral token is deliberately wrong; the UUID still resolves it.
    const q = makeAncestryQuery([constructionUuidToken('u_X'), '@nonexistent'], 'face')
    expect(repo.query(q)).toBe(face)
  })

  it('beats a drifted/absent ancestral match: UUID wins over the ancestral net', () => {
    const repo = new Repository()
    // Two faces share the same ancestral tokens; only the UUID disambiguates them.
    const wanted = { type: 'face', body_id: 'body_b', created_by: 'f1' }
    const other = { type: 'face', body_id: 'body_b', created_by: 'f1' }
    repo.registerAncestor(['@f1', '@body_b'], wanted, 'gface_x', 'u_want')
    repo.registerAncestor(['@f1', '@body_b'], other, 'gface_y', 'u_other')
    // The ancestral subset alone is ambiguous (two hits); the UUID picks the one.
    const q = makeAncestryQuery([constructionUuidToken('u_want'), '@f1', '@body_b'], 'face')
    expect(repo.query(q)).toBe(wanted)
  })

  it('falls through to the ancestral net when the UUID is absent (fallback, not primary)', () => {
    const repo = new Repository()
    const face = { type: 'face', body_id: 'body_b', created_by: 'f1' }
    repo.registerAncestor(['@f1', '@body_b'], face, 'gface_x', 'u_X')
    // The persisted UUID names no live element (the slot changed); the primary
    // tier misses and the ancestral subset must recover it as the fallback.
    const q = makeAncestryQuery([constructionUuidToken('u_missing'), '@f1', '@body_b'], 'face')
    expect(repo.byUuid.has('u_missing')).toBe(false)  // proves the primary tier had nothing to hit
    expect(repo.query(q)).toBe(face)
  })

  it('respects the type restriction on the UUID tier', () => {
    const repo = new Repository()
    const face = { type: 'flatface', body_id: 'body_b', created_by: 'f1' }
    repo.registerAncestor(['@f1'], face, null, 'u_Y')
    // flatface is a subtype of face, so a face restriction still resolves.
    expect(repo.query(makeAncestryQuery([constructionUuidToken('u_Y')], 'face'))).toBe(face)
    // A vertex restriction must not resolve a face by UUID.
    expect(repo.query(makeAncestryQuery([constructionUuidToken('u_Y')], 'vertex'))).toBeNull()
  })

  it('fails loud on a construction-UUID collision (impossible by construction)', () => {
    const repo = new Repository()
    repo.registerAncestor(['@a'], { type: 'face' }, null, 'u_dup')
    repo.registerAncestor(['@b'], { type: 'face' }, null, 'u_dup')
    expect(() => repo.query(makeAncestryQuery([constructionUuidToken('u_dup')], 'face'))).toThrow(
      AmbiguousQueryError,
    )
  })
})
