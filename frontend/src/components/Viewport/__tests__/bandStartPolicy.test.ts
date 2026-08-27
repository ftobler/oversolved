import { describe, it, expect } from 'vitest'
import { shouldOpenRubberBand } from '@/components/Viewport/bandStartPolicy'

describe('shouldOpenRubberBand', () => {
  it('opens for idle select on empty space', () => {
    expect(shouldOpenRubberBand({ activeTool: null, dimensionPickCount: 0, hasHover: false })).toBe(true)
  })

  it('opens for the drag tool on empty space', () => {
    expect(shouldOpenRubberBand({ activeTool: 'drag', dimensionPickCount: 0, hasHover: false })).toBe(true)
  })

  it('opens for the dimension tool before any pick is taken', () => {
    expect(shouldOpenRubberBand({ activeTool: 'dimension', dimensionPickCount: 0, hasHover: false })).toBe(true)
  })

  it('does not open once a dimension pick is pending', () => {
    expect(shouldOpenRubberBand({ activeTool: 'dimension', dimensionPickCount: 1, hasHover: false })).toBe(false)
  })

  it('does not open with two dimension picks pending', () => {
    expect(shouldOpenRubberBand({ activeTool: 'dimension', dimensionPickCount: 2, hasHover: false })).toBe(false)
  })

  it('does not open while a hover is live, whatever the tool', () => {
    for (const tool of [null, 'drag', 'dimension'] as const) {
      expect(shouldOpenRubberBand({ activeTool: tool, dimensionPickCount: 0, hasHover: true })).toBe(false)
    }
  })

  it('does not open for a drawing tool', () => {
    for (const tool of ['line', 'circle', 'arc', 'rect', 'project', 'spline', 'point'] as const) {
      expect(shouldOpenRubberBand({ activeTool: tool, dimensionPickCount: 0, hasHover: false })).toBe(false)
    }
  })
})
