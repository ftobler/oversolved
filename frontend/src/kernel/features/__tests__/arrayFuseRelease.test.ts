// H21 fence: the array add fuse loop must release the superseded fused solid
// and the consumed chunk of instances AFTER transferBooleanNames has run. That
// ordering is a memory-correctness hazard, not just a leak: transferBooleanNames
// reads r.faceOrigin's `source` entries, which are sub-shapes OF THE OPERANDS,
// so freeing an operand first is a use-after-free that reads plausibly and
// fails nowhere. These assertions pin the ordering, the exactly-once counting,
// the table-owned-source guard, and the chunk-bounded live-instance peak.
//
// Mocks stand in for OCC so every double records delete(): `../occ/booleans`
// provides booleanWithDiffMany, `./booleanLineage` transferBooleanNames,
// `../occ/transformLineage` the per-instance copy + name remap, and
// `./bodySplit` resplitBody. Drive solveArray (the exported entry; applyArray
// is module-private) with operation 'add'.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  booleanWithDiffMany: vi.fn(),
  transferBooleanNames: vi.fn(),
  transformCopyWithMapping: vi.fn(),
  rebuildNamesForTransformedCopy: vi.fn(),
  readSourceFaceRows: vi.fn(),
  resplitBody: vi.fn(),
}))

vi.mock('../../occ/booleans', () => ({
  booleanWithDiffMany: mocks.booleanWithDiffMany,
}))
vi.mock('../booleanLineage', () => ({
  transferBooleanNames: mocks.transferBooleanNames,
}))
vi.mock('../../occ/transformLineage', () => ({
  transformCopyWithMapping: mocks.transformCopyWithMapping,
  rebuildNamesForTransformedCopy: mocks.rebuildNamesForTransformedCopy,
  readSourceFaceRows: mocks.readSourceFaceRows,
}))
vi.mock('../../occ/transforms', () => ({
  makeTranslationTrsf: () => ({ translation: [1, 0, 0] }),
  makeRotationTrsf: () => ({ rotation: {} }),
}))
vi.mock('../bodySplit', () => ({
  registerSplitBodies: () => ['body_ex1'],
  resplitBody: mocks.resplitBody,
  solidHoldingFaces: () => null,
}))
// Reading a body's names walks its OCC shape; these bodies have none.
vi.mock('../../occ/bodyNames', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../occ/bodyNames')>()
  return { ...actual, readBodyNames: () => actual.emptyShapeNames() }
})

import { HandleTable } from '../../occ/handleTable'
import { SubShapeMap } from '../../occ/subshapeIdentity'
import { DisposeScope } from '../../occ/disposeScope'
import { solveArray } from './patternBodyTestAdapters'
import { INSTANCE_FUSE_CHUNK } from '../patternBody'
import { bareBody } from '../shared/bodyResolution'
import { emptyBrepDiff } from '../../types3d'
import type { OccModule } from '../../occ/occTypes'
import type { Repository } from '../../query'
import type { Body } from '../../types3d'

interface ShapeDouble {
  tag: string
  deletes: number
  delete(): void
}

function makeDouble(tag: string, onDelete?: () => void): ShapeDouble {
  const d: ShapeDouble = {
    tag,
    deletes: 0,
    delete() {
      d.deletes++
      onDelete?.()
      order.push(`delete:${tag}`)
    },
  }
  return d
}

const order: string[] = []
// Live instance shapes only: the batch holds at most one chunk at a time.
const liveInstances = { n: 0 }
const chunkSizes: number[] = []
const peakSamples: number[] = []
const fused: ShapeDouble[] = []
const instances: ShapeDouble[] = []
let transferCount = 0

function reset(): void {
  order.length = 0
  liveInstances.n = 0
  chunkSizes.length = 0
  peakSamples.length = 0
  fused.length = 0
  instances.length = 0
  transferCount = 0
}

