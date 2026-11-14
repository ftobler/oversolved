// freeze_projection is the deliberate, link-free version of a projection: one
// mutation removes the projection and pins the geometry it held, so a later
// source edit, delete or reorder cannot move it. The unit cases prove the
// per-kind constraint set, the refusals and the one-entry undo/redo contract
// without touching the kernel.
import { describe, it, expect } from 'vitest'
import type { PartDoc, SketchFeature, SketchData } from '@/types/cad'
import {
  applyFreezeProjection,
  fixedConstraintsFor,
  freezeSelectionPlan,
  projectedSelectionTargets,
} from '@/utils/yamlMutations/freezeProjection'
import { createDocSession } from '@/session/DocSession'
import { createFakeSolveScheduler } from '@/session/__tests__/fakeSolveScheduler'

interface KindCase {
  kind: string
  params: number[]
  handles?: 'start' | 'end' | 'both'
}

const KINDS: KindCase[] = [
  { kind: 'point', params: [1, 2] },
  { kind: 'line', params: [0, 0, 10, 0] },
  { kind: 'circle', params: [0, 0, 5] },
  { kind: 'arc', params: [0, 0, 5, 0, 90] },
  { kind: 'ellipse', params: [0, 0, 8, 4, 0] },
  { kind: 'spline', params: [0, 0, 2, 0, 4, 2, 6, 0] },
  { kind: 'fit_spline', params: [0, 0, 2, 1, 4, 2, 6, 1], handles: 'both' },
]

function fitParams(base: number[], handles?: KindCase['handles']): number[] {
  if (handles === undefined) return [...base]
  const count = handles === 'both' ? 4 : 2
  return [...base, ...Array.from({ length: count }, () => 0)]
}

function heldSketch(c: KindCase, initial: number[] | undefined): SketchFeature {
  return {
    id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
    entities: [{ id: 'e1', kind: c.kind, ...(c.handles ? { handles: c.handles } : {}) }],
    initial: initial === undefined ? {} : { e1: initial },
    constraints: [{ id: 'proj_e1', kind: 'projection', target: '$e1', source: '@sk0/source' }],
  }
}

function docWith(feature: SketchFeature): PartDoc {
  return { version: 1, kind: 'part', features: [feature] }
}

function sketchOf(doc: PartDoc): SketchFeature {
  const feature = doc.features?.[0]
  if (feature?.kind !== 'sketch') throw new Error('not a sketch')
  return feature
}

describe('applyFreezeProjection on a single entity projection', () => {
  for (const c of KINDS) {
    it(`freezes a ${c.kind} into one whole-entity fixed constraint`, () => {
      const initial = fitParams(c.params, c.handles)
      const doc = docWith(heldSketch(c, initial))
      applyFreezeProjection(doc, 'sk1', 'e1')
      const feature = sketchOf(doc)
      expect(feature.constraints?.filter(row => row.kind === 'projection')).toEqual([])
      const fixed = feature.constraints?.filter(row => row.kind === 'fixed') ?? []
      expect(fixed).toHaveLength(1)
      expect(fixed[0].target).toBe('$e1')
      // The baked position is untouched, so the fixed row pins the geometry the
      // user saw and the solver has nothing left to move.
      expect(feature.initial?.e1).toEqual(initial)
      expect(feature.entities).toEqual(heldSketch(c, initial).entities)
    })
  }

  it('free mode removes only the link and keeps the baked position', () => {
    const doc = docWith(heldSketch(KINDS[1], [0, 0, 10, 0]))
    applyFreezeProjection(doc, 'sk1', 'e1', 'free')
    const feature = sketchOf(doc)
    expect(feature.constraints).toEqual([])
    expect(feature.initial?.e1).toEqual([0, 0, 10, 0])
  })

  it('refuses a target that is not a projection and leaves the document intact', () => {
    const feature = heldSketch(KINDS[1], [0, 0, 10, 0])
    feature.constraints = []
    const doc = docWith(feature)
    const before = structuredClone(doc)
    expect(() => applyFreezeProjection(doc, 'sk1', 'e1')).toThrow(/names no projection/)
    expect(doc).toEqual(before)
  })

  it('refuses an entity that never had a position, naming the delete remedy', () => {
    const doc = docWith(heldSketch(KINDS[1], undefined))
    const before = structuredClone(doc)
    expect(() => applyFreezeProjection(doc, 'sk1', 'e1')).toThrow(/no position/)
    expect(() => applyFreezeProjection(doc, 'sk1', 'e1')).toThrow(/delete the projection/)
    expect(doc).toEqual(before)
  })

  it('fixedConstraintsFor is one whole-entity row for every kind', () => {
    for (const c of KINDS) {
      const rows = fixedConstraintsFor({ id: 'e1', kind: c.kind } as never, [])
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ kind: 'fixed', target: '$e1' })
      expect(rows[0].id.startsWith('c_fixed_')).toBe(true)
    }
  })
})

