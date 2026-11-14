// @vitest-environment node
//
// The freeze contract at the solver boundary: a frozen projection is exactly a
// whole-entity `fixed` row over the baked position. One row must take every
// param of every kind to zero DOF without a redundant row, or a frozen circle
// or arc would read overconstrained. The geometry must come back at the 1e-6
// document grid, since the freeze does not move anything.
import { describe, it, expect, beforeEach } from 'vitest'
import { solveSketch, setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import type { Repository } from '../../query'
import type { Body } from '../../types3d'

type Dict = Record<string, unknown>

const solveBytes = loadSolver()

const deadRepo = (): Repository => ({ query: () => null, elements: new Map() }) as unknown as Repository

interface Case {
  kind: string
  params: number[]
  handles?: 'start' | 'end' | 'both'
}

const CASES: Case[] = [
  { kind: 'point', params: [1, 2] },
  { kind: 'line', params: [0, 0, 10, 0] },
  { kind: 'circle', params: [2, 3, 5] },
  { kind: 'arc', params: [0, 0, 5, 10, 100] },
  { kind: 'ellipse', params: [0, 0, 8, 4, 15] },
  { kind: 'spline', params: [0, 0, 2, 0, 4, 2, 6, 0] },
  { kind: 'fit_spline', params: [0, 0, 2, 1, 4, 2, 6, 1], handles: 'both' },
]

function paramsFor(c: Case): number[] {
  if (c.handles === undefined) return [...c.params]
  const count = c.handles === 'both' ? 4 : 2
  return [...c.params, ...Array.from({ length: count }, () => 0)]
}

describe('a frozen projection solves fully constrained for every kind', () => {
  beforeEach(() => {
    resetSketchSolver()
    if (solveBytes) setSketchSolver(solveBytes)
  })

  for (const c of CASES) {
    it(`freezes a ${c.kind} at dof 0 with the geometry unchanged`, () => {
      if (!solveBytes) return
      const initial = paramsFor(c)
      const feature: Dict = {
        id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
        entities: [{ id: 'e1', kind: c.kind, ...(c.handles ? { handles: c.handles } : {}) }],
        initial: { e1: initial },
        constraints: [{ id: `c_fixed_${c.kind}`, kind: 'fixed', target: '$e1' }],
      }
      const out = solveSketch(feature, deadRepo(), {} as Record<string, Body>)
      expect(out.status).toBe('fully_constrained')
      expect(out.dof).toBe(0)
      expect(out.solver_warning).toBeUndefined()
      const solved = out.geometry?.e1
      expect(solved).toBeDefined()
      expect(solved).toHaveLength(initial.length)
      for (let i = 0; i < initial.length; i++) {
        expect(solved![i]).toBeCloseTo(initial[i], 6)
      }
    })
  }

  it('keeps a frozen geometry still when its former source is gone', () => {
    if (!solveBytes) return
    // The source resolves once, its position is baked, then the freeze removes
    // the link. The next solve cannot query the source at all and must not move
    // the fixed line.
    const projected: Dict = {
      type: 'edge', kind: 'line', start: [1, 2, 0], end: [9, 2, 0],
    }
    const repo = { query: () => projected, elements: new Map() } as unknown as Repository
    const held: Dict = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'e1', kind: 'line' }],
      initial: {},
      constraints: [{ id: 'proj_e1', kind: 'projection', target: '$e1', source: '?edge;line' }],
    }
    const first = solveSketch(held, repo, {} as Record<string, Body>)
    const baked = [...(first.geometry?.e1 ?? [])]
    expect(baked).toHaveLength(4)

    const frozen: Dict = {
      ...held,
      initial: { e1: baked },
      constraints: [
        ...(held.constraints as Dict[]).filter(c => c.kind !== 'projection'),
        { id: 'c_fixed_e1', kind: 'fixed', target: '$e1' },
      ],
    }
    const second = solveSketch(frozen, deadRepo(), {} as Record<string, Body>)
    expect(second.status).toBe('fully_constrained')
    expect(second.dof).toBe(0)
    expect(second.solver_warning).toBeUndefined()
    for (let i = 0; i < baked.length; i++) expect(second.geometry!.e1[i]).toBeCloseTo(baked[i], 6)
  })
})