function run(countX: number, includeSource: boolean): {
  table: HandleTable
  scope: DisposeScope
  source: ShapeDouble
} {
  mocks.booleanWithDiffMany.mockImplementation((_oc, _scope, _target, tools: ShapeDouble[]) => {
    chunkSizes.push(tools.length)
    peakSamples.push(liveInstances.n)  // live instances at the chunk boundary
    const d = makeDouble(`fused:${fused.length}`)
    fused.push(d)
    return { shape: d, faceOrigin: [], diff: emptyBrepDiff() }
  })
  mocks.transformCopyWithMapping.mockImplementation(() => {
    const d = makeDouble(`inst:${instances.length}`, () => { liveInstances.n-- })
    liveInstances.n++
    instances.push(d)
    return { shape: d, builder: {} }
  })
  mocks.rebuildNamesForTransformedCopy.mockImplementation(() => ({
    faceNames: new SubShapeMap(), faceAncestry: {}, edgeNames: new SubShapeMap(), edgeAncestry: {},
  }))
  mocks.readSourceFaceRows.mockReturnValue([])
  mocks.transferBooleanNames.mockImplementation(() => {
    transferCount++
    order.push(`transfer:${transferCount}`)
    return { faceNames: new SubShapeMap(), edgeNames: new SubShapeMap(), faceAncestry: {}, edgeAncestry: {} }
  })
  mocks.resplitBody.mockImplementation(() => ['body_ex1'])

  const table = new HandleTable()
  const source = makeDouble('source')
  const body: Body = { ...bareBody('body_ex1', 'ex1'), shape: table.register(source, 'ex1') }
  const scope = new DisposeScope()
  const bodyStore: Record<string, Body> = { body_ex1: body }
  const repo = { query: () => ({ start: [0, 0, 0], end: [1, 0, 0] }), elements: new Map() } as unknown as Repository

  solveArray(
    null as unknown as OccModule,
    scope,
    table,
    {
      id: 'ar1',
      array: {
        source_body: 'body_ex1',
        mode: 'linear',
        count_x: countX,
        pitch_x: 10,
        include_source: includeSource,
        operation: 'add',
        direction_x_query: 'qx',
      },
    },
    repo,
    bodyStore,
  )
  return { table, scope, source }
}

beforeEach(() => {
  reset()
  mocks.booleanWithDiffMany.mockReset()
  mocks.transferBooleanNames.mockReset()
  mocks.transformCopyWithMapping.mockReset()
  mocks.rebuildNamesForTransformedCopy.mockReset()
  mocks.resplitBody.mockReset()
})

