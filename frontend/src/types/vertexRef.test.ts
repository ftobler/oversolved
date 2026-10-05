import { describe, it, expect } from 'vitest'
import { resolveVertexRef } from '@/types/vertexRef'

// The shared reader is the single source the four knownIds wrappers delegate to
// (geometryMapping.resolveQueryRef, offsetProfile.parseVertexRef,
// dockHosts.refEntityId, partDocToSketches.resolveLocal). These pin its two
// accepted forms and the full-id-first rule; the tie-break under adversarial
// suffix sets lives in vertexRef.tieBreak.test.ts.

const KNOWN = new Set(['e3', 'arc1'])

describe('resolveVertexRef string form', () => {
  it('resolves a bare entity ref to a point-less {entity}', () => {
    expect(resolveVertexRef(KNOWN, '$e3')).toEqual({ entity: 'e3' })
  })

  it('splits a known suffix into {entity, point}', () => {
    expect(resolveVertexRef(KNOWN, '$e3start')).toEqual({ entity: 'e3', point: 'start' })
    expect(resolveVertexRef(KNOWN, '$arc1center')).toEqual({ entity: 'arc1', point: 'center' })
  })

  it('lets a full entity id win over a suffix split (full-id-first)', () => {
    // '$abcenter' names the entity abcenter, not ab + 'center', even though ab is
    // also known. Same rule partDocToSketches already pinned.
    const known = new Set(['ab', 'abcenter'])
    expect(resolveVertexRef(known, '$abcenter')).toEqual({ entity: 'abcenter' })
  })

  it('splits when the full string is not an entity, even if the residual id ends in a key word', () => {
    const known = new Set(['abcenter'])
    expect(resolveVertexRef(known, '$abcenterend')).toEqual({ entity: 'abcenter', point: 'end' })
  })

  it('rejects a ref without the $ prefix or with an unknown id', () => {
    expect(resolveVertexRef(KNOWN, 'e3')).toBeNull()
    expect(resolveVertexRef(KNOWN, '$nope')).toBeNull()
    expect(resolveVertexRef(KNOWN, '$')).toBeNull()
    expect(resolveVertexRef(KNOWN, '$nopestart')).toBeNull()
  })
})

describe('resolveVertexRef dict form', () => {
  it('accepts a known entity with a valid vertex key', () => {
    expect(resolveVertexRef(KNOWN, { entity: 'e3', point: 'end' })).toEqual({ entity: 'e3', point: 'end' })
  })

  it('accepts a known entity with no point (bare whole-curve ref)', () => {
    expect(resolveVertexRef(KNOWN, { entity: 'e3' })).toEqual({ entity: 'e3' })
  })

  it('rejects a point name outside VERTEX_POINT_KEYS', () => {
    // An unvalidated selector would lower to an absent one in the solver,
    // silently weakening an endpoint constraint.
    expect(resolveVertexRef(KNOWN, { entity: 'e3', point: 'bogus' })).toBeNull()
    expect(resolveVertexRef(KNOWN, { entity: 'e3', point: 42 })).toBeNull()
  })

  it('rejects an unknown or non-string entity', () => {
    expect(resolveVertexRef(KNOWN, { entity: 'nope', point: 'end' })).toBeNull()
    expect(resolveVertexRef(KNOWN, { entity: 42, point: 'end' })).toBeNull()
  })
})

describe('resolveVertexRef rejects non-refs', () => {
  it('returns null for null, undefined, numbers and booleans', () => {
    expect(resolveVertexRef(KNOWN, null)).toBeNull()
    expect(resolveVertexRef(KNOWN, undefined)).toBeNull()
    expect(resolveVertexRef(KNOWN, 7)).toBeNull()
    expect(resolveVertexRef(KNOWN, true)).toBeNull()
  })
})
