import { describe, it, expect } from 'vitest'
import type { PartFeature } from '@/types/cad'
import { solveVariable, isValidVariableName, variableRenameProblem } from '../variable'

function variableFeature(label: string, expression: unknown): Record<string, unknown> {
  return { id: 'v1', kind: 'variable', label, variable: { expression } }
}

function renameFeatures(): PartFeature[] {
  return [
    { id: 'v1', kind: 'variable', label: 'width', variable: { expression: '1' } },
    { id: 'v2', kind: 'variable', label: 'height', variable: { expression: '2' } },
  ] as PartFeature[]
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

describe('variableRenameProblem', () => {
  it('accepts an identifier, including its own current name', () => {
    const features = renameFeatures()
    for (const name of ['width', '_w', 'w2', '$w']) {
      expect(variableRenameProblem(features, 'v1', name)).toBeNull()
    }
  })

  it('names the minus rule and suggests the sanitized name', () => {
    expect(variableRenameProblem(renameFeatures(), 'v1', 'my-var')).toBe(
      '"my-var" is not a valid variable name: use letters, digits and _ only '
        + '(a - reads as minus in an expression). Try "my_var".',
    )
  })

  it('names the leading-digit rule', () => {
    expect(variableRenameProblem(renameFeatures(), 'v1', '2x')).toBe(
      '"2x" is not a valid variable name: it must start with a letter or _.',
    )
  })

  it('refuses a space by the invalid-character rule', () => {
    expect(variableRenameProblem(renameFeatures(), 'v1', 'a b')).toContain('Try "a_b".')
  })

  it('refuses a mathjs constant by name', () => {
    expect(variableRenameProblem(renameFeatures(), 'v1', 'pi')).toBe(
      '"pi" is a built-in constant and cannot name a variable.',
    )
    expect(variableRenameProblem(renameFeatures(), 'v1', 'e')).toBe(
      '"e" is a built-in constant and cannot name a variable.',
    )
  })

  it('requires a name', () => {
    for (const name of ['', '   ']) {
      expect(variableRenameProblem(renameFeatures(), 'v1', name)).toBe('A variable needs a name.')
    }
  })

  it('refuses another variable\'s name, but not its own', () => {
    const features = renameFeatures()
    expect(variableRenameProblem(features, 'v1', 'height')).toBe(
      'A variable named "height" already exists.',
    )
    expect(variableRenameProblem(features, 'v1', 'width')).toBeNull()
  })

  it('uses no em or en dash, per the code style', () => {
    const features = renameFeatures()
    for (const name of ['my-var', '2x', 'a b', 'pi', '', 'height']) {
      const problem = variableRenameProblem(features, 'v1', name)
      expect(problem).not.toMatch(/[\u2013\u2014]/)
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