describe('array add fuse releases (H21)', () => {
  it('releases every chunk of instances after its names transfer, and every superseded fused solid', () => {
    // 20 instances: one full chunk of 16 and a last chunk of 3.
    const { table, scope, source } = run(20, true)
    try {
      // instances[0] is the table-owned source; the other 19 are chunk copies.
      for (const d of instances) expect(d.deletes).toBe(1)
      expect(source.deletes).toBe(0)
      // Two chunks means two transfers and one superseded fused solid.
      expect(transferCount).toBe(2)
      expect(fused[0].deletes).toBe(1)
      expect(fused.at(-1)!.deletes).toBe(0)
      for (const d of fused.slice(0, -1)) expect(d.deletes).toBe(1)
      // Every chunk's releases sit AFTER that chunk's names transfer:
      // transferBooleanNames hashes the operands' source sub-shapes first.
      for (let i = 1; i <= transferCount; i++) {
        const transferAt = order.indexOf(`transfer:${i}`)
        expect(transferAt, `transfer:${i} present`).toBeGreaterThanOrEqual(0)
        expect(order.indexOf(`delete:inst:${i === 1 ? 0 : INSTANCE_FUSE_CHUNK + i - 2}`)).toBeGreaterThan(transferAt)
      }
    } finally {
      scope.dispose()
      table.disposeAll()
    }
  })

  it('releases the first instance when include_source is false', () => {
    const { table, scope } = run(4, false)
    try {
      // instances = [inst0, inst1, inst2, inst3]: inst0 is the fuse seed and
      // is NOT table-owned, so it is released after the chunk like any operand.
      for (const d of instances) expect(d.deletes).toBe(1)
      const transferAt = order.indexOf('transfer:1')
      expect(order.indexOf('delete:inst:0')).toBeGreaterThan(transferAt)
    } finally {
      scope.dispose()
      table.disposeAll()
    }
  })

  it('reports the deleted body and an empty body_ids when the add leaves no solid', () => {
    // resplitBody returns [] only when the fused shape holds no solid at all (a
    // failed boolean), at which point it has already deleted the body. The
    // fallback must not hand back the live source id for a body that is gone:
    // body_ids is explicitly empty and the warning names the deletion.
    mocks.booleanWithDiffMany.mockImplementation(() => ({
      shape: makeDouble('fused'), faceOrigin: [], diff: emptyBrepDiff(),
    }))
    mocks.transformCopyWithMapping.mockImplementation(() => ({ shape: makeDouble('inst'), builder: {} }))
    mocks.rebuildNamesForTransformedCopy.mockReturnValue({ faceNames: new SubShapeMap(), faceAncestry: {}, edgeNames: new SubShapeMap(), edgeAncestry: {} })
    mocks.readSourceFaceRows.mockReturnValue([])
    mocks.transferBooleanNames.mockReturnValue({ faceNames: {}, edgeNames: {}, faceAncestry: {}, edgeAncestry: {} })
    mocks.resplitBody.mockReturnValue([])

    const table = new HandleTable()
    const source = makeDouble('source')
    const body: Body = { ...bareBody('body_ex1', 'ex1'), shape: table.register(source, 'ex1') }
    const scope = new DisposeScope()
    const bodyStore: Record<string, Body> = { body_ex1: body }
    const repo = { query: () => ({ start: [0, 0, 0], end: [1, 0, 0] }), elements: new Map() } as unknown as Repository
    try {
      const result = solveArray(
        null as unknown as OccModule,
        scope,
        table,
        {
          id: 'ar1',
          array: {
            source_body: 'body_ex1',
            mode: 'linear',
            count_x: 2,
            pitch_x: 10,
            include_source: true,
            operation: 'add',
            direction_x_query: 'qx',
          },
        },
        repo,
        bodyStore,
      )
      expect(result).toEqual({
        status: 'ok',
        body_id: 'body_ex1',
        body_ids: [],
        operation: 'add',
        solver_warning: "pattern: the add removed all of body 'body_ex1'; the body was deleted",
      })
    } finally {
      scope.dispose()
      table.disposeAll()
    }
  })

  it('counts a no-source seed outside the chunk gate', () => {
    // With include_source false, transforms[0] is the fuse seed and the chunk
    // starts at 1: 16 transforms are 15 copies, still short of a chunk, while
    // 17 transforms fill one.
    const { table: t16, scope: s16 } = run(16, false)
    try {
      expect(chunkSizes).toEqual(Array.from({ length: 15 }, () => 1))
    } finally {
      s16.dispose()
      t16.disposeAll()
    }
    reset()
    const { table: t17, scope: s17 } = run(17, false)
    try {
      expect(chunkSizes).toEqual([INSTANCE_FUSE_CHUNK])
    } finally {
      s17.dispose()
      t17.disposeAll()
    }
  })

  it('caps the live instance peak at the chunk size and keeps a short array one fuse per copy', () => {
    const { table: t4, scope: s4 } = run(4, true)
    try {
      // Three copies are short of one chunk: the batch is the long-pattern
      // path, so each copy gets its own fuse while the whole chunk stays live.
      expect(chunkSizes).toEqual([1, 1, 1])
      expect(Math.max(...peakSamples)).toBe(3)
    } finally {
      s4.dispose()
      t4.disposeAll()
    }
    reset()
    const { table: t20, scope: s20 } = run(20, true)
    try {
      // 19 copies split into 16 and 3; the peak is the chunk size, not N-1.
      expect(chunkSizes).toEqual([INSTANCE_FUSE_CHUNK, 3])
      expect(Math.max(...peakSamples)).toBe(INSTANCE_FUSE_CHUNK)
    } finally {
      s20.dispose()
      t20.disposeAll()
    }
  })
})
