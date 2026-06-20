import { describe, it, expect } from 'vitest'
import { solveVariable, isValidVariableName } from './variable'

function variableFeature(label: string, expression: unknown): Record<string, unknown> {
  return { id: 'v1', kind: 'variable', label, variable: { expression } }
}

describe('isValidVariableName', () => {
  it('accepts valid identifiers', () => {
    for (const n of ['width', 'var1', '_private', '$special', 'rib_thickness']) {
      expect(isValidVariableName(n)).toBe(true)
    }
  })

  it('rejects spaces, leading digits, and punctuation', () => {
    for (const n of ['my var', '1st_var', 'my-var', 'var.name', '']) {
      expect(isValidVariableName(n)).toBe(false)
    }
  })

  it('rejects mathjs reserved constants', () => {
    for (const n of ['pi', 'e', 'i', 'Infinity', 'NaN', 'true', 'false', 'null']) {
      expect(isValidVariableName(n)).toBe(false)
    }
  })
})

describe('solveVariable', () => {
  it('evaluates a plain number expression', () => {
    expect(solveVariable(variableFeature('a', '42'))).toEqual({ status: 'ok', value: 42, expression: '42' })
  })

  it('evaluates a numeric-typed expression', () => {
    expect(solveVariable(variableFeature('a', 7))).toMatchObject({ status: 'ok', value: 7 })
  })

  it('evaluates arithmetic', () => {
    expect(solveVariable(variableFeature('a', '10+20'))).toMatchObject({ status: 'ok', value: 30 })
  })

  it('resolves variables from context', () => {
    expect(solveVariable(variableFeature('b', 'width*2'), { width: 5 })).toMatchObject({ status: 'ok', value: 10 })
  })

  it('passes through mathjs constants and negative results', () => {
    expect(solveVariable(variableFeature('a', 'pi*2')).value).toBeCloseTo(6.283185, 4)
    expect(solveVariable(variableFeature('a', '-5+3'))).toMatchObject({ status: 'ok', value: -2 })
  })

  it('errors on an invalid expression', () => {
    expect(solveVariable(variableFeature('a', '2+/'))).toMatchObject({ status: 'exception' })
  })

  it('errors on an undefined variable reference', () => {
    expect(solveVariable(variableFeature('a', 'x+1'))).toMatchObject({ status: 'exception' })
  })

  it('errors on an empty expression', () => {
    expect(solveVariable(variableFeature('a', ''))).toMatchObject({ status: 'exception' })
  })

  it('errors on an invalid variable name', () => {
    expect(solveVariable(variableFeature('my var', '1'))).toMatchObject({ status: 'exception' })
  })

  it('errors on a duplicate name already in context', () => {
    const r = solveVariable(variableFeature('width', '1'), { width: 100 })
    expect(r.status).toBe('exception')
    expect(String(r.exception)).toContain('Duplicate')
  })

  it('falls back to feature.id as the name when label is absent', () => {
    // No label -> the id is used as the variable name (label ?? id).
    expect(solveVariable({ id: 'depth', kind: 'variable', variable: { expression: '5' } })).toEqual({
      status: 'ok',
      value: 5,
      expression: '5',
    })
  })

  it('treats a feature with neither label nor id as an invalid (empty) name', () => {
    // label ?? id ?? '' -> '' -> fails the identifier check.
    const r = solveVariable({ kind: 'variable', variable: { expression: '5' } })
    expect(r.status).toBe('exception')
    expect(String(r.exception)).toContain('Invalid variable name')
  })
})
