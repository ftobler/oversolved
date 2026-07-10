import { describe, it, expect } from 'vitest'
import { describeMutation } from '@/utils/core/mutationDescriptions'
import { ALL_MUTATION_TYPES } from '@/hooks/__tests__/mutationDispatch.exhaustive.test'
import type { Mutation } from '@/types/cad'

const EMPTY_MUTATION: Record<string, unknown> = {
  featureId: '',
  entityId: '',
  vertexKey: '',
  constraintKind: '',
  constraintId: '',
  targets: [],
  kind: '',
  params: [],
  entityIds: [],
  sourceIds: [],
  sides: 0,
  distance: 0,
  field: '',
  value: '',
  tool: '',
  edgeQuery: '',
  sketchQuery: '',
  bodyId: '',
  label: '',
  source: '',
  plane: '',
  index: 0,
  fromIndex: 0,
  toIndex: 0,
  suppressed: false,
  position: 0,
}

describe('describeMutation', () => {
  it.each(ALL_MUTATION_TYPES)('returns a non-unknown description for %s', (type) => {
    const result = describeMutation({ type, ...EMPTY_MUTATION } as Mutation)
    expect(result).not.toBe('unknown mutation')
  })
})
