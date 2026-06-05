import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  PORTED_FEATURE_KINDS,
  isDocFullyPorted,
  unportedKinds,
  getSolver,
  createFeatureSolver,
} from './solverRegistry'
import type { FeatureResult } from './builder'
import type { OccModule } from './occ/occTypes'
import { DisposeScope } from './occ/disposeScope'
import { HandleTable } from './occ/handleTable'
import { Repository } from './query'

// ── Ported-kind set completeness ─────────────────────────────────────────

describe('PORTED_FEATURE_KINDS', () => {
  it('contains all 14 leaf feature kinds (13 brep + sketch)', () => {
    const expected = [
      'sketch',
      'extrude', 'revolve', 'sweep',
      'fillet', 'chamfer',
      'boolean', 'hole',
      'array', 'circular_array',
      'transform', 'mirror',
      'delete_body', 'import_step',
    ]
    expect(PORTED_FEATURE_KINDS.size).toBe(expected.length)
    for (const kind of expected) {
      expect(PORTED_FEATURE_KINDS.has(kind), `missing kind: ${kind}`).toBe(true)
    }
  })

  it('is frozen against mutation', () => {
    expect(Object.isFrozen(PORTED_FEATURE_KINDS)).toBe(true)
  })
})

// ── isDocFullyPorted ─────────────────────────────────────────────────────

describe('isDocFullyPorted', () => {
  it('returns true for empty feature list', () => {
    expect(isDocFullyPorted([])).toBe(true)
  })

  it('returns true when all kinds are ported', () => {
    const features = [
      { id: 'ex1', kind: 'extrude' },
      { id: 'bo1', kind: 'boolean' },
      { id: 'ar1', kind: 'array' },
    ]
    expect(isDocFullyPorted(features)).toBe(true)
  })

  it('returns false when any kind is plane', () => {
    const features = [
      { id: 'pl1', kind: 'plane' },
      { id: 'ex1', kind: 'extrude' },
    ]
    expect(isDocFullyPorted(features)).toBe(false)
  })

  it('returns false when any kind is outside the ported set', () => {
    const features = [
      { id: 'pl1', kind: 'plane' },
      { id: 'ex1', kind: 'extrude' },
    ]
    expect(isDocFullyPorted(features)).toBe(false)
  })

  it('returns false for an unknown kind', () => {
    const features = [
      { id: 'x1', kind: 'future_feature' },
    ]
    expect(isDocFullyPorted(features)).toBe(false)
  })

  it('ignores features without a kind (legacy)', () => {
    const features = [
      { id: 'x1' },
      { id: 'ex1', kind: 'extrude' },
    ]
    expect(isDocFullyPorted(features)).toBe(true)
  })

  it('returns false for single unported kind in a mixed doc', () => {
    const allPorted = [
      'sketch',
      'extrude', 'revolve', 'sweep', 'fillet', 'chamfer',
      'boolean', 'hole', 'array', 'circular_array',
      'transform', 'mirror', 'delete_body', 'import_step',
    ]
    const withPlane = [
      ...allPorted.map((k, i) => ({ id: `f${i}`, kind: k })),
      { id: 'pl1', kind: 'plane' },
    ]
    expect(isDocFullyPorted(withPlane)).toBe(false)
  })
})

// ── unportedKinds ────────────────────────────────────────────────────────

describe('unportedKinds', () => {
  it('returns empty set when all kinds are ported', () => {
    const features = [
      { id: 'ex1', kind: 'extrude' },
      { id: 'fi1', kind: 'fillet' },
    ]
    expect(unportedKinds(features).size).toBe(0)
  })

  it('returns the set of unported kinds', () => {
    const features = [
      { id: 'pl1', kind: 'plane' },
      { id: 'ex1', kind: 'extrude' },
    ]
    const missing = unportedKinds(features)
    expect(missing.has('plane')).toBe(true)
    expect(missing.has('extrude')).toBe(false)
  })

  it('deduplicates repeated unported kinds', () => {
    const features = [
      { id: 'pl1', kind: 'plane' },
      { id: 'pl2', kind: 'plane' },
    ]
    expect(unportedKinds(features).size).toBe(1)
  })

  it('returns empty for empty feature list', () => {
    expect(unportedKinds([]).size).toBe(0)
  })
})

// ── getSolver ────────────────────────────────────────────────────────────

describe('getSolver', () => {
  it('returns a function for every ported kind', () => {
    for (const kind of PORTED_FEATURE_KINDS) {
      expect(typeof getSolver(kind), `missing solver for: ${kind}`).toBe('function')
    }
  })

  it('returns null for unknown kinds', () => {
    expect(getSolver('plane')).toBeNull()
    expect(getSolver('origin')).toBeNull()
    expect(getSolver('nonexistent')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(getSolver('')).toBeNull()
  })
})

// ── createFeatureSolver adapter ──────────────────────────────────────────

describe('createFeatureSolver', () => {
  const fakeOc = {} as OccModule
  let scope: DisposeScope
  let table: HandleTable

  beforeEach(() => {
    scope = new DisposeScope()
    table = new HandleTable({ finalizerGuard: false })
  })

  afterEach(() => {
    scope.dispose()
  })

  it('returns a function', () => {
    const solver = createFeatureSolver(fakeOc, scope, table)
    expect(typeof solver).toBe('function')
  })

  it('returns exception for missing kind field', () => {
    const solver = createFeatureSolver(fakeOc, scope, table)
    const result = solver({ id: 'x1' }, new Repository(), {}, {}) as FeatureResult
    expect(result.status).toBe('exception')
    expect(result.exception).toBe('feature missing kind')
  })

  it('returns exception for unported kind', () => {
    const solver = createFeatureSolver(fakeOc, scope, table)
    const result = solver(
      { id: 'pl1', kind: 'plane' },
      new Repository(),
      {},
      {},
    ) as FeatureResult
    expect(result.status).toBe('exception')
    expect(String(result.exception)).toContain('unported feature kind')
  })

  it('throws for missing profile (surfaces through to builder catch)', () => {
    const solver = createFeatureSolver(fakeOc, scope, table)
    const repo = new Repository()
    const featuresById: Record<string, Record<string, unknown>> = {
      'ex1': { id: 'ex1', kind: 'extrude' },
    }
    // The underlying solver throws when it cannot resolve the profile.
    // builder.ts wraps every solve in try/catch so this becomes a clean
    // exception result.  Here we verify the error surfaces correctly.
    expect(() => {
      solver(
        { id: 'ex1', kind: 'extrude', extrude: { sketch: '?sk1' } },
        repo,
        {},
        featuresById,
      )
    }).toThrow()
  })
})
