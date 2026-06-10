// @vitest-environment node
//
// Integration: solveSketch lowers a projected entity through the real Rust WASM
// solver. Guards the params-into-`initial` fix -- without it a projected entity
// solves to the origin instead of its projected location -- and the tilted
// circle -> ellipse kind promotion (full-brep-projection).
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { solveSketch, setSketchSolver, resetSketchSolver } from './sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import type { Repository } from '../query'
import type { Body } from '../types3d'

type Dict = Record<string, unknown>

const solveBytes = loadSolver()

/** Minimal repository stub: returns a fixed payload for any source query. */
function stubRepo(payload: Dict): Repository {
  return {
    query: () => payload,
    elements: new Map(),
  } as unknown as Repository
}

describe('solveSketch projection lowering', () => {
  beforeAll(() => {
    if (!solveBytes) return
  })
  beforeEach(() => {
    resetSketchSolver()
    if (solveBytes) setSketchSolver(solveBytes)
  })

  const onParallelCircle: Dict = {
    type: 'edge', kind: 'circle', center: [3, 4, 0], radius: 5, axis: [0, 0, 1], x_axis: [1, 0, 0],
  }

  it('projects a parallel circle to its 2D location (params reach the solver)', () => {
    if (!solveBytes) return  // solver wasm absent: skip
    const feature: Dict = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'c0', kind: 'circle', source: '?edge;circle' }],
      initial: {},
      constraints: [],
    }
    const out = solveSketch(feature, stubRepo(onParallelCircle), {} as Record<string, Body>)
    expect(out.status).not.toBe('error')
    const g = out.geometry?.c0
    expect(g).toBeDefined()
    expect(g![0]).toBeCloseTo(3)
    expect(g![1]).toBeCloseTo(4)
    expect(g![2]).toBeCloseTo(5)
  })

  it('promotes a tilted circle to a solved ellipse', () => {
    if (!solveBytes) return
    const phi = Math.PI / 3
    const tilted: Dict = {
      type: 'edge', kind: 'circle', center: [0, 0, 0], radius: 5,
      axis: [0, -Math.sin(phi), Math.cos(phi)], x_axis: [1, 0, 0],
    }
    const feature: Dict = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'e0', kind: 'circle', source: '?edge;circle' }],
      initial: {},
      constraints: [],
    }
    const out = solveSketch(feature, stubRepo(tilted), {} as Record<string, Body>)
    expect(out.status).not.toBe('error')
    const g = out.geometry?.e0
    expect(g).toBeDefined()
    // 5 params => the entity was lowered to an ellipse, not kept as a circle.
    expect(g!.length).toBe(5)
    expect(g![2]).toBeCloseTo(5)              // a = R
    expect(g![3]).toBeCloseTo(5 * Math.cos(phi))  // b = R cos(phi)
  })
})
