// @vitest-environment node
//
// The up_to fallback warning is composed after applyBodyOperation, so a body-op
// warning ("operation produced no geometry change") cannot replace it. This
// isolates the ordering with doubles, since the real add that changes nothing
// is hard to produce while the operation still reports success.

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

describe('extrude up_to warning composition', () => {
  it('keeps the no-target warning when the body operation also warns', () => {
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

    expect(result.solver_warning).toContain('up_to has no target; used blind distance')
    expect(result.solver_warning).toContain('operation produced no geometry change')
  })
})
