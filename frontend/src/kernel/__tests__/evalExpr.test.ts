import { describe, it, expect } from 'vitest'
import { evalExpr, evalFeatureParams, laterVariableRef, EXPR_FIELDS_BY_KIND } from '../evalExpr'

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

  it('lists and evaluates the shell thickness expression', () => {
    expect(EXPR_FIELDS_BY_KIND.shell).toEqual(['thickness'])
    const sub: Record<string, unknown> = { thickness: 'wall' }
    evalFeatureParams(sub, EXPR_FIELDS_BY_KIND.shell, { wall: 2.5 })
    expect(sub.thickness).toBe(2.5)
  })

  it('lists and evaluates the move-face distance expression to a signed number', () => {
    expect(EXPR_FIELDS_BY_KIND.move_face).toEqual(['distance'])
    const sub: Record<string, unknown> = { distance: '2*h' }
    evalFeatureParams(sub, EXPR_FIELDS_BY_KIND.move_face, { h: -3 })
    expect(sub.distance).toBe(-6)
  })

  it('reports a variable defined later by name and log index', () => {
    const sub: Record<string, unknown> = { distance: 'width*2' }
    evalFeatureParams(sub, ['distance'], {}, { width: 7 })
    expect(sub.distance).toBe('width*2')
    expect(sub.distance_error).toBe(
      "distance: variable 'width' is defined after this feature (at index 7); "
      + 'move it up with reorder_features',
    )
  })
})

describe('laterVariableRef', () => {
  it('finds a real identifier and its index', () => {
    expect(laterVariableRef('width*2 + height', { width: 3, height: 4 }))
      .toEqual({ name: 'width', index: 3 })
  })

  it('does not read a function name or a string literal as a variable', () => {
    expect(laterVariableRef('sqrt(width)', { sqrt: 1, width: 3 })).toEqual({ name: 'width', index: 3 })
    expect(laterVariableRef('"width"', { width: 3 })).toBeNull()
  })

  it('returns null when no later variable is named or the expression does not parse', () => {
    expect(laterVariableRef('2+2', { width: 3 })).toBeNull()
    expect(laterVariableRef('2+/', { width: 3 })).toBeNull()
  })
})

describe('boolean clearance expression', () => {
  it('is an expression-capable field of the boolean kind', () => {
    expect(EXPR_FIELDS_BY_KIND.boolean).toContain('clearance')
  })

  it('evaluates a boolean sub clearance against a variable context', () => {
    const sub: Record<string, unknown> = { operation: 'subtract', clearance: 'tol' }
    evalFeatureParams(sub, EXPR_FIELDS_BY_KIND.boolean, { tol: 0.2 })
    expect(sub.clearance).toBe(0.2)
  })

  it('writes clearance_error on a bad expression and keeps the string', () => {
    const sub: Record<string, unknown> = { operation: 'subtract', clearance: '2+/' }
    evalFeatureParams(sub, EXPR_FIELDS_BY_KIND.boolean)
    expect(sub.clearance).toBe('2+/')
    expect(sub.clearance_error).toBe('Cannot evaluate "2+/"')
  })
})
