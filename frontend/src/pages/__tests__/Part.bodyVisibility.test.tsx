import { describe, it, expect } from 'vitest'
import { applySetBodyVisibility } from '@/utils/yamlMutations'
import type { PartDoc } from '@/types/cad'

describe('applySetBodyVisibility', () => {
  it('sets body visible to false', () => {
    const doc = { kind: 'part', version: 1, features: [] } as PartDoc
    applySetBodyVisibility(doc, 'body_1', false)
    expect(doc.part_style?.body_1?.visible).toBe(false)
  })

  it('toggles body visibility back to true', () => {
    const doc = { kind: 'part', version: 1, features: [] } as PartDoc
    applySetBodyVisibility(doc, 'body_1', false)
    applySetBodyVisibility(doc, 'body_1', true)
    expect(doc.part_style?.body_1?.visible).toBe(true)
  })

  it('does not crash when part_style is undefined', () => {
    const doc = { kind: 'part', version: 1, features: [] } as PartDoc
    applySetBodyVisibility(doc, 'body_1', false)
    expect(doc.part_style?.body_1?.visible).toBe(false)
  })

  it('does not leak visibility through shared part_style entries', () => {
    const shared = { name: 'array part' }
    const doc = {
      kind: 'part',
      version: 1,
      features: [],
      part_style: {
        body_ca1: shared,
        body_ca1_1: shared,
      },
    } as PartDoc

    applySetBodyVisibility(doc, 'body_ca1', false)

    expect(doc.part_style?.body_ca1?.visible).toBe(false)
    expect(doc.part_style?.body_ca1_1?.visible).toBeUndefined()
    expect(doc.part_style?.body_ca1).not.toBe(doc.part_style?.body_ca1_1)
  })
})
