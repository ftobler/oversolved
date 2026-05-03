import { describe, it, expect } from 'vitest'

function toggleBodyVisibility(prev: Record<string, boolean>, bodyId: string): Record<string, boolean> {
  const current = prev[bodyId]
  if (current === undefined) {
    return { ...prev, [bodyId]: false }
  }
  if (current === false) {
    return { ...prev, [bodyId]: true }
  }
  const next = { ...prev }
  delete next[bodyId]
  return next
}

describe('toggleBodyVisibility three-state logic', () => {
  it('toggles from follow-feature to hidden', () => {
    expect(toggleBodyVisibility({}, 'b1')).toEqual({ b1: false })
  })

  it('toggles from hidden to explicit show', () => {
    expect(toggleBodyVisibility({ b1: false }, 'b1')).toEqual({ b1: true })
  })

  it('toggles from explicit show to follow-feature', () => {
    expect(toggleBodyVisibility({ b1: true }, 'b1')).toEqual({})
  })

  it('leaves other body entries unchanged', () => {
    const prev = { b1: false, b2: true, b3: false }
    expect(toggleBodyVisibility(prev, 'b1')).toEqual({ b1: true, b2: true, b3: false })
    expect(toggleBodyVisibility({ b1: false, b2: true }, 'b2')).toEqual({ b1: false })
  })
})
