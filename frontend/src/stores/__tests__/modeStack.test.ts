import { describe, it, expect, beforeEach } from 'vitest'
import { ModeStack } from '@/stores/modeStack'

describe('ModeStack', () => {
  let stack: ModeStack

  beforeEach(() => {
    stack = new ModeStack()
  })

  it('starts empty', () => {
    expect(stack.isEmpty).toBe(true)
    expect(stack.depth).toBe(0)
    expect(stack.current).toBeNull()
  })

  it('push adds a mode entry', () => {
    stack.push('tool:select')
    expect(stack.isEmpty).toBe(false)
    expect(stack.depth).toBe(1)
    expect(stack.current?.kind).toBe('tool:select')
  })

  it('push returns the new depth', () => {
    expect(stack.push('tool:select')).toBe(1)
    expect(stack.push('tool:line')).toBe(2)
  })

  it('pop removes and returns the top entry', () => {
    stack.push('tool:select')
    stack.push('tool:line')
    const entry = stack.pop()
    expect(entry.kind).toBe('tool:line')
    expect(stack.depth).toBe(1)
    expect(stack.current?.kind).toBe('tool:select')
  })

  it('pop validates expected kind', () => {
    stack.push('tool:select')
    expect(() => stack.pop('tool:line')).toThrow('[modeStack]')
    // Still pops despite validation failure
    expect(stack.isEmpty).toBe(true)
  })

  it('pop on empty stack throws', () => {
    expect(() => stack.pop()).toThrow('[modeStack] pop() called on empty stack')
  })

  it('pop on empty stack with expected kind throws', () => {
    expect(() => stack.pop('tool:select')).toThrow('[modeStack] pop() called on empty stack')
  })

  it('reset clears all entries', () => {
    stack.push('tool:select')
    stack.push('tool:line')
    stack.reset()
    expect(stack.isEmpty).toBe(true)
    expect(stack.depth).toBe(0)
  })

  it('getAll returns all entries', () => {
    stack.push('a')
    stack.push('b')
    stack.push('c')
    const all = stack.getAll()
    expect(all.map(e => e.kind)).toEqual(['a', 'b', 'c'])
  })

  it('supports nested push/pop correctly', () => {
    stack.push('outer')
    stack.push('inner')
    expect(stack.depth).toBe(2)

    const inner = stack.pop()
    expect(inner.kind).toBe('inner')
    expect(stack.depth).toBe(1)

    const outer = stack.pop()
    expect(outer.kind).toBe('outer')
    expect(stack.isEmpty).toBe(true)
  })

  it('accepts pop without expected kind', () => {
    stack.push('anything')
    const entry = stack.pop()
    expect(entry.kind).toBe('anything')
  })
})
