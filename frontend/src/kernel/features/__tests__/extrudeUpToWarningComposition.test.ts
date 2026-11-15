// @vitest-environment node
//
// An up_to without a usable target is a soft failure with NO geometry: the
// termination is the authored intent, so the solve never substitutes the blind
// distance for it. This isolates that decision with doubles, since the real
// add that would have grown a prism is exactly what must not happen.

import { describe, it, expect, vi } from 'vitest'
import { Repository } from '../../query'
import { solveExtrude } from '../extrude'
import { emptyShapeNames } from '../../occ/bodyNames'
import type { DisposeScope } from '../../occ/disposeScope'
import type { HandleTable } from '../../occ/handleTable'
import type { OccModule, OccShape } from '../../occ/occTypes'

vi.mock('../faceProfile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../faceProfile')>()
  return { ...actual, collectExtrudeLoops: vi.fn() }
})
vi.mock('../../occ/prismLineage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../occ/prismLineage')>()
  return { ...actual, extrudeProfileWithLineage: vi.fn() }
})
vi.mock('../bodyOps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bodyOps')>()
  return { ...actual, applyBodyOperation: vi.fn() }
})

import { collectExtrudeLoops } from '../faceProfile'
import { extrudeProfileWithLineage } from '../../occ/prismLineage'
import { applyBodyOperation } from '../bodyOps'

const plane = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }

describe('extrude up_to without a usable target', () => {
  it('reports the no-target sentence and builds no tool', () => {
    const fakeShape = { delete: () => {} } as unknown as OccShape
    vi.mocked(collectExtrudeLoops).mockReturnValue({
      loops: [[{}]], plane, sketchId: 'sk1', face: null,
      profileSurfaces: [], builtSurfaces: [], loopDiags: [],
    } as never)
    vi.mocked(extrudeProfileWithLineage).mockReturnValue({
      solid: fakeShape, ...emptyShapeNames(),
    })
    vi.mocked(applyBodyOperation).mockReturnValue({
      status: 'ok', body_id: 'body_ex2',
      solver_warning: 'extrude: operation produced no geometry change',
    })

    const result = solveExtrude(
      null as unknown as OccModule,
      { track: <T>(shape: T) => shape } as unknown as DisposeScope,
      null as unknown as HandleTable,
      { id: 'ex2', extrude: { sketch: ['$sk1'], distance: 3, termination: 'up_to', operation: 'add' } },
      new Repository(),
      {},
    )

    // One sentence, not a composed pair: nothing downstream of the early return
    // ran, so no body-op warning can join it.
    expect(result.solver_warning).toBe('extrude: up_to has no target; nothing was built')
    expect(result.solver_warning).not.toMatch(/blind/)
    expect(result.body_ids).toEqual([])
    // The fallback path does not write the informational note.
    expect(result.solver_note).toBeUndefined()
    expect(vi.mocked(extrudeProfileWithLineage)).not.toHaveBeenCalled()
    expect(vi.mocked(applyBodyOperation)).not.toHaveBeenCalled()
  })
})
