// The hole thread spec's boundary checks: a well-formed spec loads, and a spec
// whose numbers contradict the thread table (or that is missing a piece) is
// refused by field. An unknown designation still loads: the thread is metadata
// and changes no geometry, so a doc naming a thread this build's table does not
// carry is a legal document.
import { describe, it, expect } from 'vitest'
import { loadPartDoc } from '@/persistence/docSchema'

function doc(thread: unknown): Record<string, unknown> {
  return {
    kind: 'part',
    features: [{
      id: 'h1',
      kind: 'hole',
      hole: { sketch: '@sk1', diameter: 5, depth_mode: 'blind', depth: 6, thread },
    }],
  }
}

const M6 = { designation: 'M6x1', nominal: 6, pitch: 1 }

describe('hole thread document validation', () => {
  it('accepts a table thread and keeps its payload', () => {
    const result = loadPartDoc(doc(M6))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const hole = (result.doc.features as Record<string, unknown>[])[0].hole as Record<string, unknown>
    expect(hole.thread).toEqual(M6)
  })

  it('accepts an unknown designation with its own numbers', () => {
    const result = loadPartDoc(doc({ designation: 'M7x1', nominal: 7, pitch: 1 }))
    expect(result.ok).toBe(true)
  })

  it('rejects a number the table contradicts', () => {
    const result = loadPartDoc(doc({ ...M6, nominal: 8 }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('features[0].hole.thread.nominal')
  })

  it('rejects a pitch the table contradicts', () => {
    const result = loadPartDoc(doc({ ...M6, pitch: 1.25 }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('features[0].hole.thread.pitch')
  })

  it('rejects a missing designation and a non-positive pitch', () => {
    const missing = loadPartDoc(doc({ nominal: 6, pitch: 1 }))
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error.field).toBe('features[0].hole.thread.designation')
    const zero = loadPartDoc(doc({ designation: 'M7x1', nominal: 7, pitch: 0 }))
    expect(zero.ok).toBe(false)
    if (!zero.ok) expect(zero.error.field).toBe('features[0].hole.thread.pitch')
  })

  it('rejects a non-record spec', () => {
    const result = loadPartDoc(doc('M6x1'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('features[0].hole.thread')
  })
})
