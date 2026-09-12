import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  PORTED_FEATURE_KINDS,
  isDocFullyPorted,
  unportedKinds,
  getSolver,
  createFeatureSolver,
  resolveFeatureExpressions,
} from './solverRegistry'
import type { FeatureResult } from './builder'
import type { OccModule } from './occ/occTypes'
import { DisposeScope } from './occ/disposeScope'
import { HandleTable } from './occ/handleTable'
import { Repository } from './query'

// ─── Ported-kind set completeness ───

describe('PORTED_FEATURE_KINDS', () => {
  it('contains all 16 leaf feature kinds (13 brep + sketch + plane + variable)', () => {
    const expected = [
      'sketch',
      'plane',
      'extrude', 'revolve', 'sweep',
      'fillet', 'chamfer',
      'boolean', 'hole',
      'array', 'circular_array',
      'transform', 'mirror',
      'delete_body', 'import_step',
      'variable',
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

// ─── isDocFullyPorted ───

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

  it('returns true when a plane feature is present (now ported)', () => {
    const features = [
      { id: 'pl1', kind: 'plane' },
      { id: 'ex1', kind: 'extrude' },
    ]
    expect(isDocFullyPorted(features)).toBe(true)
  })

  it('returns false when any kind is outside the ported set', () => {
    const features = [
      { id: 'or1', kind: 'origin' },
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
      'sketch', 'plane',
      'extrude', 'revolve', 'sweep', 'fillet', 'chamfer',
      'boolean', 'hole', 'array', 'circular_array',
      'transform', 'mirror', 'delete_body', 'import_step',
    ]
    const withOrigin = [
      ...allPorted.map((k, i) => ({ id: `f${i}`, kind: k })),
      { id: 'or1', kind: 'origin' },
    ]
    expect(isDocFullyPorted(withOrigin)).toBe(false)
  })
})

// ─── unportedKinds ───

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
      { id: 'or1', kind: 'origin' },
      { id: 'ex1', kind: 'extrude' },
    ]
    const missing = unportedKinds(features)
    expect(missing.has('origin')).toBe(true)
    expect(missing.has('extrude')).toBe(false)
  })

  it('deduplicates repeated unported kinds', () => {
    const features = [
      { id: 'or1', kind: 'origin' },
      { id: 'or2', kind: 'origin' },
    ]
    expect(unportedKinds(features).size).toBe(1)
  })

  it('returns empty for empty feature list', () => {
    expect(unportedKinds([]).size).toBe(0)
  })
})

// ─── getSolver ───

describe('getSolver', () => {
  it('returns a function for every ported kind except import_step', () => {
    for (const kind of PORTED_FEATURE_KINDS) {
      // import_step is dispatched directly by createFeatureSolver so it can
      // receive the solve file map; it has no KIND_SOLVER entry.
      if (kind === 'import_step') continue
      expect(typeof getSolver(kind), `missing solver for: ${kind}`).toBe('function')
    }
  })

  it('has no KIND_SOLVER entry for import_step', () => {
    expect(getSolver('import_step')).toBeNull()
  })

  it('returns a function for the plane kind (now ported)', () => {
    expect(typeof getSolver('plane')).toBe('function')
  })

  it('returns null for unknown kinds', () => {
    expect(getSolver('origin')).toBeNull()
    expect(getSolver('nonexistent')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(getSolver('')).toBeNull()
  })
})

// ─── createFeatureSolver adapter ───

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
      { id: 'or1', kind: 'origin' },
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

// ─── Expression resolution ───

describe('resolveFeatureExpressions', () => {
  it('evaluates a sub-dict expression string to a number', () => {
    const r = resolveFeatureExpressions({ id: 'e1', kind: 'extrude', extrude: { distance: '100/4' } })
    expect('feature' in r).toBe(true)
    if ('feature' in r) {
      expect((r.feature.extrude as Record<string, unknown>).distance).toBe(25)
    }
  })

  it('passes plain numbers through unchanged', () => {
    const r = resolveFeatureExpressions({ id: 'e1', kind: 'extrude', extrude: { distance: 50 } })
    expect('feature' in r).toBe(true)
    if ('feature' in r) {
      expect((r.feature.extrude as Record<string, unknown>).distance).toBe(50)
    }
  })

  it('does not mutate the original feature (keeps the raw expression)', () => {
    const original = { id: 'e1', kind: 'extrude', extrude: { distance: '2+2' } }
    resolveFeatureExpressions(original)
    expect(original.extrude.distance).toBe('2+2')
  })

  it('returns an exception for an invalid expression', () => {
    const r = resolveFeatureExpressions({ id: 'e1', kind: 'extrude', extrude: { distance: '2+/' } })
    expect('exception' in r).toBe(true)
    if ('exception' in r) expect(r.exception).toContain('2+/')
  })

  it('resolves a flat feature-level expression (not under the sub-key)', () => {
    // Some specs carry params flat on the feature; leaf solvers overlay these
    // over the sub-dict, so they must be evaluated too.
    const r = resolveFeatureExpressions({ id: 'e1', kind: 'extrude', distance: '50+25' })
    expect('feature' in r).toBe(true)
    if ('feature' in r) expect(r.feature.distance).toBe(75)
  })

  it('resolves feature-level scale for import_step', () => {
    const r = resolveFeatureExpressions({ id: 's1', kind: 'import_step', scale: '2*3' })
    expect('feature' in r).toBe(true)
    if ('feature' in r) expect(r.feature.scale).toBe(6)
  })

  it('resolves plane definition fields', () => {
    const r = resolveFeatureExpressions({ id: 'p1', kind: 'plane', definition: { offset: '5+5' } })
    expect('feature' in r).toBe(true)
    if ('feature' in r) {
      expect((r.feature.definition as Record<string, unknown>).offset).toBe(10)
    }
  })

  it('leaves kinds without expression fields untouched', () => {
    const f = { id: 'b1', kind: 'boolean', boolean: { op: 'union' } }
    const r = resolveFeatureExpressions(f)
    expect('feature' in r).toBe(true)
    if ('feature' in r) expect(r.feature).toBe(f)
  })

  it('resolves with an injected variable context', () => {
    const r = resolveFeatureExpressions(
      { id: 'e1', kind: 'extrude', extrude: { distance: 'width*2' } },
      { width: 7 },
    )
    expect('feature' in r).toBe(true)
    if ('feature' in r) {
      expect((r.feature.extrude as Record<string, unknown>).distance).toBe(14)
    }
  })
})
