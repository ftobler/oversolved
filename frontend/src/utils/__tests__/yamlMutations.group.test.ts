// The Group constraint at the document layer: authoring stores the whole and
// point member list in `refs` (anchor first), a projected/origin/value pick and
// a duplicate or lone point are refused, deleting a member shrinks the group
// instead of cascading, the mirror and pattern copy one group per copy, and
// fillet_corners refuses a grouped side.
import { describe, it, expect } from 'vitest'
import type { FilletCorner, PartConstraint, PartDoc, SketchData } from '@/types/cad'
import { createDocSession, type DocSession, type EditorFacts } from '@/session/DocSession'
import type { DirtyFacts } from '@/session/dirty'
import { createFakeSolveScheduler } from '@/session/__tests__/fakeSolveScheduler'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'
import {
  applyAddConstraint,
  applyDeleteElements,
  applyMirrorEntities,
  applyPatternEntities,
  planFilletCorners,
} from '@/utils/yamlMutations'
import { sketchAt } from '@/testing/featureAccess'
import { addConstraintProblem } from '@/utils/constraintProblems'

function groupDoc(extra: { constraints?: PartConstraint[] } = {}): PartDoc {
  return makeDoc(makeSketch('sk', {
    entities: [
      { id: 'l1', kind: 'line' },
      { id: 'l2', kind: 'line' },
      { id: 'c1', kind: 'circle' },
      { id: 'p1', kind: 'point' },
      { id: 'ax', kind: 'line' },
    ],
    initial: {
      l1: [0, 0, 4, 0],
      l2: [0, 2, 4, 2],
      c1: [2, 1, 0.5],
      p1: [6, 6],
      ax: [0, -10, 0, 10],
    },
    constraints: extra.constraints,
  }))
}

const sketch = (doc: PartDoc) => sketchAt(doc)

function engineFor(doc: PartDoc): { session: DocSession; cell: { current: PartDoc | null } } {
  const cell: { current: PartDoc | null } = { current: doc }
  const solve = createFakeSolveScheduler<PartDoc>()
  const facts: EditorFacts = { editingFeatureId: null, rollbackPosition: null }
  const dirty: DirtyFacts = { dirty: false, saves: 0, savedHash: null }
  const solveResults: { current: Record<string, SketchData> } = { current: {} }
  const session = createDocSession({
    cloneDoc: source => structuredClone(source),
    doc: { get: () => cell.current, set: next => { cell.current = next } },
    solve,
    solveResults: { get: () => solveResults.current, set: next => { solveResults.current = next } },
    editorFacts: () => facts,
    dirtyFacts: () => dirty,
  })
  return { session, cell }
}

describe('group add_constraint', () => {
  it('stores every member in refs, anchor first, as one constraint', () => {
    const doc = groupDoc()
    applyAddConstraint(doc, 'sk', 'group', ['entity:sk:l1', 'entity:sk:c1', 'entity:sk:p1'])
    const groups = (sketch(doc).constraints ?? []).filter(c => c.kind === 'group')
    expect(groups).toHaveLength(1)
    expect(groups[0].refs).toEqual(['$l1', '$c1', '$p1'])
    expect(groups[0].value).toBeUndefined()
  })

  it('stores point members beside whole members', () => {
    const doc = groupDoc()
    applyAddConstraint(doc, 'sk', 'group', ['vertex:sk:l1:end', 'entity:sk:l2'])
    const groups = (sketch(doc).constraints ?? []).filter(c => c.kind === 'group')
    expect(groups).toHaveLength(1)
    expect(groups[0].refs).toEqual(['$l1end', '$l2'])
  })

  it('stores a point entity picked by its xy as the whole entity', () => {
    const doc = groupDoc()
    applyAddConstraint(doc, 'sk', 'group', ['vertex:sk:p1:xy', 'entity:sk:l1'])
    const groups = (sketch(doc).constraints ?? []).filter(c => c.kind === 'group')
    expect(groups[0].refs).toEqual(['$p1', '$l1'])
  })

  it('refuses a projected member, the origin, a lone point, a value and an empty pick', () => {
    const projected = groupDoc({
      constraints: [{ id: 'proj', kind: 'projection', target: '$p1', source: '@edge1' }],
    })
    const before = JSON.stringify(projected)
    for (const targets of [
      ['entity:sk:l1', 'entity:sk:p1'],
      ['@builtin_origin'],
      ['vertex:sk:l1:end'],
      [],
    ]) {
      applyAddConstraint(projected, 'sk', 'group', targets)
      expect(JSON.stringify(projected)).toBe(before)
    }
    applyAddConstraint(projected, 'sk', 'group', ['entity:sk:l1'], 5)
    expect(JSON.stringify(projected)).toBe(before)
  })

  it('refuses an entity named both whole and by point, naming the duplicate', () => {
    const doc = groupDoc()
    const before = JSON.stringify(doc)
    applyAddConstraint(doc, 'sk', 'group', ['entity:sk:l1', 'vertex:sk:l1:end'])
    expect(JSON.stringify(doc)).toBe(before)
    const reason = addConstraintProblem(sketch(doc), 'group', ['entity:sk:l1', 'vertex:sk:l1:end'], undefined)
    expect(reason).toContain('both whole and by point')
  })

  it('is one undo entry and undo hands back the free sketch', () => {
    const doc = groupDoc()
    const { session, cell } = engineFor(doc)
    const result = session.execute({
      type: 'add_constraint',
      featureId: 'sk',
      kind: 'group',
      targets: ['entity:sk:l1', 'entity:sk:l2'],
    })
    expect(result.ok).toBe(true)
    expect(session.historyEntries().undo).toHaveLength(1)
    const created = sketch(cell.current!).constraints ?? []
    expect(created.filter(c => c.kind === 'group')).toHaveLength(1)

    expect(session.undo()).toBe(true)
    expect(sketch(cell.current!).constraints ?? []).toEqual([])
    expect(session.redo()).toBe(true)
    expect((sketch(cell.current!).constraints ?? []).filter(c => c.kind === 'group')).toHaveLength(1)
  })
})

