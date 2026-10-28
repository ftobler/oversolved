// The sweep `multisection` opt-in at the document boundary: a plain boolean that
// is absent by default (so no migration rung) and refused when spelled any other
// way. It is what turns the "profile spans two different sketch planes" refusal
// into a section blend, so a typo that silently reads as false would be a body
// the user did not ask for.
import { describe, it, expect } from 'vitest'
import { loadPartDoc } from '@/persistence/docSchema'
import { FEATURE_SCHEMA_BY_KIND } from '@/persistence/partDocSchema'

function docWith(multisection: unknown): Record<string, unknown> {
  return {
    features: [{
      id: 's1',
      kind: 'sweep',
      sweep: { sketch: '@sk', path: '@p', multisection },
    }],
  }
}

describe('docSchema sweep.multisection', () => {
  it('accepts true and false', () => {
    for (const value of [true, false]) {
      expect(loadPartDoc(docWith(value)).ok).toBe(true)
    }
  })

  it('rejects a string, a number and a list', () => {
    for (const value of ['true', 1, []]) {
      const loaded = loadPartDoc(docWith(value))
      expect(loaded.ok).toBe(false)
      if (loaded.ok) continue
      expect(loaded.error.field).toBe('features[0].sweep.multisection')
    }
  })

  it('leaves the field absent when it was absent', () => {
    const doc = {
      features: [{ id: 's1', kind: 'sweep', sweep: { sketch: '@sk', path: '@p' } }],
    }
    const loaded = loadPartDoc(doc)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    const sub = (loaded.doc.features![0] as unknown as { sweep: Record<string, unknown> }).sweep
    expect('multisection' in sub).toBe(false)
  })

  it('declares a boolean in the published part schema', () => {
    const sweep = FEATURE_SCHEMA_BY_KIND.sweep as {
      properties: { sweep: { properties: Record<string, unknown> } }
    }
    expect(sweep.properties.sweep.properties.multisection).toEqual({ type: 'boolean' })
  })
})
