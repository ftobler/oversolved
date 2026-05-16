import { describe, it, expect } from 'vitest'
import { applySetFeatureSuppression } from '@/utils/yamlMutations'
import type { PartDoc } from '@/types/cad'

function makeDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      { id: 'Origin', kind: 'origin' },
      { id: 'sk1', kind: 'sketch' },
      { id: 'ex1', kind: 'extrude' },
    ],
  } as PartDoc
}

describe('applySetFeatureSuppression', () => {
  it('sets suppressed=true on a non-built-in feature', () => {
    const doc = makeDoc()
    applySetFeatureSuppression(doc, 'ex1', true)
    expect(doc.features![2].suppressed).toBe(true)
  })

  it('removes the suppressed field when clearing (not false, absent)', () => {
    const doc = makeDoc()
    doc.features![2].suppressed = true
    applySetFeatureSuppression(doc, 'ex1', false)
    expect('suppressed' in doc.features![2]).toBe(false)
  })

  it('refuses to suppress a built-in feature (Origin)', () => {
    const doc = makeDoc()
    applySetFeatureSuppression(doc, 'Origin', true)
    expect(doc.features![0].suppressed).toBeUndefined()
  })

  it('is a no-op for unknown feature ids', () => {
    const doc = makeDoc()
    applySetFeatureSuppression(doc, 'nonexistent', true)
    for (const f of doc.features!) {
      expect(f.suppressed).toBeUndefined()
    }
  })

  it('survives JSON roundtrip', () => {
    const doc = makeDoc()
    applySetFeatureSuppression(doc, 'sk1', true)
    const parsed = JSON.parse(JSON.stringify(doc)) as PartDoc
    expect(parsed.features![1].suppressed).toBe(true)
  })
})
