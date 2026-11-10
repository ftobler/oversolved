import { describe, it, expect } from 'vitest'
import type { BodyResult, Mesh3D } from '@/types/cad'
import { makeAncestryQuery } from '@/kernel/query'
import {
  EMPTY_RELATION_SET,
  HintIndex,
  buildCreatorIndex,
  edgeCreatorsOf,
  faceCreatorsOf,
  hintDrivers,
  relationKindOf,
  relatedHints,
  type RelationRuleLike,
} from '@/picking/relationHint'

const faceQuery = (creator: string, body = 'body_b1', extra: string[] = []) =>
  makeAncestryQuery(['@u|uuid-' + creator, `@${creator}`, `@${body}`, ...extra], 'flatface')

const edgeQuery = (creator: string, body = 'body_b1') =>
  makeAncestryQuery(['@u|edge-' + creator, `@${creator}`, `@${body}`], 'straightedge')

function meshWith(overrides: Partial<Mesh3D> = {}): Mesh3D {
  return { vertices: [], faces: [], ...overrides }
}

describe('hintDrivers', () => {
  it('reads the selection as the drivers', () => {
    expect(hintDrivers(new Set(['@ex1', '?0;:flatface']))).toEqual(['@ex1', '?0;:flatface'])
  })

  it('an empty selection has no drivers', () => {
    expect(hintDrivers(new Set())).toEqual([])
  })
})

describe('relationKindOf', () => {
  const ctx = {
    featureKinds: new Map([
      ['ex1', 'feature'],
      ['sk1', 'sketch'],
      ['hx1', 'sketch'],
    ] as const),
    partHandles: new Set(['p1']),
    mateIds: new Set(['m1']),
  }

  it('classifies a face and an edge query by its type restriction', () => {
    expect(relationKindOf(faceQuery('ex1'), ctx)).toBe('face')
    expect(relationKindOf(edgeQuery('ex1'), ctx)).toBe('edge')
  })

  it('classifies feature, sketch and helix rows', () => {
    expect(relationKindOf('@ex1', ctx)).toBe('feature')
    expect(relationKindOf('@sk1', ctx)).toBe('sketch')
    expect(relationKindOf('@hx1', ctx)).toBe('sketch')
  })

  it('classifies assembly part handles and mate ids', () => {
    expect(relationKindOf('p1', ctx)).toBe('part')
    expect(relationKindOf('m1', ctx)).toBe('mate')
  })

  it('builtins, unknown ids and malformed queries relate nothing', () => {
    expect(relationKindOf('@builtin_origin', ctx)).toBeNull()
    expect(relationKindOf('@builtin_plane_top', ctx)).toBeNull()
    expect(relationKindOf('@unknown', ctx)).toBeNull()
    expect(relationKindOf('?not-a-query', ctx)).toBeNull()
    expect(relationKindOf('', ctx)).toBeNull()
  })
})

describe('relatedHints core', () => {
  const ctx = {
    featureKinds: new Map([
      ['a', 'feature'],
      ['b', 'feature'],
      ['sk', 'sketch'],
    ] as const),
  }

  const rule = (
    id: string,
    from: 'feature' | 'sketch' | 'face' | 'edge' | 'part' | 'mate',
    to: 'feature' | 'sketch' | 'face' | 'edge' | 'part' | 'mate',
    targets: Record<string, string[]>,
    show: readonly ('tree' | 'viewport')[] = ['tree'],
    enabled = true,
  ): RelationRuleLike<typeof ctx> => ({
    id, from, to, show, enabled, related: (driver) => targets[driver] ?? [],
  })

  it('one selected driver yields its targets in the requested buckets', () => {
    const hints = relatedHints(['@a'], [rule('a->b', 'feature', 'feature', { '@a': ['b'] })], ctx)
    expect(hints.tree).toEqual(new Set(['@b']))
    expect(hints.viewport).toEqual(new Set())
  })

  it('several drivers union their answers', () => {
    const hints = relatedHints(
      ['@a', '@b'],
      [rule('a->b', 'feature', 'feature', { '@a': ['x'], '@b': ['x', 'y'] })],
      ctx,
    )
    expect(hints.tree).toEqual(new Set(['@x', '@y']))
  })

  it('a driver is never its own target', () => {
    const hints = relatedHints(['@a'], [rule('a->a', 'feature', 'feature', { '@a': ['a', 'b'] })], ctx)
    expect(hints.tree).toEqual(new Set(['@b']))
  })

  it('a rule may target another selected driver, keeping .selected.related possible', () => {
    const hints = relatedHints(
      ['@a', '@b'],
      [rule('a->b', 'feature', 'feature', { '@a': ['b'], '@b': [] })],
      ctx,
    )
    expect(hints.tree).toEqual(new Set(['@b']))
  })

  it('a disabled rule contributes nothing', () => {
    const hints = relatedHints(
      ['@a'],
      [rule('a->b', 'feature', 'feature', { '@a': ['b'] }, ['tree'], false)],
      ctx,
    )
    expect(hints.tree).toBe(EMPTY_RELATION_SET)
  })

  it('a rule only runs for its own driver kind', () => {
    const hints = relatedHints(['@sk'], [rule('a->b', 'feature', 'feature', { '@sk': ['b'] })], ctx)
    expect(hints.tree).toBe(EMPTY_RELATION_SET)
  })

  it('an empty answer is the shared empty set by reference', () => {
    const first = relatedHints(['@a'], [rule('a->b', 'feature', 'feature', {})], ctx)
    const second = relatedHints(['@b'], [rule('a->b', 'feature', 'feature', {})], ctx)
    expect(first.tree).toBe(EMPTY_RELATION_SET)
    expect(first.viewport).toBe(EMPTY_RELATION_SET)
    expect(second.tree).toBe(first.tree)
  })

  it('no drivers is the shared empty answer', () => {
    expect(relatedHints([], [rule('a->b', 'feature', 'feature', { '@a': ['b'] })], ctx).tree)
      .toBe(EMPTY_RELATION_SET)
  })
})

