import { describe, it, expect } from 'vitest'
import { evalExpr, evalFeatureParams } from '../evalExpr'

describe('evalExpr', () => {
  it('returns a plain number string via the fast path', () => {
    expect(evalExpr('42')).toBe(42)
    expect(evalExpr('  42  ')).toBe(42)
  })

  it('evaluates simple arithmetic', () => {
    expect(evalExpr('2+2')).toBe(4)
  })

  it('resolves variables from context', () => {
    expect(evalExpr('width+10', { width: 5 })).toBe(15)
  })

  it('evaluates nested functions', () => {
    expect(evalExpr('sqrt(16)*3')).toBe(12)
  })

  it('knows mathjs constants', () => {
    expect(evalExpr('pi*2')).toBeCloseTo(6.283185, 4)
  })

  it('returns NaN for an empty string', () => {
    expect(evalExpr('')).toBeNaN()
    expect(evalExpr('   ')).toBeNaN()
  })

  it('returns NaN for invalid syntax', () => {
    expect(evalExpr('2+/')).toBeNaN()
  })

  it('rejects division by zero (Infinity)', () => {
    expect(evalExpr('1/0')).toBeNaN()
  })

  it('returns NaN for an unknown variable', () => {
    expect(evalExpr('x+1', {})).toBeNaN()
  })

  it('rejects non-numeric results (matrix)', () => {
    expect(evalExpr('[1,2]')).toBeNaN()
  })

  it('returns NaN for a non-numeric string', () => {
    expect(evalExpr('hello')).toBeNaN()
  })

  it('handles negative numbers', () => {
    expect(evalExpr('-5+3')).toBe(-2)
    expect(evalExpr('-5')).toBe(-5)
  })

  it('handles decimals', () => {
    expect(evalExpr('2.5*4')).toBe(10)
    expect(evalExpr('2.5')).toBe(2.5)
  })
})

describe('evalFeatureParams', () => {
  it('evaluates a string field', () => {
    const sub: Record<string, unknown> = { distance: '10+5' }
    evalFeatureParams(sub, ['distance'])
    expect(sub.distance).toBe(15)
  })

  it('leaves a number field unchanged', () => {
    const sub: Record<string, unknown> = { distance: 15 }
    evalFeatureParams(sub, ['distance'])
    expect(sub.distance).toBe(15)
  })

  it('resolves against context', () => {
    const sub: Record<string, unknown> = { distance: 'width*2' }
    evalFeatureParams(sub, ['distance'], { width: 6 })
    expect(sub.distance).toBe(12)
  })

  it('sets a <key>_error and keeps the string on failure', () => {
    const sub: Record<string, unknown> = { distance: '2+/' }
    evalFeatureParams(sub, ['distance'])
    expect(sub.distance).toBe('2+/')
    expect(sub.distance_error).toBe('Cannot evaluate "2+/"')
  })

  it('handles mixed string and number fields', () => {
    const sub: Record<string, unknown> = { count_x: '2+1', count_y: 4 }
    evalFeatureParams(sub, ['count_x', 'count_y'])
    expect(sub.count_x).toBe(3)
    expect(sub.count_y).toBe(4)
  })

  it('ignores absent fields', () => {
    const sub: Record<string, unknown> = {}
    evalFeatureParams(sub, ['distance'])
    expect(sub.distance).toBeUndefined()
  })
})
