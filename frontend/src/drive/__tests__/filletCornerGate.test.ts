// @vitest-environment node
//
// The command gate's selection plan and the drive rule share one verdict: a
// vertex with no line partner or with a T-junction is refused by name, a
// selection with no vertex target says so, and an explicit pair is refused by
// the same corner planner the applier uses.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { buildFilletCornerMap } from '@/utils/geometry/filletCorner'
import { filletSelectionPlan } from '@/stores/editorState'
import { mutationValueViolation, type ValueContext } from '@/drive/mutationValues'

const line = (id: string, params: number[]) => ({ id, kind: 'line', params })

function docWith(entities: ReturnType<typeof line>[], constraints: PartDoc['features'] extends undefined ? never : Array<{ id: string; kind: string; a?: string; b?: string }> = []): PartDoc {
  return {
    features: [{
      id: 'sk', kind: 'sketch', plane: '@builtin_plane_front',
      entities,
      initial: Object.fromEntries(entities.map(entity => [entity.id, entity.params])),
      constraints,
    }],
  }
}

const ctx = (doc: PartDoc): ValueContext => ({
  doc, fileIds: null, fieldSchema: () => null,
})

describe('filletSelectionPlan command gate', () => {
  it('gives the map reason for a vertex with no line partner', () => {
    const doc = docWith([line('a', [10, 0, 0, 0])])
    const map = buildFilletCornerMap('sk', doc.features![0].kind === 'sketch'
      ? (doc.features![0].entities ?? []).map(entity => ({
          id: entity.id,
          kind: entity.kind,
          params: (doc.features![0] as { initial?: Record<string, number[]> }).initial?.[entity.id] ?? [],
        }))
      : [], [])
    const plan = filletSelectionPlan(new Set(['vertex:sk:a:end']), 'sk', map)
    expect('reason' in plan && plan.reason).toBe(
      'vertex "a:end" has no line partner in this sketch',
    )
    expect(map['vertex:sk:a:end']).toMatchObject({
      reason: 'vertex "a:end" has no line partner in this sketch',
    })
  })

  it('gives the map reason for a T-junction vertex', () => {
    const entities = [
      line('a', [10, 0, 0, 0]),
      line('b', [0, 0, 0, 10]),
      line('c', [0, 0, -10, 0]),
    ]
    const map = buildFilletCornerMap('sk', entities, [])
    const plan = filletSelectionPlan(new Set(['vertex:sk:a:end']), 'sk', map)
    expect('reason' in plan && plan.reason).toContain('more than one line partner')
    expect(map['vertex:sk:a:end']).toEqual({ reason: 'reason' in plan ? plan.reason : '' })
  })

  it('refuses a selection with no vertex target', () => {
    const plan = filletSelectionPlan(new Set(['entity:sk:a']), 'sk', {})
    expect('reason' in plan && plan.reason).toBe('select one or more sketch vertices to fillet')
  })

  it('plans one corner per selected vertex and deduplicates the pair', () => {
    const entities = [line('a', [10, 0, 0, 0]), line('b', [0, 0, 0, 10])]
    const map = buildFilletCornerMap('sk', entities, [])
    const plan = filletSelectionPlan(
      new Set(['vertex:sk:a:end', 'vertex:sk:b:start']),
      'sk',
      map,
    )
    expect('corners' in plan && plan.corners).toHaveLength(1)
    expect('corners' in plan && plan.corners[0]).toMatchObject({
      a: 'a', aVertex: 'end', b: 'b', bVertex: 'start',
    })
  })
})

describe('fillet_corners drive rule', () => {
  it('accepts a valid explicit pair', () => {
    const doc = docWith([line('a', [10, 0, 0, 0]), line('b', [0, 0, 0, 10])])
    const violation = mutationValueViolation('fillet_corners', {
      type: 'fillet_corners', featureId: 'sk', radius: 2,
      corners: [{ a: 'a', aVertex: 'end', b: 'b', bVertex: 'start' }],
    }, ctx(doc))
    expect(violation).toBeNull()
  })

  it('refuses an unknown side as an unknown target naming the id', () => {
    const doc = docWith([line('a', [10, 0, 0, 0])])
    const violation = mutationValueViolation('fillet_corners', {
      type: 'fillet_corners', featureId: 'sk', radius: 2,
      corners: [{ a: 'a', aVertex: 'end', b: 'missing', bVertex: 'start' }],
    }, ctx(doc))
    expect(violation?.code).toBe('unknown-target')
    expect(violation?.message).toContain('missing')
  })

  it('refuses a non-line side by name with the planner reason', () => {
    const doc = docWith([
      line('a', [10, 0, 0, 0]),
      { id: 'arc1', kind: 'arc', params: [0, 0, 5, 90, 180] },
    ])
    const violation = mutationValueViolation('fillet_corners', {
      type: 'fillet_corners', featureId: 'sk', radius: 2,
      corners: [{ a: 'a', aVertex: 'end', b: 'arc1', bVertex: 'start' }],
    }, ctx(doc))
    expect(violation?.code).toBe('invalid-mutation')
    expect(violation?.message).toContain('arc1')
    expect(violation?.message).toContain('already meets an arc')
  })

  it('refuses a repeated side and an empty corner list by shape', () => {
    const doc = docWith([line('a', [10, 0, 0, 0])])
    expect(mutationValueViolation('fillet_corners', {
      type: 'fillet_corners', featureId: 'sk', radius: 2, corners: [],
    }, ctx(doc))?.code).toBe('invalid-mutation')
    expect(mutationValueViolation('fillet_corners', {
      type: 'fillet_corners', featureId: 'sk', radius: 2,
      corners: [{ a: 'a', aVertex: 'end', b: 'a', bVertex: 'start' }],
    }, ctx(doc))?.code).toBe('invalid-mutation')
  })
})
