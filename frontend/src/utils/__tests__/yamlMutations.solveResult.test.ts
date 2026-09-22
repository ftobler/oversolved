import { describe, it, expect } from 'vitest'
import { applyGeometryToFeature, applyRemoveDanglingContent, hasDanglingContentInDoc } from '@/utils/yamlMutations/solveResult'
import { pruneSolveResults } from '@/utils/yamlMutations/solveResults'
import type { PartDoc, Mutation } from '@/types/cad'

function makeDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      {
        id: 'sk1',
        kind: 'sketch',
        entities: [
          { id: 'line1', kind: 'line' },
          { id: 'proj1', kind: 'ellipse', source: '?edge;ellipse' },
        ],
        constraints: [
          { id: 'c1', kind: 'horizontal' },
          { id: 'c2', kind: 'vertical' },
        ],
      },
      {
        id: 'ex1',
        kind: 'extrude',
      },
    ],
  }
}

describe('applyGeometryToFeature (pure solve path)', () => {
  it('writes geometry to feature.initial', () => {
    const doc = makeDoc()
    applyGeometryToFeature(doc, 'sk1', { line1_start: [0, 0], line1_end: [1, 1] })
    const feat = doc.features!.find(f => f.id === 'sk1')!
    expect(feat.initial).toEqual({ line1_start: [0, 0], line1_end: [1, 1] })
  })

  it('keeps superfluous constraints in the doc (cleanup is an explicit command)', () => {
    // The regression the fix exists for: the old solve path deleted superfluous
    // constraints from the doc with no undo entry, and the re-solve after undo
    // re-deleted them. The solve path must never touch authored content.
    const doc = makeDoc()
    applyGeometryToFeature(doc, 'sk1', {})
    const feat = doc.features!.find(f => f.id === 'sk1')!
    expect(feat.constraints).toHaveLength(2)
  })

  it('keeps projected entities in the doc even when they would error', () => {
    const doc = makeDoc()
    applyGeometryToFeature(doc, 'sk1', {})
    const feat = doc.features!.find(f => f.id === 'sk1')!
    expect(feat.entities!.map(e => e.id)).toEqual(['line1', 'proj1'])
  })

  it('does not promote entity.kind from resolved kinds', () => {
    // A partial ellipse lowering to a spline must not rewrite the authored
    // entity kind; the resolved kind only shapes the rendered solve result.
    const doc = makeDoc()
    applyGeometryToFeature(doc, 'sk1', {})
    const proj = doc.features!.find(f => f.id === 'sk1')!.entities!.find(e => e.id === 'proj1')!
    expect(proj.kind).toBe('ellipse')
  })

  it('leaves unrelated features untouched', () => {
    const doc = makeDoc()
    applyGeometryToFeature(doc, 'sk1', { x: [1] })
    const extrude = doc.features!.find(f => f.id === 'ex1')!
    expect(extrude.initial).toBeUndefined()
  })

  it('no-ops gracefully when featureId is not found', () => {
    const doc = makeDoc()
    expect(() => applyGeometryToFeature(doc, 'missing', {})).not.toThrow()
  })
})