describe('applyFreezeProjection on a face projection', () => {
  const TOKEN = 'u|e_aaaabbbb'
  const MEMBER = 'proj_face.aaaabbbb'

  function faceDoc(withRows = true): PartDoc {
    const feature: SketchFeature = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [], initial: {},
      constraints: [{ id: 'proj_face', kind: 'projection', source: '?face', members: { [TOKEN]: MEMBER } }],
    }
    const doc = docWith(feature)
    if (withRows) {
      applyFreezeProjection(doc, 'sk1', 'proj_face', 'fixed', [
        { id: MEMBER, kind: 'line', params: [0, 0, 10, 0] },
      ])
    }
    return doc
  }

  it('writes the derived member as a row under its derived id and fixes it', () => {
    const doc = faceDoc()
    const feature = sketchOf(doc)
    expect(feature.constraints?.some(row => row.id === 'proj_face')).toBe(false)
    expect(feature.entities).toEqual([{ id: MEMBER, kind: 'line' }])
    expect(feature.initial?.[MEMBER]).toEqual([0, 0, 10, 0])
    const fixed = feature.constraints?.filter(row => row.kind === 'fixed') ?? []
    expect(fixed).toHaveLength(1)
    expect(fixed[0].target).toBe(`$${MEMBER}`)
  })

  it('refuses a stale materialize payload rather than inventing a row', () => {
    const face: SketchFeature = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [], initial: {},
      constraints: [{ id: 'proj_face', kind: 'projection', source: '?face', members: { [TOKEN]: MEMBER } }],
    }
    const doc = docWith(face)
    const before = structuredClone(doc)
    expect(() => applyFreezeProjection(doc, 'sk1', 'proj_face', 'fixed', [
      { id: 'stranger', kind: 'line', params: [0, 0, 1, 0] },
    ])).toThrow(/no solved member rows/)
    expect(doc).toEqual(before)
  })

  it('free mode materializes the members without a fixed row', () => {
    const feature: SketchFeature = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [], initial: {},
      constraints: [{ id: 'proj_face', kind: 'projection', source: '?face', members: { [TOKEN]: MEMBER } }],
    }
    const doc = docWith(feature)
    applyFreezeProjection(doc, 'sk1', 'proj_face', 'free', [
      { id: MEMBER, kind: 'line', params: [0, 0, 10, 0] },
    ])
    expect(sketchOf(doc).entities).toEqual([{ id: MEMBER, kind: 'line' }])
    expect(sketchOf(doc).constraints).toEqual([])
  })

  it('refuses a face projection with no rows to bake', () => {
    const feature: SketchFeature = {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [], initial: {},
      constraints: [{ id: 'proj_face', kind: 'projection', source: '?face', members: { [TOKEN]: MEMBER } }],
    }
    const doc = docWith(feature)
    const before = structuredClone(doc)
    expect(() => applyFreezeProjection(doc, 'sk1', 'proj_face')).toThrow(/no solved member rows/)
    expect(doc).toEqual(before)
  })
})

