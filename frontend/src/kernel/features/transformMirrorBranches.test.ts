// OCC-free branch tests for the transform/mirror leaf. The heavy OCC path is
// replaced by recording doubles so the query-driven trsf composition, the
// operation-selection results, and the defensive body_ids:[] results can be
// asserted directly instead of only through a kernel. The real-kernel geometry
// parity lives in transformGroupReal.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  transformCopyWithMapping: vi.fn(),
  rekeyNamesForTransformedBody: vi.fn(),
  rebuildNamesForTransformedCopy: vi.fn(),
  readSourceFaceRows: vi.fn(),
  booleanWithDiff: vi.fn(),
  transferBooleanNames: vi.fn(),
  registerSplitBodies: vi.fn(),
  resplitBody: vi.fn(),
  makeMirrorTrsf: vi.fn(),
  makeTranslationTrsf: vi.fn(),
  makeRotationTrsf: vi.fn(),
  makeScaleTrsf: vi.fn(),
}))

vi.mock('../occ/transformLineage', () => ({
  transformCopyWithMapping: mocks.transformCopyWithMapping,
  rekeyNamesForTransformedBody: mocks.rekeyNamesForTransformedBody,
  rebuildNamesForTransformedCopy: mocks.rebuildNamesForTransformedCopy,
  readSourceFaceRows: mocks.readSourceFaceRows,
}))
vi.mock('../occ/booleans', () => ({
  booleanWithDiff: mocks.booleanWithDiff,
}))
vi.mock('./booleanLineage', () => ({
  transferBooleanNames: mocks.transferBooleanNames,
}))
vi.mock('./bodySplit', () => ({
  registerSplitBodies: mocks.registerSplitBodies,
  resplitBody: mocks.resplitBody,
}))
vi.mock('../occ/transforms', () => ({
  makeMirrorTrsf: mocks.makeMirrorTrsf,
  makeTranslationTrsf: mocks.makeTranslationTrsf,
  makeRotationTrsf: mocks.makeRotationTrsf,
  makeScaleTrsf: mocks.makeScaleTrsf,
}))

import { Repository } from '../query'
import { solveTransform, solveMirror } from './transformMirror'
import type { DisposeScope } from '../occ/disposeScope'
import type { HandleTable } from '../occ/handleTable'
import type { OccModule } from '../occ/occTypes'
import type { Body } from '../types3d'

// The composed gp_Trsf: one instance per solve, recording what Multiply got so
// the query-driven translation/rotation/scale can be read back.
type TrsfOp = { tag: string; [k: string]: unknown }
const trsfOps: TrsfOp[] = []
class FakeTrsf {
  Multiply(t: TrsfOp): void {
    trsfOps.push(t)
  }
}

const oc = { gp_Trsf_1: FakeTrsf } as unknown as OccModule
const scope = {
  track: <T>(x: T): T => x,
  release: (): void => {},
  dispose: (): void => {},
} as unknown as DisposeScope
const table = { get: (h: unknown): unknown => h } as unknown as HandleTable

const NAMES = { faceNames: {}, faceAncestry: {}, edgeNames: {}, edgeAncestry: {} }

function body(id = 'body_a', shape: number | null = 1): Body {
  return {
    id,
    created_by: 'ex',
    modified_by: [],
    shape: shape as never,
    sketch_id: 'sk',
    brep_diff: null,
    profile_queries: [],
  }
}

beforeEach(() => {
  trsfOps.length = 0
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.transformCopyWithMapping.mockReturnValue({ shape: {}, builder: {} })
  mocks.rekeyNamesForTransformedBody.mockReturnValue(NAMES)
  mocks.rebuildNamesForTransformedCopy.mockReturnValue(NAMES)
  mocks.readSourceFaceRows.mockReturnValue([])
  mocks.booleanWithDiff.mockReturnValue({ shape: {}, faceOrigin: [], diff: {} })
  mocks.transferBooleanNames.mockReturnValue({ face_names: {}, face_ancestry: {}, edge_names: {}, edge_ancestry: {} })
  mocks.resplitBody.mockReturnValue(['body_a'])
  mocks.registerSplitBodies.mockReturnValue(['body_t1'])
  mocks.makeTranslationTrsf.mockImplementation((_oc: unknown, _sc: unknown, dx: number, dy: number, dz: number) => ({ tag: 'translate', dx, dy, dz }))
  mocks.makeRotationTrsf.mockImplementation((_oc: unknown, _sc: unknown, origin: number[], dir: number[], angle: number) => ({ tag: 'rotate', origin, dir, angle }))
  mocks.makeScaleTrsf.mockImplementation((_oc: unknown, _sc: unknown, center: number[], factor: number) => ({ tag: 'scale', center, factor }))
  mocks.makeMirrorTrsf.mockImplementation((_oc: unknown, _sc: unknown, origin: number[], normal: number[]) => ({ tag: 'mirror', origin, normal }))
})

