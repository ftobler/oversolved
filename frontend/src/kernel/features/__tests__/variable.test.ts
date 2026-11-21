import { describe, it, expect } from 'vitest'
import { solveVariable, isValidVariableName, variableScopeAt, laterVariablesAt } from '../variable'
import type { PartFeature } from '@/types/cad'

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

  it('accepts a stored number and an old stored string alike', () => {
    // Old documents store the text field's "5"; the number field stores 5.
    expect(solveVariable(variableFeature('a', '5'))).toMatchObject({ status: 'ok', value: 5 })
    expect(solveVariable(variableFeature('a', 5))).toMatchObject({ status: 'ok', value: 5 })
  })
})

describe('variableScopeAt', () => {
  const feature = (id: string, over: Record<string, unknown> = {}): PartFeature =>
    ({ id, kind: 'variable', label: id, variable: { expression: 0 }, ...over }) as unknown as PartFeature
  const extrude = { id: 'ex1', kind: 'extrude', extrude: { sketch: [], distance: 5, direction: 'normal' } } as unknown as PartFeature
  const fillet = { id: 'fi1', kind: 'fillet', fillet: { edges: [], radius: 1 } } as unknown as PartFeature

  it('folds every unsuppressed variable before the index, in order', () => {
    const w = feature('w', { variable: { expression: 10 } })
    const h = feature('h', { variable: { expression: 'w*2' } })
    const features = [w, extrude, h, fillet]

    expect(variableScopeAt(features, 0)).toEqual({})
    expect(variableScopeAt(features, 1)).toEqual({ w: 10 })
    expect(variableScopeAt(features, 2)).toEqual({ w: 10 })
    expect(variableScopeAt(features, 3)).toEqual({ w: 10, h: 20 })
    // The insertion index past the end is the same as the end of the log.
    expect(variableScopeAt(features, 4)).toEqual({ w: 10, h: 20 })
    expect(variableScopeAt(features, 99)).toEqual({ w: 10, h: 20 })
  })

  it('leaves a suppressed variable out, as the build loop does', () => {
    const w = feature('w', { variable: { expression: 10 }, suppressed: true })
    expect(variableScopeAt([w, extrude], 2)).toEqual({})
  })

  it('adds nothing for a variable that fails to evaluate', () => {
    const bad = feature('bad', { variable: { expression: '2+/' } })
    const after = feature('after', { variable: { expression: 'bad+1' } })
    expect(variableScopeAt([bad, after, extrude], 3)).toEqual({})
  })

  it('resolves each variable against the ones before it, never a later one', () => {
    const a = feature('a', { variable: { expression: 'b+1' } })
    const b = feature('b', { variable: { expression: 10 } })
    expect(variableScopeAt([a, b, extrude], 2)).toEqual({ b: 10 })
  })

  it('keeps the first of a duplicate name, since the second one fails', () => {
    const first = feature('w', { variable: { expression: 10 } })
    const second = feature('w', { id: 'w2', variable: { expression: 20 } })
    expect(variableScopeAt([first, second, extrude], 3)).toEqual({ w: 10 })
  })
})

describe('laterVariablesAt', () => {
  const variable = (id: string): PartFeature =>
    ({ id, kind: 'variable', label: id, variable: { expression: 1 } }) as unknown as PartFeature
  const extrude = { id: 'ex1', kind: 'extrude', extrude: { sketch: [], distance: 5, direction: 'normal' } } as unknown as PartFeature

  it('names each variable after the index, with its log position', () => {
    expect(laterVariablesAt([extrude, variable('depth'), extrude], 0)).toEqual({ depth: 1 })
    expect(laterVariablesAt([extrude, variable('depth')], 1)).toEqual({})
  })

  it('skips a name already in scope, which is an earlier definition', () => {
    expect(laterVariablesAt([extrude, variable('width')], 0, { width: 10 })).toEqual({})
  })
})