describe('group deletion', () => {
  function withGroup(members: string[]): PartDoc {
    return groupDoc({
      constraints: [{ id: 'g1', kind: 'group', refs: members.map(id => `$${id}`) }],
    })
  }

  it('deleting a member shrinks the group', () => {
    const doc = withGroup(['l1', 'l2', 'c1'])
    applyDeleteElements(doc, ['entity:sk:l2'])
    expect(sketch(doc).constraints?.[0].refs).toEqual(['$l1', '$c1'])
  })

  it('deleting the anchor re-anchors on the next member', () => {
    const doc = withGroup(['l1', 'l2', 'c1'])
    applyDeleteElements(doc, ['entity:sk:l1'])
    expect(sketch(doc).constraints?.[0].refs).toEqual(['$l2', '$c1'])
  })

  it('deleting the last member removes the group', () => {
    const doc = withGroup(['l1'])
    applyDeleteElements(doc, ['entity:sk:l1'])
    expect(sketch(doc).constraints ?? []).toEqual([])
  })

  it('deleting a spline that holds two point members removes the group', () => {
    const doc = makeDoc(makeSketch('sk', {
      entities: [
        { id: 'sp', kind: 'spline' },
        { id: 'l1', kind: 'line' },
      ],
      initial: { sp: [0, 0, 1, 2, 3, 4, 5, 6], l1: [0, 3, 4, 3] },
      constraints: [{ id: 'g1', kind: 'group', refs: ['$l1', '$spc1', '$spc2'] }],
    }))
    applyDeleteElements(doc, ['entity:sk:sp'])
    expect(sketch(doc).constraints?.[0].refs).toEqual(['$l1'])
  })

  it('deleting one of two point-member entities removes the group', () => {
    const doc = withGroup(['l1end', 'l2start'])
    applyDeleteElements(doc, ['entity:sk:l2'])
    expect(sketch(doc).constraints ?? []).toEqual([])
  })
})

