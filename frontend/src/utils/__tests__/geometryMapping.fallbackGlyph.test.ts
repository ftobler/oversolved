import { describe, it, expect } from 'vitest'
import { computeConstraintRender } from '@/utils/geometry/geometryMapping'
import type { Sketch, PartConstraint, SymbolRender } from '@/types/cad'

// Recovery: a constraint whose specific render shape can't be built (e.g. a
// hand-edited / legacy parallel between two circles) must still produce a
// selectable glyph so the user can delete it. Previously it returned `unknown`,
// which the canvas silently skips -- leaving the constraint stuck forever.

function makeSketch(): Sketch {
  return {
    C1: { center: [2, 3], radius: 1 },
    C2: { center: [8, 9], radius: 2 },
    L1: { start: [0, 0], end: [10, 0] },
  } as Sketch
}

describe('computeConstraintRender (fallback glyph)', () => {
  it('parallel between two circles → symbol_unknown anchored at the first circle', () => {
    const sketch = makeSketch()
    const c: PartConstraint = { id: 'P1', kind: 'parallel', a: '$C1', b: '$C2' }
    const r = computeConstraintRender(c, sketch) as SymbolRender
    expect(r.kind).toBe('symbol_unknown')
    expect(r.at).toEqual([2, 3])  // C1 center
    expect(r.entity).toBe('C1')
    expect(r.entities).toEqual(['C1', 'C2'])
  })

  it('falls back to the second operand when the first does not resolve', () => {
    const sketch = makeSketch()
    const c: PartConstraint = { id: 'P1', kind: 'parallel', a: '$GONE', b: '$C2' }
    const r = computeConstraintRender(c, sketch) as SymbolRender
    expect(r.kind).toBe('symbol_unknown')
    expect(r.at).toEqual([8, 9])  // C2 center
    expect(r.entity).toBe('C2')
  })

  it('stays unknown when no operand resolves (nowhere to anchor)', () => {
    const sketch = makeSketch()
    const c: PartConstraint = { id: 'P1', kind: 'parallel', a: '$GONE', b: '$ALSOGONE' }
    const r = computeConstraintRender(c, sketch)
    expect(r.kind).toBe('unknown')
  })

  it('does not disturb a renderable constraint', () => {
    const sketch = makeSketch()
    const c: PartConstraint = { id: 'P1', kind: 'parallel', a: '$L1', b: '$L1' }
    const r = computeConstraintRender(c, sketch) as SymbolRender
    expect(r.kind).toBe('symbol_parallel')
  })
})
