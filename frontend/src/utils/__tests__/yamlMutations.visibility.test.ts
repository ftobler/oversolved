import { describe, it, expect } from 'vitest'
import { applySetFeatureVisibility } from '../yamlMutations'
import type { PartDoc } from '../../types/cad'

describe('applySetFeatureVisibility', () => {
  function makeDoc(): PartDoc {
    return {
      version: 1,
      kind: 'part',
      features: [
        { id: 'sk1', kind: 'sketch' },
        { id: 'ex1', kind: 'extrude' },
      ],
    } as PartDoc
  }

  it('sets visible to false when hiding', () => {
    const doc = makeDoc()
    applySetFeatureVisibility(doc, 'sk1', false)
    expect(doc.features![0].visible).toBe(false)
  })

  it('deletes visible key when showing', () => {
    const doc = makeDoc()
    doc.features![0].visible = false
    applySetFeatureVisibility(doc, 'sk1', true)
    expect('visible' in doc.features![0]).toBe(false)
  })

  it('survives JSON roundtrip', () => {
    const doc = makeDoc()
    applySetFeatureVisibility(doc, 'sk1', false)
    const json = JSON.stringify(doc)
    const parsed = JSON.parse(json) as PartDoc
    expect(parsed.features![0].visible).toBe(false)
  })
})