describe('applyRemoveDanglingContent (explicit cleanup command)', () => {
  it('removes a source-carrying projected entity and its referencing constraints', () => {
    const doc: PartDoc = {
      version: 1,
      kind: 'part',
      features: [{
        id: 'sk1', kind: 'sketch',
        entities: [
          { id: 'line1', kind: 'line' },
          { id: 'proj1', kind: 'ellipse', source: '?edge;ellipse' },
        ],
        constraints: [
          { id: 'c_keep', kind: 'horizontal', target: '$line1' },
          { id: 'c_drop_a', kind: 'coincident', a: '$line1end', b: '$proj1start' },
          { id: 'c_drop_b', kind: 'length', target: '$proj1' },
        ],
      }],
    }
    applyRemoveDanglingContent(doc, { sk1: { entities: ['proj1'], constraints: [] } })
    const feat = doc.features!.find(f => f.id === 'sk1')!
    expect(feat.entities!.map(e => e.id)).toEqual(['line1'])
    const ids = feat.constraints!.map(c => c.id)
    expect(ids).toContain('c_keep')
    expect(ids).not.toContain('c_drop_a')
    expect(ids).not.toContain('c_drop_b')
  })

  it('keeps an entity without a source even when listed for removal', () => {
    const doc = makeDoc()
    applyRemoveDanglingContent(doc, { sk1: { entities: ['line1'], constraints: [] } })
    const feat = doc.features!.find(f => f.id === 'sk1')!
    expect(feat.entities!.map(e => e.id)).toContain('line1')
  })

  it('removes superfluous constraints from the doc', () => {
    const doc = makeDoc()
    applyRemoveDanglingContent(doc, { sk1: { entities: [], constraints: ['c1'] } })
    const feat = doc.features!.find(f => f.id === 'sk1')!
    expect(feat.constraints!.map(c => c.id)).toEqual(['c2'])
  })

  it('drops constraints that reference a removed entity via refs array', () => {
    const doc: PartDoc = {
      version: 1,
      kind: 'part',
      features: [{
        id: 'sk1', kind: 'sketch',
        entities: [
          { id: 'line1', kind: 'line' },
          { id: 'proj1', kind: 'ellipse', source: '?edge;ellipse' },
          { id: 'line2', kind: 'line' },
          { id: 'line3', kind: 'line' },
        ],
        constraints: [
          { id: 'c_keep', kind: 'ngon', refs: ['$line1', '$line2', '$line3'] },
          { id: 'c_drop', kind: 'ngon', refs: ['$line1', '$proj1', '$line3'] },
        ],
      }],
    }
    applyRemoveDanglingContent(doc, { sk1: { entities: ['proj1'], constraints: [] } })
    const feat = doc.features!.find(f => f.id === 'sk1')!
    const ids = feat.constraints!.map(c => c.id)
    expect(ids).toContain('c_keep')
    expect(ids).not.toContain('c_drop')
  })

  it('leaves unrelated features untouched', () => {
    const doc = makeDoc()
    applyRemoveDanglingContent(doc, { sk1: { entities: ['proj1'], constraints: ['c1'] } })
    const extrude = doc.features!.find(f => f.id === 'ex1')!
    // Still present, and its geometry was not touched by the sketch cleanup.
    expect(extrude.initial).toBeUndefined()
  })

  it('no-ops gracefully when the feature is not found', () => {
    const doc = makeDoc()
    expect(() =>
      applyRemoveDanglingContent(doc, { missing: { entities: ['x'], constraints: ['y'] } })
    ).not.toThrow()
    expect(doc.features).toHaveLength(2)
  })
})

describe('cleanup ref matching (exact-or-vertex-suffix, not textual prefix)', () => {
  // Human-readable ids make the old startsWith matcher bite: '$l10' shares a
  // textual prefix with 'l1' but does not address it.
  it('a constraint referencing l10 survives cleanup removing l1', () => {
    const doc: PartDoc = {
      version: 1,
      kind: 'part',
      features: [{
        id: 'sk1', kind: 'sketch',
        entities: [
          { id: 'l1', kind: 'line', source: '?edge;line' },
          { id: 'l10', kind: 'line' },
        ],
        constraints: [
          { id: 'c_keep', kind: 'horizontal', target: '$l10' },
          { id: 'c_drop_bare', kind: 'length', target: '$l1' },
        ],
      }],
    }
    applyRemoveDanglingContent(doc, { sk1: { entities: ['l1'], constraints: [] } })
    const feat = doc.features!.find(f => f.id === 'sk1')!
    expect(feat.entities!.map(e => e.id)).toEqual(['l10'])
    expect(feat.constraints!.map(c => c.id)).toEqual(['c_keep'])
  })

  it('vertex-ref wire forms of a removed entity still match ($eid + known suffix)', () => {
    const doc: PartDoc = {
      version: 1,
      kind: 'part',
      features: [{
        id: 'sk1', kind: 'sketch',
        entities: [{ id: 'proj1', kind: 'ellipse', source: '?edge;ellipse' }],
        constraints: [
          { id: 'c_start', kind: 'coincident', a: '$otherstart', b: '$proj1start' },
          { id: 'c_center', kind: 'concentric', a: '$proj1center', b: '$x' },
        ],
      }],
    }
    applyRemoveDanglingContent(doc, { sk1: { entities: ['proj1'], constraints: [] } })
    const feat = doc.features!.find(f => f.id === 'sk1')!
    expect(feat.constraints).toHaveLength(0)
  })
})

