import { describe, it, expect } from 'vitest'
import { PLAIN_NUMBER, stepPlainNumber } from './wheelStep'

describe('PLAIN_NUMBER', () => {
  it('matches a signed integer or decimal', () => {
    expect(PLAIN_NUMBER.test('10')).toBe(true)
    expect(PLAIN_NUMBER.test('-3')).toBe(true)
    expect(PLAIN_NUMBER.test('2.5')).toBe(true)
  })
})

describe('stepPlainNumber', () => {
  it('steps an integer up by exactly one', () => {
    expect(stepPlainNumber('10', 1)).toBe(11)
  })

  it('steps an integer down by exactly one', () => {
    expect(stepPlainNumber('10', -1)).toBe(9)
  })

  it('steps by one regardless of magnitude', () => {
    expect(stepPlainNumber('1000000', 1)).toBe(1000001)
    expect(stepPlainNumber('1', 1)).toBe(2)
  })

  it('steps a decimal by one, keeping its fraction', () => {
    expect(stepPlainNumber('2.5', 1)).toBe(3.5)
    expect(stepPlainNumber('2.5', -1)).toBe(1.5)
  })

  it('steps a negative through zero', () => {
    expect(stepPlainNumber('-1', 1)).toBe(0)
    expect(stepPlainNumber('0', -1)).toBe(-1)
  })

  it('refuses an empty or blank box', () => {
    expect(stepPlainNumber('', 1)).toBeNull()
    expect(stepPlainNumber('   ', 1)).toBeNull()
  })

  it('refuses an expression', () => {
    expect(stepPlainNumber('width*2', 1)).toBeNull()
    expect(stepPlainNumber('50+25', 1)).toBeNull()
  })

  it('refuses a half-typed number', () => {
    expect(stepPlainNumber('1.', 1)).toBeNull()
    expect(stepPlainNumber('.5', 1)).toBeNull()
    expect(stepPlainNumber('-', 1)).toBeNull()
  })
})
