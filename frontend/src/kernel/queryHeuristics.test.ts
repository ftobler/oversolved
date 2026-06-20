import { describe, it, expect } from 'vitest'
import {
  Outcome,
  DEFAULT_HEURISTIC_CONFIG,
  weightFor,
  scoreOverlap,
  scoreGeometryLeaf,
  pickBest,
  type HeuristicConfig,
} from './queryHeuristics'

// A config that only differs from the default where a test needs it to.
function cfg(overrides: Partial<HeuristicConfig> = {}): HeuristicConfig {
  return { ...DEFAULT_HEURISTIC_CONFIG, ...overrides }
}

describe('DEFAULT_HEURISTIC_CONFIG', () => {
  it('ships the documented defaults', () => {
    expect(DEFAULT_HEURISTIC_CONFIG.overlapThreshold).toBe(0.5)
    expect(DEFAULT_HEURISTIC_CONFIG.kindWeights).toEqual({})
    expect(DEFAULT_HEURISTIC_CONFIG.geometryLeafTolerance).toBe(0.01)
    expect(DEFAULT_HEURISTIC_CONFIG.ambiguityMargin).toBe(0.0)
  })
})

describe('weightFor', () => {
  it('returns the configured weight for a known kind', () => {
    expect(weightFor(cfg({ kindWeights: { face: 3.5 } }), 'face')).toBe(3.5)
  })

  it('falls back to 1.0 for an unconfigured kind', () => {
    expect(weightFor(cfg({ kindWeights: { face: 3.5 } }), 'edge')).toBe(1.0)
  })

  it('falls back to 1.0 when no weights are configured', () => {
    expect(weightFor(DEFAULT_HEURISTIC_CONFIG, 'anything')).toBe(1.0)
  })

  it('honours an explicit zero weight rather than treating it as missing', () => {
    expect(weightFor(cfg({ kindWeights: { edge: 0 } }), 'edge')).toBe(0)
  })
})

describe('scoreOverlap', () => {
  it('returns 0 when there are no old ids', () => {
    expect(scoreOverlap(new Set(), new Set(['a', 'b']))).toBe(0.0)
  })

  it('returns the fraction of old ids present in the new set', () => {
    expect(scoreOverlap(new Set(['a', 'b', 'c', 'd']), new Set(['a', 'b']))).toBe(0.5)
  })

  it('returns 1 when every old id survives', () => {
    expect(scoreOverlap(new Set(['a', 'b']), new Set(['a', 'b', 'c']))).toBe(1.0)
  })

  it('returns 0 when nothing overlaps', () => {
    expect(scoreOverlap(new Set(['a', 'b']), new Set(['x', 'y']))).toBe(0.0)
  })
})

