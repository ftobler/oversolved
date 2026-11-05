// The transform's optional Euler triple at the document boundary. It is a
// numbers-only VEC3, unlike rotation_angle, and a malformed triple must be
// refused by field rather than reaching the kernel as a partial array.
import { describe, it, expect } from 'vitest'
import { loadPartDoc } from '@/persistence/docSchema'
import type { TransformFeatureDef } from '@/types/cad'

function doc(transform: unknown): Record<string, unknown> {
  return { kind: 'part', features: [{ id: 'tr1', kind: 'transform', transform }] }
}

function loadedTransform(payload: unknown): Record<string, unknown> | null {
  const result = loadPartDoc(doc(payload))
  if (!result.ok) return null
  const feature = (result.doc.features as Record<string, unknown>[])[0]
  return feature.transform as Record<string, unknown>
}

describe('transform.rotation_euler document validation', () => {
  it('accepts a well-formed triple and round-trips it unchanged', () => {
    const payload = { bodies: ['@b1'], rotation_euler: [10, 20, 300] }
    expect(loadedTransform(payload)).toEqual(payload)
  })

  it('refuses a two-component triple, naming the field', () => {
    const result = loadPartDoc(doc({ bodies: ['@b1'], rotation_euler: [10, 20] }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('features[0].transform.rotation_euler')
    expect(result.error.message).toContain('3 components')
  })

  it('refuses a string component, naming the field', () => {
    const result = loadPartDoc(doc({ bodies: ['@b1'], rotation_euler: [10, '20', 300] }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('features[0].transform.rotation_euler[1]')
    expect(result.error.message).toContain('number')
  })

  it('types rotation_euler as a three-number tuple on TransformFeatureDef', () => {
    const def: TransformFeatureDef = { bodies: ['@b1'], rotation_euler: [10, 20, 300] }
    expect(def.rotation_euler).toEqual([10, 20, 300])
  })
})
