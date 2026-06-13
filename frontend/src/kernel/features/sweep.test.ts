// Always-on tests for the sweep leaf's OCC-free logic (phase 2f): the path-chain
// ordering, path-ref resolution, and solveSweep guard paths. The geometry-
// producing path is gated in occ/sweepReal.test.ts.

import { describe, it, expect } from 'vitest'
import { Repository } from '../query'
import { solveSweep, orderEdgesIntoChain, pathRefToSketchId, profileRefToSketchRef } from './sweep'
import type { HandleTable } from '../occ/handleTable'
import type { OccModule } from '../occ/occTypes'
import type { Body } from '../types3d'

const oc = null as unknown as OccModule
const scope = null as never
const table = null as unknown as HandleTable

type Edge = Record<string, unknown>

describe('orderEdgesIntoChain', () => {
  it('orders a shuffled chain so consecutive edges connect', () => {
    const edges: Edge[] = [
      { id: 'b', start: [1, 0], end: [2, 0] },
      { id: 'c', start: [2, 0], end: [3, 0] },
      { id: 'a', start: [0, 0], end: [1, 0] },
    ]
    const ordered = orderEdgesIntoChain(edges)
    // Direction is not fixed (either degree-1 end may start the walk), so assert
    // the sequence is a valid connected chain a-b-c (forward or reversed).
    const ids = ordered.map((e) => e.id).join('')
    expect(['abc', 'cba']).toContain(ids)
  })

  it('returns a single edge unchanged', () => {
    const edges: Edge[] = [{ id: 'only', start: [0, 0], end: [1, 1] }]
    expect(orderEdgesIntoChain(edges)).toEqual(edges)
  })

  it('throws when edges do not form a connected chain', () => {
    const edges: Edge[] = [
      { id: 'a', start: [0, 0], end: [1, 0] },
      { id: 'b', start: [5, 5], end: [6, 5] },
    ]
    expect(() => orderEdgesIntoChain(edges)).toThrow(/connected chain/)
  })
})

describe('pathRefToSketchId', () => {
  it('reads the sketch id from an @feat/entity ref', () => {
    expect(pathRefToSketchId('@sk7/e3', new Repository())).toBe('sk7')
  })

  it('strips $ from a plain sketch ref', () => {
    expect(pathRefToSketchId('$sk9', new Repository())).toBe('sk9')
  })

  it('resolves a ?ancestry ref to the first sketch with topology', () => {
    const repo = new Repository()
    repo.register('_topo_skA', { edges: [] })
    expect(pathRefToSketchId('?4;@skA', repo)).toBe('skA')
  })

  it('throws when a ?ancestry ref names no known sketch', () => {
    expect(() => pathRefToSketchId('?5;@nope', new Repository())).toThrow(/could not resolve path sketch/)
  })
})

describe('profileRefToSketchRef', () => {
  it('collapses an entity selection ID to its parent sketch id', () => {
    expect(profileRefToSketchRef('entity:bOhvSew-4vrj:SN7Aax6PfaDQoVdM')).toBe('bOhvSew-4vrj')
  })

  it('collapses a vertex selection ID to its parent sketch id', () => {
    expect(profileRefToSketchRef('vertex:sk1:e2:start')).toBe('sk1')
  })

  it('passes plain $/@/? refs through unchanged', () => {
    expect(profileRefToSketchRef('$sk1')).toBe('$sk1')
    expect(profileRefToSketchRef('@sk1/e2')).toBe('@sk1/e2')
    expect(profileRefToSketchRef('?3;@sk1')).toBe('?3;@sk1')
  })
})

describe('solveSweep guard paths', () => {
  it('requires at least one profile reference', () => {
    expect(() =>
      solveSweep(oc, scope, table, { id: 'f1', sweep: { path: '$p' } }, new Repository(), {}),
    ).toThrow(/at least one profile reference/)
  })

  it('requires a path reference', () => {
    expect(() =>
      solveSweep(oc, scope, table, { id: 'f1', sweep: { sketch: '$sk' } }, new Repository(), {}),
    ).toThrow(/requires a path reference/)
  })

  it('surfaces an unresolved profile ref as the collected error', () => {
    const bodyStore: Record<string, Body> = {}
    expect(() =>
      solveSweep(
        oc,
        scope,
        table,
        { id: 'f1', sweep: { sketch: '$missing', path: '$p' } },
        new Repository(),
        bodyStore,
      ),
    ).toThrow(/sketch not found: missing/)
  })

  it('resolves entity-selection profile refs to their parent sketch (bug: sweep_20260613)', () => {
    // The profile was picked edge-by-edge, persisting `entity:<sketchId>:<eid>`
    // selection IDs. These must collapse to the parent sketch, not surface the
    // cryptic "sketch not found: entity:..." that the bug report hit.
    const sketchId = 'bOhvSew-4vrj_rLeRX0-ZR78'
    let msg = ''
    try {
      solveSweep(
        oc,
        scope,
        table,
        {
          id: 'sw',
          sweep: {
            path: '$p',
            sketch: [`entity:${sketchId}:SN7Aax6PfaDQoVdM`, `entity:${sketchId}:6a0ityCkkAXICmG2`],
          },
        },
        new Repository(),
        {},
      )
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toContain(`sketch not found: ${sketchId}`)
    expect(msg).not.toContain('entity:')
  })
})