describe('faceCreatorsOf', () => {
  it('prefers face_created_by when it is aligned', () => {
    const mesh = meshWith({
      face_queries: [faceQuery('fromQuery1'), faceQuery('fromQuery2')],
      face_created_by: ['fromField1', 'fromField2'],
    })
    expect(faceCreatorsOf(mesh, 'bodyCreator')).toEqual(['fromField1', 'fromField2'])
  })

  it('falls back to the query lineage when the array is absent', () => {
    const mesh = meshWith({ face_queries: [faceQuery('ex1'), faceQuery('cut1')] })
    expect(faceCreatorsOf(mesh, 'bodyCreator')).toEqual(['ex1', 'cut1'])
  })

  it('falls back to the body creator for an empty placeholder', () => {
    const mesh = meshWith({ face_queries: ['', faceQuery('ex1')] })
    expect(faceCreatorsOf(mesh, 'bodyCreator')).toEqual(['bodyCreator', 'ex1'])
  })

  it('ignores a misaligned array instead of shifting creators by one', () => {
    const mesh = meshWith({
      face_queries: [faceQuery('ex1'), faceQuery('cut1')],
      face_created_by: ['only-one'],
    })
    expect(faceCreatorsOf(mesh, 'bodyCreator')).toEqual(['ex1', 'cut1'])
  })
})

describe('edgeCreatorsOf', () => {
  function body(overrides: Partial<BodyResult> = {}): BodyResult {
    return { id: 'b1', created_by: 'bodyCreator', modified_by: [], ...overrides }
  }

  it('prefers edge_created_by when aligned', () => {
    expect(edgeCreatorsOf(body({
      edge_queries: [edgeQuery('fromQuery')],
      edge_created_by: ['fromField'],
    }))).toEqual(['fromField'])
  })

  it('falls back to the lineage and then the body creator', () => {
    expect(edgeCreatorsOf(body({ edge_queries: [edgeQuery('ex1'), ''] })))
      .toEqual(['ex1', 'bodyCreator'])
  })
})

describe('buildCreatorIndex', () => {
  it('answers every creator of a query shared by two primitives', () => {
    const shared = faceQuery('ex1')
    const index = buildCreatorIndex({
      b1: {
        id: 'b1', created_by: 'ex1', modified_by: [],
        mesh: meshWith({ face_queries: [shared], face_created_by: ['ex1'] }),
      },
      b2: {
        id: 'b2', created_by: 'cut1', modified_by: [],
        mesh: meshWith({ face_queries: [shared], face_created_by: ['cut1'] }),
      },
    })
    expect(new Set(index(shared))).toEqual(new Set(['ex1', 'cut1']))
  })

  it('answers nothing for a query no body owns', () => {
    const index = buildCreatorIndex({})
    expect(index(faceQuery('ex1'))).toEqual([])
  })
})

describe('HintIndex', () => {
  it('returns the shared none array when no hinted feature is on the body', () => {
    const index = new HintIndex(['ex1', 'ex1', 'cut1'])
    expect(index.compute(new Set(['other']))).toBe(index.none)
    expect(index.compute(new Set())).toBe(index.none)
  })

  it('flags exactly the faces a hinted feature created', () => {
    const index = new HintIndex(['ex1', 'cut1', 'ex1', 'cut1'])
    expect(index.compute(new Set(['cut1']))).toEqual([false, true, false, true])
  })

  it('flags every copy of a pattern-owned face', () => {
    const index = new HintIndex(['pat1', 'ex1', 'pat1'])
    expect(index.compute(new Set(['pat1']))).toEqual([true, false, true])
  })
})