describe('group copy rules', () => {
  it('mirror copies one group over the copies when every member is a source', () => {
    const doc = groupDoc({
      constraints: [{ id: 'g1', kind: 'group', refs: ['$l1', '$l2', '$c1'] }],
    })
    applyMirrorEntities(doc, 'sk', ['l1', 'l2', 'c1'], 'ax')
    const groups = (sketch(doc).constraints ?? []).filter(c => c.kind === 'group')
    expect(groups).toHaveLength(2)
    const copy = groups.find(c => c.id !== 'g1')!
    const sources = new Set(['l1', 'l2', 'c1', 'p1', 'ax'])
    const copies = (sketch(doc).entities ?? []).filter(e => !sources.has(e.id))
    expect(copies).toHaveLength(3)
    expect(copy.refs).toHaveLength(3)
    for (const ref of copy.refs as string[]) expect(copies.map(e => `$${e.id}`)).toContain(ref)
    expect(copy.refs).not.toContain('$l1')
  })

  it('a partial group does not copy', () => {
    const doc = groupDoc({
      constraints: [{ id: 'g1', kind: 'group', refs: ['$l1', '$p1'] }],
    })
    applyMirrorEntities(doc, 'sk', ['l1', 'c1'], 'ax')
    expect((sketch(doc).constraints ?? []).filter(c => c.kind === 'group')).toHaveLength(1)
  })

  it('mirror copies point members as the copies mapped points', () => {
    const doc = groupDoc({
      constraints: [{ id: 'g1', kind: 'group', refs: ['$l1end', '$l2start'] }],
    })
    applyMirrorEntities(doc, 'sk', ['l1', 'l2'], 'ax')
    const groups = (sketch(doc).constraints ?? []).filter(c => c.kind === 'group')
    expect(groups).toHaveLength(2)
    const copy = groups.find(c => c.id !== 'g1')!
    const copyIds = (sketch(doc).entities ?? [])
      .map(e => e.id)
      .filter(id => id !== 'l1' && id !== 'l2')
    expect(copy.refs).toHaveLength(2)
    for (const ref of copy.refs as string[]) {
      const entity = copyIds.find(id => ref.startsWith(`$${id}`))
      expect(entity, `ref ${ref} does not name a copy`).toBeDefined()
      expect(ref.slice(entity!.length + 1)).toMatch(/^(start|end)$/)
    }
  })

  it('pattern copies point members with their transformed keys', () => {
    const doc = groupDoc({
      constraints: [{ id: 'g1', kind: 'group', refs: ['$l1end', '$l2start'] }],
    })
    applyPatternEntities(doc, {
      featureId: 'sk', sourceIds: ['l1', 'l2'], mode: 'linear', count: 3, pitch: 10, direction: [1, 0],
    })
    const groups = (sketch(doc).constraints ?? []).filter(c => c.kind === 'group')
    expect(groups).toHaveLength(3)
    for (const group of groups) {
      const refs = group.refs as string[]
      expect(refs).toHaveLength(2)
      expect(refs.map(ref => ref.slice(ref.indexOf('$') + 1)).some(ref => ref.endsWith('end'))).toBe(true)
      expect(refs.map(ref => ref.slice(ref.indexOf('$') + 1)).some(ref => ref.endsWith('start'))).toBe(true)
    }
  })

  it('pattern copies one group per instance when every member is a source', () => {
    const doc = groupDoc({
      constraints: [{ id: 'g1', kind: 'group', refs: ['$l1', '$l2'] }],
    })
    applyPatternEntities(doc, {
      featureId: 'sk', sourceIds: ['l1', 'l2'], mode: 'linear', count: 3, pitch: 10, direction: [1, 0],
    })
    const groups = (sketch(doc).constraints ?? []).filter(c => c.kind === 'group')
    // The source group plus one per copy instance.
    expect(groups).toHaveLength(3)
    for (const group of groups) expect(group.refs).toHaveLength(2)
  })

  it('a pattern over a partial group carries no group', () => {
    const doc = groupDoc({
      constraints: [{ id: 'g1', kind: 'group', refs: ['$l1', '$p1'] }],
    })
    applyPatternEntities(doc, {
      featureId: 'sk', sourceIds: ['l1', 'c1'], mode: 'linear', count: 2, pitch: 10, direction: [1, 0],
    })
    expect((sketch(doc).constraints ?? []).filter(c => c.kind === 'group')).toHaveLength(1)
  })
})

describe('fillet_corners on a grouped side', () => {
  it('is refused by name with "ungroup first"', () => {
    const doc = makeDoc(makeSketch('sk', {
      entities: [{ id: 'l1', kind: 'line' }, { id: 'l2', kind: 'line' }],
      initial: { l1: [0, 0, 4, 0], l2: [4, 0, 4, 2] },
      constraints: [{ id: 'g1', kind: 'group', refs: ['$l1', '$l2'] }],
    }))
    const feature = sketch(doc)
    const corner: FilletCorner = { a: 'l1', aVertex: 'end', b: 'l2', bVertex: 'start' }
    const plan = planFilletCorners(feature, 0.5, [corner])
    expect('code' in plan && plan.code).toBe('invalid')
    expect('reason' in plan && plan.reason).toContain('ungroup first')
    expect('reason' in plan && plan.reason).toContain('g1')
  })

  it('is refused when the corner point itself is a group member', () => {
    const doc = makeDoc(makeSketch('sk', {
      entities: [
        { id: 'l1', kind: 'line' },
        { id: 'l2', kind: 'line' },
        { id: 'c1', kind: 'circle' },
      ],
      initial: { l1: [0, 0, 4, 0], l2: [4, 0, 4, 2], c1: [8, 0, 1] },
      constraints: [{ id: 'g1', kind: 'group', refs: ['$l1end', '$c1'] }],
    }))
    const corner: FilletCorner = { a: 'l1', aVertex: 'end', b: 'l2', bVertex: 'start' }
    const plan = planFilletCorners(sketch(doc), 0.5, [corner])
    expect('code' in plan && plan.code).toBe('invalid')
    expect('reason' in plan && plan.reason).toContain('ungroup first')
  })
})
