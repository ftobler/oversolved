// H21 fence: the array fuse loop (array.ts:250-274) must release the superseded
// fused solid and the consumed instance at the END of each iteration, after
// transferBooleanNames has run. That ordering is a memory-correctness hazard,
// not just a leak: transferBooleanNames reads r.faceOrigin's `source` entries,
// which are sub-shapes OF THE OPERANDS (booleanLineage.ts:81-82), so freeing an
// operand first is a use-after-free that reads plausibly and fails nowhere.
// These assertions pin the ordering, the exactly-once counting, the
// table-owned-source guard, and the constant live-intermediate peak.
//
// Mocks stand in for OCC so every double records delete(): `../occ/booleans`
// provides booleanWithDiff, `./booleanLineage` transferBooleanNames,
// `../occ/transformLineage` the per-instance copy + name remap, and
// `./bodySplit` resplitBody. Drive solveArray (the exported entry; applyArray
// is module-private) with operation 'add'.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  booleanWithDiff: vi.fn(),
  transferBooleanNames: vi.fn(),
  transformCopyWithMapping: vi.fn(),
  rebuildNamesForTransformedCopy: vi.fn(),
  readSourceFaceRows: vi.fn(),
  resplitBody: vi.fn(),
}))

vi.mock('../../occ/booleans', () => ({
  booleanWithDiff: mocks.booleanWithDiff,
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
}))

import { HandleTable } from '../../occ/handleTable'
import { DisposeScope } from '../../occ/disposeScope'
import { solveArray } from '../array'
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
const live = { n: 0 }  // live fused intermediates only; instance/source doubles do not participate
const fused: ShapeDouble[] = []
const instances: ShapeDouble[] = []
const peakSamples: number[] = []
let transferCount = 0

function reset(): void {
  order.length = 0
  live.n = 0
  fused.length = 0
  instances.length = 0
  peakSamples.length = 0
  transferCount = 0
}

function run(countX: number, includeSource: boolean): {
  table: HandleTable
  scope: DisposeScope
  source: ShapeDouble
} {
  mocks.booleanWithDiff.mockImplementation(() => {
    peakSamples.push(live.n)  // live fused count at the iteration boundary
    const d = makeDouble(`fused:${fused.length}`, () => { live.n-- })
    live.n++
    fused.push(d)
    return { shape: d, faceOrigin: [], diff: emptyBrepDiff() }
  })
  mocks.transformCopyWithMapping.mockImplementation(() => {
    const d = makeDouble(`inst:${instances.length}`)
    instances.push(d)
    return { shape: d, builder: {} }
  })
  mocks.rebuildNamesForTransformedCopy.mockImplementation(() => ({
    faceNames: {}, faceAncestry: {}, edgeNames: {}, edgeAncestry: {},
  }))
  mocks.readSourceFaceRows.mockReturnValue([])
  mocks.transferBooleanNames.mockImplementation(() => {
    transferCount++
    order.push(`transfer:${transferCount}`)
    return { face_names: {}, edge_names: {}, face_ancestry: {}, edge_ancestry: {} }
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
  // The state after the loop: pre-fix every intermediate is still alive here
  // (peak N-1); post-fix only the final fused survives (peak 1).
  peakSamples.push(live.n)
  return { table, scope, source }
}

beforeEach(() => {
  reset()
  mocks.booleanWithDiff.mockReset()
  mocks.transferBooleanNames.mockReset()
  mocks.transformCopyWithMapping.mockReset()
  mocks.rebuildNamesForTransformedCopy.mockReset()
  mocks.resplitBody.mockReset()
})

describe('array add fuse releases (H21)', () => {
  it('releases every superseded fused solid and every consumed instance exactly once, after the names transfer', () => {
    const { table, scope, source } = run(4, true)
    try {
      // With include_source, instances are [source, inst1, inst2, inst3]; the
      // final fused becomes the body, the other three fused intermediates are
      // superseded and must each be freed exactly once.
      for (const d of fused.slice(0, -1)) expect(d.deletes).toBe(1)
      for (const d of instances) expect(d.deletes).toBe(1)
      // The HandleTable-owned sourceShape must survive the whole solve: the
      // scope never tracked it, and release() deletes foreign objects.
      expect(source.deletes).toBe(0)
      // Every iteration's releases sit AFTER that iteration's names transfer:
      // transferBooleanNames hashes the operands' source sub-shapes first.
      // With include_source, array.ts instances[i] is the i-th transformed copy
      // (tagged inst:i-1) because instances[0] is the source.
      for (let i = 1; i <= 3; i++) {
        const transferAt = order.indexOf(`transfer:${i}`)
        expect(transferAt, `transfer:${i} present`).toBeGreaterThanOrEqual(0)
        expect(order.indexOf(`delete:inst:${i - 1}`), `inst:${i - 1} after transfer:${i}`).toBeGreaterThan(transferAt)
        if (i >= 2) {
          expect(order.indexOf(`delete:fused:${i - 2}`), `fused:${i - 2} after transfer:${i}`).toBeGreaterThan(transferAt)
        }
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
      // is NOT table-owned, so it is released after iteration 1 like any other
      // consumed operand.
      for (const d of instances) expect(d.deletes).toBe(1)
      for (const d of fused.slice(0, -1)) expect(d.deletes).toBe(1)
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
    mocks.booleanWithDiff.mockImplementation(() => ({
      shape: makeDouble('fused'), faceOrigin: [], diff: emptyBrepDiff(),
    }))
    mocks.transformCopyWithMapping.mockImplementation(() => ({ shape: makeDouble('inst'), builder: {} }))
    mocks.rebuildNamesForTransformedCopy.mockReturnValue({ faceNames: {}, faceAncestry: {}, edgeNames: {}, edgeAncestry: {} })
    mocks.readSourceFaceRows.mockReturnValue([])
    mocks.transferBooleanNames.mockReturnValue({ face_names: {}, edge_names: {}, face_ancestry: {}, edge_ancestry: {} })
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
        solver_warning: "array: the add removed all of body 'body_ex1'; the body was deleted",
      })
    } finally {
      scope.dispose()
      table.disposeAll()
    }
  })

  it('keeps the live fused-intermediate peak at 1 for 4 and 12 instances', () => {
    const { table: t4, scope: s4 } = run(4, true)
    try {
      const peak4 = Math.max(...peakSamples)
      expect(peak4).toBe(1)
    } finally {
      s4.dispose()
      t4.disposeAll()
    }
    reset()
    const { table: t12, scope: s12 } = run(12, true)
    try {
      const peak12 = Math.max(...peakSamples)
      // Pre-fix the peak is N-1 (11): every intermediate rides the build scope
      // to solve end. Post-fix only the current fused is alive.
      expect(peak12).toBe(1)
    } finally {
      s12.dispose()
      t12.disposeAll()
    }
  })
})