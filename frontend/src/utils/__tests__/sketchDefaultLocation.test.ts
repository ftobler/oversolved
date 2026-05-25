/**
 * Tests for feature 278: no silent default location fallback on missing sketch plane.
 */
import { describe, it, expect } from 'vitest'
import { applyAddSketch } from '@/utils/yamlMutations/partStyle'
import type { PartDoc } from '@/types/cad'

function emptyDoc(): PartDoc {
  return { version: 1, kind: 'part', features: [] }
}

describe('applyAddSketch sets no default plane', () => {
  it('new sketch has no plane — user must pick one', () => {
    const doc = emptyDoc()
    applyAddSketch(doc, 'sk1')
    const sketch = doc.features!.find(f => f.id === 'sk1')!
    expect(sketch.plane).toBeUndefined()
  })

  it('preserves label when provided', () => {
    const doc = emptyDoc()
    applyAddSketch(doc, 'sk1', 'my sketch')
    const sketch = doc.features!.find(f => f.id === 'sk1')!
    expect(sketch.label).toBe('my sketch')
    expect(sketch.plane).toBeUndefined()
  })
})
