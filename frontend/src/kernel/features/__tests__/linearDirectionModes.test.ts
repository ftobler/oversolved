// The linear pattern's direction modes, at the step law: what one direction
// translates by, per mode, invert included, and the refusals a pick earns. The
// geometry is a repository payload here (no OCC), so this pins the law the real
// suites measure copies against.

import { describe, it, expect } from 'vitest'
import { resolveLinearStep } from '../linearPattern'
import { Repository } from '../../query'
import type { Body } from '../../types3d'

type Dict = Record<string, unknown>

const store: Record<string, Body> = {}

/** A repo holding the direction payloads the tests name, all under their own
 *  feature ref so the plain query path resolves them. */
function repoWith(payloads: Record<string, Dict>): Repository {
  const repo = new Repository()
  for (const [ref, payload] of Object.entries(payloads)) {
    repo.register(ref.startsWith('@') ? ref.slice(1) : ref, payload)
  }
  return repo
}

const edge = (end: [number, number, number]): Dict => ({ start: [0, 0, 0], end })
const plane = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }

/** A negated zero is the number 0; compare it as such. */
const norm = (v: number[]): number[] => v.map((n) => (n === 0 ? 0 : n))

describe('resolveLinearStep: direction_distance', () => {
  it('is the default when no mode is stored, and is the old behaviour', () => {
    const repo = repoWith({})
    const step = resolveLinearStep({ direction: [2, 0, 0], pitch: 5 }, 1, repo, store)
    expect(step).toEqual([5, 0, 0])
  })

  it('normalises a stored vector and scales it by the pitch', () => {
    const repo = repoWith({})
    expect(resolveLinearStep({ direction_mode: 'direction_distance', direction: [3, 4, 0], pitch: 10 }, 1, repo, store))
      .toEqual([6, 8, 0])
  })

  it('flips the sense with invert, keeping the magnitude', () => {
    const repo = repoWith({})
    const step = resolveLinearStep({ direction: [1, 0, 0], pitch: 5, invert: true }, 1, repo, store)
    expect(norm(step)).toEqual([-5, 0, 0])
  })

  it('reads the pick over the stored vector', () => {
    const repo = repoWith({ '@ex1/edge0': edge([15, 0, 0]) })
    expect(resolveLinearStep({ direction_query: '@ex1/edge0', direction: [0, 0, 1], pitch: 5 }, 1, repo, store))
      .toEqual([5, 0, 0])
  })
})

describe('resolveLinearStep: directive_length', () => {
  it('uses the picked edge length as the spacing, not the pitch', () => {
    const repo = repoWith({ '@ex1/edge0': edge([15, 0, 0]) })
    const step = resolveLinearStep(
      { direction_mode: 'directive_length', direction_query: '@ex1/edge0', pitch: 99 }, 1, repo, store,
    )
    expect(step).toEqual([15, 0, 0])
  })

  it('inverts the sense but never the length', () => {
    const repo = repoWith({ '@ex1/edge0': edge([0, 12, 0]) })
    const step = resolveLinearStep(
      { direction_mode: 'directive_length', direction_query: '@ex1/edge0', invert: true }, 1, repo, store,
    )
    expect(norm(step)).toEqual([0, -12, 0])
  })

  it('takes a sketch line length through its plane', () => {
    const repo = repoWith({
      '_pt_sk1': plane,
      'sk1/l1': { external_params: [0, 0, 12, 0], kind: 'line', sketch_id: 'sk1' },
    })
    const step = resolveLinearStep(
      { direction_mode: 'directive_length', direction_query: '@sk1/l1' }, 1, repo, store,
    )
    expect(step).toEqual([12, 0, 0])
  })

  it('refuses a planar face by name', () => {
    const repo = repoWith({ '@ex1/face0': { type: 'flatface', normal: [0, 0, 1], centroid: [0, 0, 0] } })
    expect(() => resolveLinearStep(
      { direction_mode: 'directive_length', direction_query: '@ex1/face0' }, 1, repo, store,
    )).toThrow(/a planar face has none/)
  })

  it('refuses a circle by name', () => {
    const repo = repoWith({ '@ex1/edge0': { center: [0, 0, 0], axis: [0, 0, 1], radius: 5 } })
    expect(() => resolveLinearStep(
      { direction_mode: 'directive_length', direction_query: '@ex1/edge0' }, 1, repo, store,
    )).toThrow(/directive length needs a pick with a length \(a straight edge, cylinder or cone\); a circle has none/)
  })

  it('refuses a stored vector, which has no length to give', () => {
    expect(() => resolveLinearStep(
      { direction_mode: 'directive_length', direction: [1, 0, 0] }, 1, repoWith({}), store,
    )).toThrow(/needs a pick with a length in directive_length mode/)
  })

  it('cannot read a face extent without an OCC context, and says so', () => {
    const repo = repoWith({ '@ex1/coneface': { type: 'coneface', surface_frame: { axis: [0, 0, 1], origin: [0, 0, 0] } } })
    expect(() => resolveLinearStep(
      { direction_mode: 'directive_length', direction_query: '@ex1/coneface' }, 1, repo, store,
    )).toThrow(/could not read the picked face's length/)
  })
})

describe('resolveLinearStep: manual', () => {
  it('takes the vector as the whole step, magnitude included', () => {
    expect(resolveLinearStep(
      { direction_mode: 'manual', direction: [10, 0, 5], pitch: 99 }, 1, repoWith({}), store,
    )).toEqual([10, 0, 5])
  })

  it('flips every component with invert', () => {
    const step = resolveLinearStep(
      { direction_mode: 'manual', direction: [10, 0, -5], invert: true }, 1, repoWith({}), store,
    )
    expect(norm(step)).toEqual([-10, 0, 5])
  })

  it('refuses a zero vector', () => {
    expect(() => resolveLinearStep(
      { direction_mode: 'manual', direction: [0, 0, 0] }, 1, repoWith({}), store,
    )).toThrow(/non-zero step vector in manual mode/)
  })

  it('refuses a missing or malformed vector', () => {
    expect(() => resolveLinearStep({ direction_mode: 'manual' }, 1, repoWith({}), store))
      .toThrow(/three finite numbers as a step vector in manual mode/)
    expect(() => resolveLinearStep({ direction_mode: 'manual', direction: [1, 0] }, 1, repoWith({}), store))
      .toThrow(/three finite numbers/)
  })

  it('reads the second direction from its own mode and vector', () => {
    const repo = repoWith({ '@ex1/edge0': edge([0, 7, 0]) })
    const sub: Dict = {
      direction_mode: 'manual', direction: [10, 0, 0],
      direction_2_mode: 'directive_length', direction_2_query: '@ex1/edge0', pitch_2: 99,
    }
    expect(resolveLinearStep(sub, 1, repo, store)).toEqual([10, 0, 0])
    expect(resolveLinearStep(sub, 2, repo, store)).toEqual([0, 7, 0])
  })

  it('refuses an unknown mode by its stored key', () => {
    expect(() => resolveLinearStep({ direction_2_mode: 'sideways' }, 2, repoWith({}), store))
      .toThrow(/direction_2_mode must be direction_distance, directive_length or manual/)
  })
})
