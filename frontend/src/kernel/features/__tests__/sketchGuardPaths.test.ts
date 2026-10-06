// Always-on guard tests for the sketch leaf's non-geometry paths: solver
// initialisation with a broken topology loader, the pre-decode lowering
// refusals, and the drag path's fail-soft null returns. The actual solves are
// gated in sketchDrag.test.ts / sketchSolverWireContract.test.ts; here a fake
// solver is injected so none of this needs the WASM solver.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/wasm-kernel/solverWasm', () => ({
  loadSolverWasm: vi.fn(),
  loadTopologyWasm: vi.fn(),
}))

import {
  solveSketch,
  initSketchSolver,
  resetSketchSolver,
  setSketchSolver,
  prepareDragContext,
  solveSketchDrag,
} from '../sketch'
import * as solverWasm from '@/wasm-kernel/solverWasm'
import { Repository } from '../../query'
import type { PartFeature } from '@/types/cad'

beforeEach(() => {
  resetSketchSolver()
  vi.mocked(solverWasm.loadSolverWasm).mockReset()
  vi.mocked(solverWasm.loadTopologyWasm).mockReset()
})

afterEach(() => {
  resetSketchSolver()
})

describe('initSketchSolver', () => {
  it('survives a topology loader that throws instead of failing solver init', async () => {
    vi.mocked(solverWasm.loadSolverWasm).mockResolvedValue(null)
    vi.mocked(solverWasm.loadTopologyWasm).mockImplementation(() => {
      throw new Error('topology wasm missing')
    })
    await expect(initSketchSolver()).resolves.toBeNull()
  })
})

describe('solveSketch lowering refusals', () => {
  it('names the unexpanded center_rect sugar when a sketch contains it', () => {
    setSketchSolver(() => new Uint8Array(0))
    const feature = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'cr', kind: 'center_rect' }], initial: {},
    }
    expect(() => solveSketch(feature, new Repository(), {})).toThrow(/center_rect sugar/)
  })

  it('refuses a feature that lowers to no sketch at all', () => {
    setSketchSolver(() => new Uint8Array(0))
    expect(() =>
      solveSketch({ id: 'ex1', kind: 'extrude', entities: [] }, new Repository(), {}),
    ).toThrow(/no lowerable sketch found/)
  })
})

describe('prepareDragContext fail-soft', () => {
  it('returns null when a lowerSketch constraint is malformed', () => {
    // An axis code only x/y/both encodes; 'z' makes lowerSketch throw. The drag
    // path must degrade to the static preview rather than throwing out of a
    // pointer handler.
    const feature = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'l1', kind: 'line' }],
      initial: { l1: [0, 0, 4, 0] },
      constraints: [{ id: 'c1', kind: 'fixed', target: '$l1', axis: 'z' }],
    } as unknown as PartFeature
    expect(prepareDragContext(feature, 'l1', 'start')).toBeNull()
  })

  it('returns null when the drag solver throws instead of propagating', () => {
    const feature = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'l1', kind: 'line' }],
      initial: { l1: [0, 0, 4, 0] },
      constraints: [],
    } as unknown as PartFeature
    const ctx = prepareDragContext(feature, 'l1', 'start')
    expect(ctx).not.toBeNull()
    setSketchSolver(() => {
      throw new Error('decode failed')
    })
    expect(solveSketchDrag(ctx!, [...ctx!.params0], [2, 0])).toBeNull()
  })
})
