/**
 * Tests for feature 278: no silent default location fallback on missing sketch plane.
 */
import { describe, it, expect } from 'vitest'
import { applyAddSketch } from '@/utils/yamlMutations/partStyle'
import type { PartDoc } from '@/types/cad'
import { featureById } from '@/testing/featureAccess'

function emptyDoc(): PartDoc {
  return { version: 1, kind: 'part', features: [] }
}

describe('applyAddSketch sets no default plane', () => {
  it('new sketch has no plane -- user must pick one', () => {
    const doc = emptyDoc()
    applyAddSketch(doc, 'sk1')
    const sketch = featureById(doc, 'sk1', 'sketch')
    expect(sketch.plane).toBeUndefined()
  })

  it('preserves label when provided', () => {
    const doc = emptyDoc()
    applyAddSketch(doc, 'sk1', 'my sketch')
    const sketch = featureById(doc, 'sk1', 'sketch')
    expect(sketch.label).toBe('my sketch')
    expect(sketch.plane).toBeUndefined()
  })
})