describe('solveTransform composed trsf', () => {
  it('turns query-resolved translation_from/to into the point delta', () => {
    const repo = new Repository()
    repo.register('from', { origin: [1, 1, 1] })
    repo.register('to', { origin: [4, 6, 9] })
    solveTransform(oc, scope, table, {
      id: 't1',
      transform: { bodies: ['body_a'], translation_from: '@from', translation_to: '@to' },
    }, repo, { body_a: body() })
    expect(trsfOps).toContainEqual({ tag: 'translate', dx: 3, dy: 5, dz: 8 })
  })

  it('lifts a sketch-space rotation_axis line through its _pt_ plane and normalizes the direction', () => {
    const repo = new Repository()
    repo.register('axis', { kind: 'line', external_params: [0, 0, 2, 0], sketch_id: 'sk' })
    repo.elements.set('_pt_sk', { origin: [10, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] })
    solveTransform(oc, scope, table, {
      id: 't1',
      transform: { bodies: ['body_a'], rotation_angle: 90, rotation_axis: '@axis' },
    }, repo, { body_a: body() })
    expect(trsfOps).toContainEqual({ tag: 'rotate', origin: [10, 0, 0], dir: [1, 0, 0], angle: Math.PI / 2 })
  })

  it('falls back to z=0 endpoints when a sketch-space axis line has no registered plane', () => {
    const repo = new Repository()
    repo.register('axis', { kind: 'line', external_params: [1, 2, 3, 4] })
    solveTransform(oc, scope, table, {
      id: 't1',
      transform: { bodies: ['body_a'], rotation_angle: 90, rotation_axis: '@axis' },
    }, repo, { body_a: body() })
    const rotate = trsfOps.find((o) => o.tag === 'rotate')!
    expect(rotate.origin).toEqual([1, 2, 0])
    const dir = rotate.dir as number[]
    expect(dir[0]).toBeCloseTo(Math.SQRT1_2)
    expect(dir[1]).toBeCloseTo(Math.SQRT1_2)
    expect(dir[2]).toBe(0)
    expect(rotate.angle).toBeCloseTo(Math.PI / 2)
  })

  it('refuses a rotation_axis pick that carries no line coordinates', () => {
    const repo = new Repository()
    repo.register('axis', { type: 'vertex', origin: [0, 0, 0] })
    expect(() =>
      solveTransform(oc, scope, table, {
        id: 't1',
        transform: { bodies: ['body_a'], rotation_angle: 90, rotation_axis: '@axis' },
      }, repo, { body_a: body() }),
    ).toThrow(/edge reference has no line coordinates/)
  })

  it('resolves scale_center_from to the queried point', () => {
    const repo = new Repository()
    repo.register('center', { origin: [5, 5, 5] })
    solveTransform(oc, scope, table, {
      id: 't1',
      transform: { bodies: ['body_a'], scale: 2, scale_center_from: '@center' },
    }, repo, { body_a: body() })
    expect(trsfOps).toContainEqual({ tag: 'scale', center: [5, 5, 5], factor: 2 })
  })
})

describe('solveTransform operation selection', () => {
  it('replace resplits in place and records the feature on the source', () => {
    mocks.resplitBody.mockReturnValue(['body_a'])
    const source = body('body_a')
    const result = solveTransform(oc, scope, table, {
      id: 't1',
      transform: { bodies: ['body_a'], operation: 'replace', translation: [1, 0, 0] },
    }, new Repository(), { body_a: source })
    expect(result).toEqual({ status: 'ok', body_id: 'body_a', body_ids: ['body_a'], operation: 'replace' })
    expect(source.modified_by).toEqual(['t1'])
  })

  it('new registers a fresh body off the feature id', () => {
    mocks.registerSplitBodies.mockReturnValue(['body_t1'])
    const source = body('body_a')
    const result = solveTransform(oc, scope, table, {
      id: 't1',
      transform: { bodies: ['body_a'], operation: 'new', translation: [1, 0, 0] },
    }, new Repository(), { body_a: source })
    expect(result).toEqual({ status: 'ok', body_id: 'body_t1', body_ids: ['body_t1'], operation: 'new' })
    expect(source.modified_by).toEqual([])
  })

  it('reports body_ids:[] with a naming warning when the replace consumes its source', () => {
    // Defensive: a transform copy cannot consume its source, but the contract
    // when the resplit ever deletes it is that nothing survives and body_id
    // names the body the feature row points at.
    mocks.resplitBody.mockReturnValue([])
    const source = body('body_a')
    const result = solveTransform(oc, scope, table, {
      id: 't1',
      transform: { bodies: ['body_a'], operation: 'replace', translation: [1, 0, 0] },
    }, new Repository(), { body_a: source })
    expect(result).toEqual({
      status: 'ok',
      body_id: 'body_a',
      body_ids: [],
      operation: 'replace',
      solver_warning: expect.stringMatching(/the replace removed all of body 'body_a'/),
    })
    expect(source.modified_by).toEqual([])
  })
})

describe('solveTransform rotation axis guard', () => {
  it('throws on a zero rotation_axis_direction rather than rotating about Z', () => {
    expect(() =>
      solveTransform(oc, scope, table, {
        id: 't1',
        transform: { bodies: ['body_a'], rotation_angle: 45, rotation_axis_direction: [0, 0, 0] },
      }, new Repository(), { body_a: body() }),
    ).toThrow(/rotation axis direction must be a non-zero vector/)
  })
})

