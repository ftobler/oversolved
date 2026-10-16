// The boolean `clearance` field at the document boundary: a signed NumberOrExpr
// that is optional (absent means 0, so no migration rung) and accepts an
// expression string the solve pipeline evaluates later.
import { describe, it, expect } from 'vitest'
import { loadPartDoc } from '@/persistence/docSchema'

function docWith(clearance: unknown): Record<string, unknown> {
  return {
    features: [{
      id: 'b1',
      kind: 'boolean',
      boolean: { operation: 'subtract', target: '@t', tools: ['@u'], clearance },
    }],
  }
}

describe('docSchema boolean.clearance', () => {
  it('accepts a positive and a negative number', () => {
    for (const value of [0.1, -0.05]) {
      const loaded = loadPartDoc(docWith(value))
      expect(loaded.ok).toBe(true)
    }
  })

  it('accepts an expression string', () => {
    for (const value of ['tol', 'tol*2']) {
      const loaded = loadPartDoc(docWith(value))
      expect(loaded.ok).toBe(true)
    }
  })

  it('rejects a boolean, a list and a mapping', () => {
    for (const value of [true, [], {}]) {
      const loaded = loadPartDoc(docWith(value))
      expect(loaded.ok).toBe(false)
      if (loaded.ok) continue
      expect(loaded.error.field).toBe('features[0].boolean.clearance')
    }
  })

  it('loads a doc without clearance unchanged (absent, not 0)', () => {
    const doc = {
      features: [{
        id: 'b1',
        kind: 'boolean',
        boolean: { operation: 'subtract', target: '@t', tools: ['@u'] },
      }],
    }
    const loaded = loadPartDoc(doc)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    const sub = (loaded.doc.features![0] as unknown as { boolean: Record<string, unknown> }).boolean
    expect('clearance' in sub).toBe(false)
  })
})
