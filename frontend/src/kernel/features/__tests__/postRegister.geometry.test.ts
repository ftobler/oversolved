// Hand-written coverage for postRegister's OCC-free helpers that the
// fixture-driven parity gate does not reach: resolveSketchPlane's ancestry and
// registry fallbacks, the rich-dict branch of registerSolvedGeometrySlash, and
// enrichSketchEntity's unknown-kind fallback.

import { describe, it, expect } from 'vitest'
import { initGlobalRepo, Repository, makeAncestryQuery, canonical } from '../../query'
import { postRegister, resolveSketchPlane, enrichSketchEntity } from '../postRegister'

describe('resolveSketchPlane', () => {
  const front = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }

  it('falls back to the front plane for a missing query', () => {
    expect(resolveSketchPlane(null, initGlobalRepo())).toEqual(front)
    expect(resolveSketchPlane(undefined, initGlobalRepo())).toEqual(front)
  })

  it('resolves a builtin plane by token and by bare name', () => {
    const repo = initGlobalRepo()
    expect(resolveSketchPlane('@builtin_plane_top', repo).normal).toEqual([0, 1, 0])
    expect(resolveSketchPlane('Top', repo).normal).toEqual([0, 1, 0])
  })

  it('resolves a plane feature registered as _pt_<id>', () => {
    const repo = new Repository()
    repo.elements.set('_pt_pl1', { ...front, origin: [0, 0, 7] })
    expect(resolveSketchPlane('@pl1', repo).origin).toEqual([0, 0, 7])
  })

  it('resolves a plane registered under its bare id', () => {
    const repo = new Repository()
    repo.register('pl2', { ...front, origin: [0, 0, 3] })
    expect(resolveSketchPlane('pl2', repo).origin).toEqual([0, 0, 3])
  })

  it('resolves an ancestry query through the repository', () => {
    const repo = new Repository()
    const face = { origin: [1, 2, 3], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1], type: 'flatface' }
    repo.registerAncestor(['@sk1/f1'], face)
    const q = makeAncestryQuery(['@sk1/f1'], 'flatface')
    expect(resolveSketchPlane(q, repo).origin).toEqual([1, 2, 3])
  })

  it('falls back to the front plane when nothing matches', () => {
    const repo = new Repository()
    expect(resolveSketchPlane('@nope', repo)).toEqual(front)
    expect(resolveSketchPlane(makeAncestryQuery(['@nope'], 'flatface'), repo)).toEqual(front)
  })
})

describe('registerSolvedGeometrySlash rich dicts', () => {
  it('lowers circle/arc/point rich geometry into flat params and slash points', () => {
    const repo = initGlobalRepo()
    const feature = {
      id: 'f1',
      entities: [
        { id: 'c1', kind: 'circle' },
        { id: 'a1', kind: 'arc' },
        { id: 'p1', kind: 'point' },
      ],
    }
    const geometry = {
      c1: { center: [1, 2], radius: 3 },
      a1: { center: [0, 0], radius: 5, angle_start: 0, angle_end: 90 },
      p1: { xy: [4, 5] },
    }
    postRegister(repo, 'f1', feature, { status: 'ok', geometry })

    expect(repo.elements.get('f1/c1')).toEqual({ external_params: [1, 2, 3], kind: 'circle', sketch_id: 'f1' })
    expect(repo.elements.get('f1/c1/center')).toEqual({ external_xy: [1, 2], sketch_id: 'f1' })

    expect(repo.elements.get('f1/a1')).toEqual({ external_params: [0, 0, 5, 0, 90], kind: 'arc', sketch_id: 'f1' })
    const arcStart = repo.elements.get('f1/a1/start') as { external_xy: number[] }
    expect(arcStart.external_xy[0]).toBeCloseTo(5)
    expect(arcStart.external_xy[1]).toBeCloseTo(0)
    const arcEnd = repo.elements.get('f1/a1/end') as { external_xy: number[] }
    expect(arcEnd.external_xy[0]).toBeCloseTo(0)
    expect(arcEnd.external_xy[1]).toBeCloseTo(5)
    expect(repo.elements.get('f1/a1/center')).toEqual({ external_xy: [0, 0], sketch_id: 'f1' })

    expect(repo.elements.get('f1/p1')).toEqual({ external_params: [4, 5], kind: 'point', sketch_id: 'f1' })
    expect(repo.elements.get('f1/p1/xy')).toEqual({ external_xy: [4, 5], sketch_id: 'f1' })
  })

  it('skips geometry keyed to an entity the feature does not list', () => {
    // A stale solver output can carry an entity id the current feature no
    // longer declares; registering it would leave a ghost slash path that
    // downstream picks resolve against.
    const repo = initGlobalRepo()
    postRegister(repo, 'f1', { id: 'f1', entities: [{ id: 'c0', kind: 'circle' }] }, {
      status: 'ok',
      geometry: {
        c0: { center: [1, 2], radius: 3 },
        ghost: { center: [4, 5], radius: 6 },
      },
    })
    expect(repo.elements.has('f1/c0')).toBe(true)
    expect(repo.elements.has('f1/ghost')).toBe(false)
  })

  it('skips a rich geometry kind it has no slash form for', () => {
    // A spline has no entity-level slash params form here; it must not be
    // registered as an empty/garbage element.
    const repo = initGlobalRepo()
    postRegister(repo, 'f1', { id: 'f1', entities: [{ id: 'x1', kind: 'spline' }] }, {
      status: 'ok',
      geometry: { x1: { start: [0, 0], end: [1, 1] } },
    })
    expect(repo.elements.has('f1/x1')).toBe(false)
  })
})

describe('enrichSketchEntity', () => {
  it('returns an empty dict for a kind it does not know', () => {
    expect(enrichSketchEntity('bogus', [1, 2, 3])).toEqual({})
  })
})

describe('topology ancestral dedup', () => {
  it('registers one ancestral element for two identical surfaces in one solve', () => {
    // The area builder can emit the same surface twice; re-registering the
    // identical payload would churn element ids for no change. The dedup keeps
    // exactly one element under the shared ancestry key.
    const repo = initGlobalRepo()
    const surface = { query: makeAncestryQuery(['@sk1/a'], 'flatface'), boundary: [] }
    postRegister(repo, 'sk1', { id: 'sk1', entities: [] }, {
      status: 'ok',
      plane_transform: { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], origin: [0, 0, 0] },
      topology: { surfaces: [surface, surface], edges: [], vertices: {} },
    })

    const entry = repo.ancestral.get(canonical(['@sk1/a']))
    expect(entry).toBeDefined()
    expect(entry!.eids).toHaveLength(1)
  })
})