describe('solveMirror plane payloads and operation selection', () => {
  function bodyStore(): Record<string, Body> {
    return { body_a: body('body_a') }
  }

  it('reads a numeric plane payload without a type tag via x_axis/normal/origin', () => {
    const repo = new Repository()
    repo.register('plane_q', { origin: [0, 0, 0], x_axis: [1, 0, 0], normal: [0, 0, 1] })
    const result = solveMirror(oc, scope, table, {
      id: 'm1', mirror: { body: 'body_a', plane: '@plane_q', keep_original: true, merge: false },
    }, repo, bodyStore())
    expect(mocks.makeMirrorTrsf).toHaveBeenCalledWith(oc, scope, [0, 0, 0], [0, 0, 1])
    expect(result).toEqual({ status: 'ok', body_id: 'body_t1', body_ids: ['body_t1'], operation: 'new' })
  })

  it('reads a flatface payload from its origin/normal', () => {
    const repo = new Repository()
    repo.register('plane_q', { type: 'flatface', origin: [0, 0, 3], normal: [0, 0, 1] })
    solveMirror(oc, scope, table, {
      id: 'm1', mirror: { body: 'body_a', plane: '@plane_q', keep_original: true, merge: false },
    }, repo, bodyStore())
    expect(mocks.makeMirrorTrsf).toHaveBeenCalledWith(oc, scope, [0, 0, 3], [0, 0, 1])
  })

  it('throws when the source body exists but has no shape', () => {
    const repo = new Repository()
    repo.register('plane_q', { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1] })
    expect(() =>
      solveMirror(oc, scope, table, {
        id: 'm1', mirror: { body: 'body_a', plane: '@plane_q' },
      }, repo, { body_a: body('body_a', null) }),
    ).toThrow(/body not found for ref 'body_a'|mirror: body not found/)
  })

  it('refuses a zero-length mirror normal', () => {
    const repo = new Repository()
    repo.register('plane_q', { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 0] })
    expect(() =>
      solveMirror(oc, scope, table, {
        id: 'm1', mirror: { body: 'body_a', plane: '@plane_q' },
      }, repo, bodyStore()),
    ).toThrow(/plane normal must be a non-zero vector/)
  })

  it('replace rekeys the source in place and records the feature', () => {
    mocks.resplitBody.mockReturnValue(['body_a'])
    const repo = new Repository()
    repo.register('plane_q', { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1] })
    const store = bodyStore()
    const result = solveMirror(oc, scope, table, {
      id: 'm1', mirror: { body: 'body_a', plane: '@plane_q', keep_original: false },
    }, repo, store)
    expect(result).toEqual({ status: 'ok', body_id: 'body_a', body_ids: ['body_a'], operation: 'replace' })
    expect(store.body_a.modified_by).toEqual(['m1'])
  })

  it('replace reports body_ids:[] when the resplit consumes the source', () => {
    mocks.resplitBody.mockReturnValue([])
    const repo = new Repository()
    repo.register('plane_q', { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1] })
    const result = solveMirror(oc, scope, table, {
      id: 'm1', mirror: { body: 'body_a', plane: '@plane_q', keep_original: false },
    }, repo, bodyStore())
    expect(result).toEqual({
      status: 'ok',
      body_id: 'body_a',
      body_ids: [],
      operation: 'replace',
      solver_warning: expect.stringMatching(/the replace removed all of body 'body_a'/),
    })
  })

  it('merge fuses the source and its mirror, then resplits', () => {
    mocks.resplitBody.mockReturnValue(['body_a'])
    const repo = new Repository()
    repo.register('plane_q', { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1] })
    const store = bodyStore()
    const result = solveMirror(oc, scope, table, {
      id: 'm1', mirror: { body: 'body_a', plane: '@plane_q', keep_original: true, merge: true },
    }, repo, store)
    expect(mocks.booleanWithDiff).toHaveBeenCalledWith(oc, scope, 1, {}, 'fuse', { unifyFaces: true })
    expect(result).toEqual({ status: 'ok', body_id: 'body_a', body_ids: ['body_a'], operation: 'merge' })
    expect(store.body_a.modified_by).toEqual(['m1'])
  })

  it('merge reports body_ids:[] when the resplit consumes the source', () => {
    mocks.resplitBody.mockReturnValue([])
    const repo = new Repository()
    repo.register('plane_q', { type: 'plane', origin: [0, 0, 0], normal: [0, 0, 1] })
    const result = solveMirror(oc, scope, table, {
      id: 'm1', mirror: { body: 'body_a', plane: '@plane_q', keep_original: true, merge: true },
    }, repo, bodyStore())
    expect(result).toEqual({
      status: 'ok',
      body_id: 'body_a',
      body_ids: [],
      operation: 'merge',
      solver_warning: expect.stringMatching(/the merge removed all of body 'body_a'/),
    })
  })
})
