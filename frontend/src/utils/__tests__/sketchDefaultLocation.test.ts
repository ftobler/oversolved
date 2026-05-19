/**
 * Tests for feature 278: no silent default location fallback on missing sketch plane.
 */
import { describe, it, expect } from 'vitest'
import { applyAddSketch } from '@/utils/yamlMutations/partStyle'
import { healDoc } from '@/hooks/usePartDoc'
import type { PartDoc } from '@/types/cad'

function emptyDoc(): PartDoc {
  return { version: 1, kind: 'part', features: [] }
}

describe('applyAddSketch sets default plane', () => {
  it('new sketch always has plane: @builtin_plane_front', () => {
    const doc = emptyDoc()
    applyAddSketch(doc, 'sk1')
    const sketch = doc.features!.find(f => f.id === 'sk1')!
    expect(sketch.plane).toBe('@builtin_plane_front')
  })

  it('preserves label when provided', () => {
    const doc = emptyDoc()
    applyAddSketch(doc, 'sk1', 'my sketch')
    const sketch = doc.features!.find(f => f.id === 'sk1')!
    expect(sketch.label).toBe('my sketch')
    expect(sketch.plane).toBe('@builtin_plane_front')
  })
})

describe('healDoc legacy sketch plane repair', () => {
  it('assigns @builtin_plane_front to sketch missing plane', () => {
    const doc = healDoc({ features: [{ id: 'sk1', kind: 'sketch' }] })
    const sketch = doc.features!.find(f => f.id === 'sk1')!
    expect(sketch.plane).toBe('@builtin_plane_front')
  })

  it('does not overwrite plane already set on legacy sketch', () => {
    const doc = healDoc({
      features: [{ id: 'sk1', kind: 'sketch', plane: '@builtin_plane_top' }],
    })
    const sketch = doc.features!.find(f => f.id === 'sk1')!
    expect(sketch.plane).toBe('@builtin_plane_top')
  })

  it('does not touch non-sketch features', () => {
    const doc = healDoc({
      features: [{ id: 'ext1', kind: 'extrude', profile: '@sk1' }],
    })
    const ext = doc.features!.find(f => f.id === 'ext1')!
    expect(ext.plane).toBeUndefined()
  })

  it('heals multiple sketches in one pass', () => {
    const doc = healDoc({
      features: [
        { id: 'sk1', kind: 'sketch' },
        { id: 'sk2', kind: 'sketch', plane: '@builtin_plane_right' },
        { id: 'sk3', kind: 'sketch' },
      ],
    })
    expect(doc.features!.find(f => f.id === 'sk1')!.plane).toBe('@builtin_plane_front')
    expect(doc.features!.find(f => f.id === 'sk2')!.plane).toBe('@builtin_plane_right')
    expect(doc.features!.find(f => f.id === 'sk3')!.plane).toBe('@builtin_plane_front')
  })
})
