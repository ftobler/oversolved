import { describe, it, expect } from 'vitest'
import { computeConstraintRender } from '@/utils/geometry/geometryMapping'
import { constraintTileLabel } from '@/registry/constraintRegistry'
import type { Sketch, PartConstraint, SymbolRender } from '@/types/cad'

// The center rectangle authors its centre as a two-point midpoint (`point`
// midway between `point_a` and `point_b`, the diagonal corners). The midpoint
// renderer only knew the line form, so this one fell to the generic
// `symbol_unknown` glyph and read as a stray constraint nobody asked for
// (bugreports/20261107_1255_center_rectangle.md).

function rectSketch(): Sketch {
  return {
    A: { start: [-2, -1], end: [2, -1] },
    C: { start: [2, 1], end: [-2, 1] },
    P: { x: 0, y: 0 },
  } as Sketch
}

describe('two-point midpoint render', () => {
  it('renders a midpoint glyph at the middle of the two points', () => {
    const c: PartConstraint = {
      id: 'M1', kind: 'midpoint', point_a: '$Astart', point_b: '$Cstart', point: '$Pxy',
    }
    const r = computeConstraintRender(c, rectSketch()) as SymbolRender
    expect(r.kind).toBe('symbol_midpoint')
    expect(r.at).toEqual([0, 0])
    expect(r.entity).toBe('P')
    expect(r.entities).toEqual(['P', 'A', 'C'])
  })

  it('still renders the line form on the line midpoint', () => {
    const c: PartConstraint = { id: 'M2', kind: 'midpoint', line: '$A', point: '$Pxy' }
    const r = computeConstraintRender(c, rectSketch()) as SymbolRender
    expect(r.kind).toBe('symbol_midpoint')
    expect(r.at).toEqual([0, -1])
  })
})

describe('constraintTileLabel', () => {
  it('names the constraint behind a symbol tile', () => {
    expect(constraintTileLabel('symbol_midpoint')).toBe('Midpoint')
    expect(constraintTileLabel('symbol_h')).toBe('Horizontal')
  })

  it('appends the solve verdict, conflict before redundancy', () => {
    expect(constraintTileLabel('symbol_midpoint', { superfluous: true })).toBe('Midpoint (redundant)')
    expect(constraintTileLabel('symbol_equal', { culprit: true, superfluous: true })).toBe('Equal (conflicting)')
  })

  it('names the sugar and fallback glyphs that have no registry entry', () => {
    expect(constraintTileLabel('symbol_ngon')).toBe('Regular polygon')
    expect(constraintTileLabel('symbol_unknown')).toBe('Unrenderable constraint')
  })
})
