import { describe, it, expect } from 'vitest'
import type { Mutation } from '@/types/cad'

interface TooltipEntry {
  mutation: Mutation
}

function tooltipItems(stack: TooltipEntry[], maxItems: number): string[] {
  return stack.slice(-maxItems).reverse().map(e => e.mutation.type)
}

describe('undo/redo tooltip item selection', () => {
  it('shows up to 5 most recent actions', () => {
    const stack: TooltipEntry[] = []
    for (let i = 1; i <= 10; i++) {
      stack.push({ mutation: { type: `action_${i}` } as unknown as Mutation })
    }
    const items = tooltipItems(stack, 5)
    expect(items).toHaveLength(5)
    expect(items[0]).toBe('action_10')
    expect(items[4]).toBe('action_6')
  })

  it('shows all when stack has fewer than 5', () => {
    const stack: TooltipEntry[] = [
      { mutation: { type: 'add_sketch' } as Mutation },
      { mutation: { type: 'add_extrude' } as Mutation },
    ]
    const items = tooltipItems(stack, 5)
    expect(items).toHaveLength(2)
    expect(items[0]).toBe('add_extrude')
    expect(items[1]).toBe('add_sketch')
  })

  it('returns empty when stack is empty', () => {
    const stack: TooltipEntry[] = []
    const items = tooltipItems(stack, 5)
    expect(items).toHaveLength(0)
  })

  it('reverses order so most recent appears first', () => {
    const stack: TooltipEntry[] = [
      { mutation: { type: 'first' } as unknown as Mutation },
      { mutation: { type: 'second' } as unknown as Mutation },
      { mutation: { type: 'third' } as unknown as Mutation },
    ]
    const items = tooltipItems(stack, 5)
    expect(items).toEqual(['third', 'second', 'first'])
  })
})