describe('hasDanglingContentInDoc (cleanup plan still targets the doc)', () => {
  it('is true when a listed entity still exists with a source', () => {
    const doc = makeDoc()
    expect(hasDanglingContentInDoc(doc, { sk1: { entities: ['proj1'], constraints: [] } })).toBe(true)
  })

  it('is false for an entity without a source (never removable)', () => {
    const doc = makeDoc()
    expect(hasDanglingContentInDoc(doc, { sk1: { entities: ['line1'], constraints: [] } })).toBe(false)
  })

  it('is false when the targeted content is already gone from the doc', () => {
    const doc = makeDoc()
    const feature = doc.features!.find(f => f.id === 'sk1')!
    feature.entities = feature.entities!.filter(e => e.id !== 'proj1')
    feature.constraints = feature.constraints!.filter(c => c.id !== 'c1')
    expect(hasDanglingContentInDoc(doc, { sk1: { entities: ['proj1'], constraints: ['c1'] } })).toBe(false)
  })

  it('is true when a listed constraint still exists', () => {
    const doc = makeDoc()
    expect(hasDanglingContentInDoc(doc, { sk1: { entities: [], constraints: ['c1'] } })).toBe(true)
  })

  it('is false when no targeted feature exists', () => {
    const doc = makeDoc()
    expect(hasDanglingContentInDoc(doc, { missing: { entities: ['x'], constraints: ['y'] } })).toBe(false)
  })
})

describe('pruneSolveResults (optimistic solveResults prune)', () => {
  const result = { solved: {}, status: 'ok' }

  it('prunes the deleted feature and keeps it restorable', () => {
    const prev = { sk1: result, ex1: result }
    const { next, restorable } = pruneSolveResults({ type: 'delete_feature', featureId: 'sk1' } as Mutation, prev)
    expect(next).not.toHaveProperty('sk1')
    expect(next.ex1).toBe(prev.ex1)
    expect(restorable).toEqual({ sk1: result })
  })

  it('prunes per-feature for a delete, not the whole record', () => {
    const prev = { sk1: result, sk2: result, ex1: result }
    const { next } = pruneSolveResults(
      { type: 'delete', targets: ['entity:sk1:l1', 'constraint:sk2:c1'] } as Mutation,
      prev,
    )
    expect(next).not.toHaveProperty('sk1')
    expect(next).not.toHaveProperty('sk2')
    expect(next.ex1).toBe(prev.ex1)
  })

  it('only delete_feature carries a restorable snapshot', () => {
    const prev = { sk1: result, sk2: result }
    // A partial delete's snapshot holds geometry for entities the doc no longer
    // has; restoring it after a failing solve would redraw them as ghosts.
    const partial = pruneSolveResults({ type: 'delete', targets: ['entity:sk1:l1'] } as Mutation, prev)
    expect(partial.next).not.toHaveProperty('sk1')
    expect(partial.restorable).toBeNull()
    // Same for the other partial mutations: pruned but not restorable.
    const suppressed = pruneSolveResults({ type: 'set_feature_suppression', featureId: 'sk1', suppressed: true } as Mutation, prev)
    expect(suppressed.next).not.toHaveProperty('sk1')
    expect(suppressed.restorable).toBeNull()
  })

  it('prunes the affected feature for set_feature_suppression', () => {
    const prev = { sk1: result, ex1: result }
    const { next } = pruneSolveResults({ type: 'set_feature_suppression', featureId: 'sk1', suppressed: true } as Mutation, prev)
    expect(next).not.toHaveProperty('sk1')
    expect(next.ex1).toBe(prev.ex1)
  })

  it('prunes the new delete_body feature (its own stale entry)', () => {
    const prev = { db1: result, sk1: result }
    const { next } = pruneSolveResults({ type: 'add_delete_body', featureId: 'db1', bodies: ['@body_1'] } as Mutation, prev)
    expect(next).not.toHaveProperty('db1')
    expect(next.sk1).toBe(prev.sk1)
  })

  it('prunes the edited feature for the remove_* family', () => {
    const prev = { ex1: result, sk1: result }
    const { next } = pruneSolveResults({ type: 'remove_extrude_profile', featureId: 'ex1', index: 0 } as Mutation, prev)
    expect(next).not.toHaveProperty('ex1')
    expect(next.sk1).toBe(prev.sk1)
  })

  it('returns null restorable and the same record when nothing is touched', () => {
    const prev = { sk1: result }
    const { next, restorable } = pruneSolveResults({ type: 'rename_feature', featureId: 'sk1', label: 'x' } as Mutation, prev)
    expect(next).toBe(prev)
    expect(restorable).toBeNull()
  })
})