describe('freezeSelectionPlan', () => {
  const TOKEN = 'u|e_aaaabbbb'
  const MEMBER = 'proj_face.aaaabbbb'

  function mixed(): SketchFeature {
    return {
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [{ id: 'held', kind: 'line' }, { id: 'plain', kind: 'line' }],
      initial: { held: [0, 0, 10, 0], plain: [0, 5, 10, 5] },
      constraints: [
        { id: 'proj_held', kind: 'projection', target: '$held', source: '@sk0/a' },
        { id: 'proj_face', kind: 'projection', source: '?face', members: { [TOKEN]: MEMBER } },
      ],
    }
  }

  it('resolves a projected entity and a projection tile, ignoring plain geometry', () => {
    const feature = mixed()
    const targets = projectedSelectionTargets(feature, new Set([
      'entity:sk1:held', 'constraint:sk1:proj_face', 'entity:sk1:plain',
    ]))
    expect(targets).toEqual(['entity:sk1:held', 'constraint:sk1:proj_face'])
  })

  it('maps a right-clicked face member to its owning projection tile', () => {
    expect(projectedSelectionTargets(mixed(), new Set([`entity:sk1:${MEMBER}`])))
      .toEqual(['constraint:sk1:proj_face'])
  })

  it('reports a face projection with no solved rows instead of emitting a refusal', () => {
    const plan = freezeSelectionPlan(mixed(), new Set(['constraint:sk1:proj_face']), 'fixed', null)
    expect(plan.mutations).toEqual([])
    expect(plan.notFrozen).toEqual(['proj_face'])
    expect(plan.refused).toEqual([])
  })

  it('reports a never-positioned entity and freezes the resolvable ones', () => {
    const feature = mixed()
    feature.initial = { plain: [0, 5, 10, 5] }
    const plan = freezeSelectionPlan(feature, new Set([
      'entity:sk1:held', 'constraint:sk1:proj_face',
    ]), 'fixed', {
      proj_face: {
        members: { [TOKEN]: MEMBER },
        entities: [{ id: MEMBER, kind: 'line', params: [0, 0, 10, 0] }],
        orphans: [],
      },
    })
    expect(plan.mutations.map(m => m.type === 'freeze_projection' ? m.target : '')).toEqual(['proj_face'])
    expect(plan.refused.join(' ')).toContain('no position')
  })
})

describe('freeze_projection through the session history', () => {
  function makeSession(doc: PartDoc) {
    const cell: { current: PartDoc | null } = { current: doc }
    const solveResults: { current: Record<string, SketchData> } = { current: {} }
    const session = createDocSession({
      cloneDoc: source => structuredClone(source),
      doc: { get: () => cell.current, set: next => { cell.current = next } },
      solve: createFakeSolveScheduler<PartDoc>(),
      solveResults: { get: () => solveResults.current, set: next => { solveResults.current = next } },
      editorFacts: () => ({ editingFeatureId: null, rollbackPosition: null }),
      dirtyFacts: () => ({ dirty: false, saves: 0, savedHash: null }),
    })
    return { session, cell }
  }

  it('one undo restores the projection and redo re-applies it without a solve', () => {
    const doc = docWith(heldSketch(KINDS[1], [0, 0, 10, 0]))
    const { session, cell } = makeSession(doc)
    const applied = session.execute({ type: 'freeze_projection', featureId: 'sk1', target: 'e1' })
    expect(applied.ok).toBe(true)
    if (applied.ok) expect(applied.createdIds).toHaveLength(1)
    expect(sketchOf(cell.current!).constraints?.some(row => row.kind === 'projection')).toBe(false)
    expect(sketchOf(cell.current!).constraints?.filter(row => row.kind === 'fixed')).toHaveLength(1)

    session.undo()
    expect(sketchOf(cell.current!).constraints?.some(row => row.kind === 'projection')).toBe(true)
    expect(sketchOf(cell.current!).constraints?.some(row => row.kind === 'fixed')).toBe(false)

    session.redo()
    expect(sketchOf(cell.current!).constraints?.some(row => row.kind === 'projection')).toBe(false)
    expect(sketchOf(cell.current!).constraints?.filter(row => row.kind === 'fixed')).toHaveLength(1)
  })

  it('a face freeze keeps the recorded member rows across undo and redo', () => {
    const TOKEN = 'u|e_aaaabbbb'
    const MEMBER = 'proj_face.aaaabbbb'
    const doc = docWith({
      id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front',
      entities: [], initial: {},
      constraints: [{ id: 'proj_face', kind: 'projection', source: '?face', members: { [TOKEN]: MEMBER } }],
    })
    const { session, cell } = makeSession(doc)
    const rows = [{ id: MEMBER, kind: 'line', params: [0, 0, 10, 0] }]
    const applied = session.execute({
      type: 'freeze_projection', featureId: 'sk1', target: 'proj_face', materialize: rows,
    })
    expect(applied.ok).toBe(true)
    expect(sketchOf(cell.current!).entities).toEqual([{ id: MEMBER, kind: 'line' }])

    session.undo()
    expect(sketchOf(cell.current!).entities).toEqual([])
    expect(sketchOf(cell.current!).constraints?.some(row => row.id === 'proj_face')).toBe(true)

    session.redo()
    expect(sketchOf(cell.current!).entities).toEqual([{ id: MEMBER, kind: 'line' }])
    expect(sketchOf(cell.current!).initial?.[MEMBER]).toEqual([0, 0, 10, 0])
  })
})
