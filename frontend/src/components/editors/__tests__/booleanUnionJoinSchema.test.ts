// The union editor's one list, "Parts to join": the base is the first entry,
// the rest are the tools the kernel folds into it. Storage keeps the target +
// tools shape, so the list is assembled from both keys and no migration is
// needed. These checks live outside the widget (the delete-the-Viewport rule):
// the schema points the chip at this list, and the chip only draws it.

import { describe, it, expect } from 'vitest'
import { booleanJoinList } from '@/utils/core/booleanJoin'
import { BOOLEAN_SCHEMA } from '@/components/editors/featureEditorSchemas'

type LooseField = {
  key: string
  type: string
  label?: string
  showWhen?: (data: Record<string, unknown>) => boolean
  normalize?: (value: unknown, data: Record<string, unknown>) => unknown
  baseTag?: string
  multi?: boolean
}

const fields = BOOLEAN_SCHEMA.fields as LooseField[]
const joinField = fields.find((f) => f.baseTag === 'base')
const targetField = fields.find((f) => f.key === 'target')
const splitToolsField = fields.filter((f) => f.key === 'tools' && f.baseTag === undefined)

const isShown = (field: LooseField | undefined, operation: string): boolean =>
  field?.showWhen?.({ operation } as Record<string, unknown>) ?? true

describe('booleanJoinList', () => {
  it('puts the base first, then the tools', () => {
    expect(booleanJoinList({ target: '@body_a', tools: ['@body_c', '@body_b'] }))
      .toEqual(['@body_a', '@body_c', '@body_b'])
  })

  it('is empty when nothing is picked, and skips empty entries', () => {
    expect(booleanJoinList({})).toEqual([])
    expect(booleanJoinList({ target: '', tools: [] })).toEqual([])
    expect(booleanJoinList({ target: '', tools: ['', '@body_b'] })).toEqual(['@body_b'])
  })

  it('drops a duplicate of the base from the tool list', () => {
    expect(booleanJoinList({ target: '@body_a', tools: ['@body_a', '@body_b'] }))
      .toEqual(['@body_a', '@body_b'])
  })
})

describe('BOOLEAN_SCHEMA union picker', () => {
  it('offers one bodies-to-join list for union, with the base tagged', () => {
    expect(joinField).toBeDefined()
    expect(joinField?.type).toBe('pick')
    expect(joinField?.label).toBe('Parts to join')
    expect(joinField?.multi).toBe(true)
    expect(joinField?.baseTag).toBe('base')
    expect(isShown(joinField, 'union')).toBe(true)
  })

  it('shows target plus tools for subtract and intersect, not the join list', () => {
    expect(isShown(joinField, 'subtract')).toBe(false)
    expect(isShown(joinField, 'intersect')).toBe(false)
    expect(targetField).toBeDefined()
    expect(isShown(targetField, 'subtract')).toBe(true)
    expect(isShown(targetField, 'intersect')).toBe(true)
    expect(isShown(targetField, 'union')).toBe(false)
    for (const tools of splitToolsField) {
      expect(isShown(tools, 'subtract')).toBe(true)
      expect(isShown(tools, 'intersect')).toBe(true)
      expect(isShown(tools, 'union')).toBe(false)
    }
  })

  it('feeds the join list from the stored target and tools', () => {
    expect(joinField?.normalize?.('ignored', { operation: 'union', target: '@body_a', tools: ['@body_b'] }))
      .toEqual(['@body_a', '@body_b'])
  })
})