describe('scoreGeometryLeaf', () => {
  it('treats a null old hint as no penalty (1.0)', () => {
    expect(scoreGeometryLeaf(null, { x: 1 }, DEFAULT_HEURISTIC_CONFIG)).toBe(1.0)
  })

  it('treats a null new hint as no penalty (1.0)', () => {
    expect(scoreGeometryLeaf({ x: 1 }, null, DEFAULT_HEURISTIC_CONFIG)).toBe(1.0)
  })

  it('returns 0 when there are no shared keys', () => {
    expect(scoreGeometryLeaf({ x: 1 }, { y: 1 }, DEFAULT_HEURISTIC_CONFIG)).toBe(0.0)
  })

  it('matches numbers within the relative tolerance', () => {
    // 0.5 / 100 = 0.005 <= 0.01
    expect(scoreGeometryLeaf({ x: 100 }, { x: 100.5 }, DEFAULT_HEURISTIC_CONFIG)).toBe(1.0)
  })

  it('rejects numbers outside the relative tolerance', () => {
    // 2 / 100 = 0.02 > 0.01
    expect(scoreGeometryLeaf({ x: 100 }, { x: 102 }, DEFAULT_HEURISTIC_CONFIG)).toBe(0.0)
  })

  it('matches two near-zero numbers without dividing through zero', () => {
    expect(scoreGeometryLeaf({ x: 0 }, { x: 1e-13 }, DEFAULT_HEURISTIC_CONFIG)).toBe(1.0)
  })

  it('rejects a near-zero against a non-zero number', () => {
    expect(scoreGeometryLeaf({ x: 0 }, { x: 5 }, DEFAULT_HEURISTIC_CONFIG)).toBe(0.0)
  })

  it('matches equal non-number values', () => {
    expect(scoreGeometryLeaf({ kind: 'arc' }, { kind: 'arc' }, DEFAULT_HEURISTIC_CONFIG)).toBe(1.0)
  })

  it('rejects unequal non-number values', () => {
    expect(scoreGeometryLeaf({ kind: 'arc' }, { kind: 'line' }, DEFAULT_HEURISTIC_CONFIG)).toBe(0.0)
  })

  it('matches when both shared values are null', () => {
    expect(scoreGeometryLeaf({ x: null }, { x: null }, DEFAULT_HEURISTIC_CONFIG)).toBe(1.0)
  })

  it('rejects a null value against a defined one', () => {
    expect(scoreGeometryLeaf({ x: null }, { x: 5 }, DEFAULT_HEURISTIC_CONFIG)).toBe(0.0)
  })

  it('scores the fraction of matching shared keys', () => {
    // a matches, b does not; c is not shared and ignored.
    const score = scoreGeometryLeaf(
      { a: 1, b: 'arc', c: 9 },
      { a: 1, b: 'line' },
      DEFAULT_HEURISTIC_CONFIG,
    )
    expect(score).toBe(0.5)
  })

  it('respects a widened tolerance from config', () => {
    // 2 / 100 = 0.02, now within tolerance.
    expect(scoreGeometryLeaf({ x: 100 }, { x: 102 }, cfg({ geometryLeafTolerance: 0.05 }))).toBe(1.0)
  })
})

describe('pickBest', () => {
  it('returns UNRESOLVED for an empty candidate list', () => {
    expect(pickBest([], DEFAULT_HEURISTIC_CONFIG)).toEqual([Outcome.UNRESOLVED, null])
  })

  it('returns RESOLVED with the sole candidate', () => {
    expect(pickBest([['only', 0.1]], DEFAULT_HEURISTIC_CONFIG)).toEqual([Outcome.RESOLVED, 'only'])
  })

  it('resolves to the top scorer when it beats the runner-up by more than the margin', () => {
    const scores: [string, number][] = [['a', 0.9], ['b', 0.4]]
    expect(pickBest(scores, DEFAULT_HEURISTIC_CONFIG)).toEqual([Outcome.RESOLVED, 'a'])
  })

  it('sorts before comparing so input order does not matter', () => {
    const scores: [string, number][] = [['b', 0.4], ['a', 0.9]]
    expect(pickBest(scores, DEFAULT_HEURISTIC_CONFIG)).toEqual([Outcome.RESOLVED, 'a'])
  })

  it('returns AMBIGUOUS when the top two scores tie', () => {
    const scores: [string, number][] = [['a', 0.5], ['b', 0.5]]
    expect(pickBest(scores, DEFAULT_HEURISTIC_CONFIG)).toEqual([Outcome.AMBIGUOUS, null])
  })

  it('treats a gap exactly equal to the margin as ambiguous (strictly greater required)', () => {
    const scores: [string, number][] = [['a', 0.6], ['b', 0.5]]
    expect(pickBest(scores, cfg({ ambiguityMargin: 0.1 }))).toEqual([Outcome.AMBIGUOUS, null])
  })

  it('resolves when the gap exceeds the configured margin', () => {
    const scores: [string, number][] = [['a', 0.65], ['b', 0.5]]
    expect(pickBest(scores, cfg({ ambiguityMargin: 0.1 }))).toEqual([Outcome.RESOLVED, 'a'])
  })

  it('keeps the first of equal-scoring winners via stable sort', () => {
    // a and b tie at the top; with a margin they stay ambiguous, but a third lower
    // entry must not perturb which pair is compared.
    const scores: [string, number][] = [['a', 0.8], ['b', 0.8], ['c', 0.1]]
    expect(pickBest(scores, DEFAULT_HEURISTIC_CONFIG)).toEqual([Outcome.AMBIGUOUS, null])
  })
})
