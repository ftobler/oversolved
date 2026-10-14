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
    const before = structuredClone(doc)
    applyGeometryToFeature(doc, 'missing', {})
    expect(doc).toEqual(before)
    expect(doc.features!.find(f => f.id === 'missing')).toBeUndefined()
  })

  it('no-ops when the doc has no features array', () => {
    const doc = { version: 1, kind: 'part' } as PartDoc
    const before = structuredClone(doc)
    applyGeometryToFeature(doc, 'sk1', { x: [1] })
    // A read-modify-write must not lazily materialize an empty feature list.
    expect(doc).toEqual(before)
    expect(doc.features).toBeUndefined()
  })

  // The worker decodes the solved params as float32, so the wire carries
  // 3.1415927410125732 where every sketch mutator persists 3.141593. Baking the
  // wire values verbatim leaves two spellings of one geometry in the document,
  // and every consumer that compares doc content (useSolver's save identity
  // guard, findFirstDirty's checkpoint hash, docDiffersForSession) then reads a
  // re-solve that moved nothing as a change.
  it('bakes the solved geometry rounded to the precision the mutators write', () => {
    const doc = makeDoc()
    applyGeometryToFeature(doc, 'sk1', {
      c1: [0, 0, Math.fround(Math.PI)],
      p1: [Math.fround(1 / 3), 2],
    })
    const feat = doc.features!.find(f => f.id === 'sk1')!
    expect(feat.initial).toEqual({ c1: [0, 0, 3.141593], p1: [0.333333, 2] })
  })

  // The geometry map is handed over by the solve result record, which keeps
  // reading it afterwards (unflattenGeometry renders from the same object).
  // Rounding in place would rewrite the solver's own numbers under it.
  it('leaves the geometry arrays it was handed untouched', () => {
    const doc = makeDoc()
    const geometry = { c1: [Math.fround(Math.PI)], p1: [Math.fround(1 / 3)] }
    const pristine = structuredClone(geometry)
    applyGeometryToFeature(doc, 'sk1', geometry)
    expect(geometry).toEqual(pristine)
    const feat = doc.features!.find(f => f.id === 'sk1')!
    // New arrays, not aliases of the solve result's.
    expect(feat.initial!.c1).not.toBe(geometry.c1)
    expect(feat.initial!.p1).not.toBe(geometry.p1)
  })

  // The band the f32 quantum actually bites in: round(f32(25.7)) is 25.700001,
  // round(f32(47.3)) is 47.299999, round(f32(63.4)) is 63.400002, and
  // f32(100.000001) is 100 outright. The suites that only ever used values
  // below 4 saw no mismatch, which is why the rounding-only write-back looked
  // complete: it still minted a fresh doc object (a stale checkpoint hash, a
  // phantom session diff, a save that stops clearing dirty) for a solve that
  // moved nothing. Rounding alone cannot close that, because the wire value
  // and the authored value are two spellings of one geometry.
  const F32_BAND = [25.7, 47.3, 63.4, 100.000001]

  it.each(F32_BAND)('keeps the authored spelling of %s when the solve re-derives it as f32', (v) => {
    const doc = makeDoc()
    const feat = doc.features!.find(f => f.id === 'sk1')!
    feat.initial = { line1: [0, 0, v, 0] }
    const before = feat.initial
    applyGeometryToFeature(doc, 'sk1', { line1: [0, 0, Math.fround(v), 0] })
    // Kept by reference: the pre-solve array survives the write-back, so the
    // doc still compares equal to its pre-solve self and no downstream reader
    // sees a change.
    expect(feat.initial).toBe(before)
    expect(feat.initial!.line1[2]).toBe(v)
  })

  it('keeps an over-precise authored value rather than re-spelling it on the 6dp grid', () => {
    // Hand-written YAML, an import, or an older build's write-back can carry
    // more digits than the mutators write. Agreeing with the solve inside the
    // envelope, the authored spelling is the one that stays.
    const doc = makeDoc()
    const feat = doc.features!.find(f => f.id === 'sk1')!
    feat.initial = { line1: [0, 0, Math.PI, 0] }
    applyGeometryToFeature(doc, 'sk1', { line1: [0, 0, Math.fround(Math.PI), 0] })
    expect(feat.initial!.line1[2]).toBe(Math.PI)
  })

  it('installs the solved geometry when a component moved beyond the envelope', () => {
    const doc = makeDoc()
    const feat = doc.features!.find(f => f.id === 'sk1')!
    feat.initial = { line1: [0, 0, 25.7, 0] }
    applyGeometryToFeature(doc, 'sk1', { line1: [0, 0, Math.fround(30), 0] })
    expect(feat.initial!.line1).toEqual([0, 0, 30, 0])
  })

  it('installs when any single component of any single entity moved', () => {
    // The keep is per component AND per entity: one entity outside the envelope
    // installs the whole map, so a half-matching solve is never half-installed.
    const doc = makeDoc()
    const feat = doc.features!.find(f => f.id === 'sk1')!
    feat.initial = { line1: [0, 0, 25, 0], proj1: [1, 1] }
    applyGeometryToFeature(doc, 'sk1', { line1: [0, 0, 25, 0], proj1: [5, 1] })
    expect(feat.initial).toEqual({ line1: [0, 0, 25, 0], proj1: [5, 1] })
  })

  it('installs when the entity id set changed, even with every shared component matching', () => {
    // A projected dimension or an added entity changes the map's shape, which
    // no amount of matching values can stand in for.
    const doc = makeDoc()
    const feat = doc.features!.find(f => f.id === 'sk1')!
    feat.initial = { line1: [0, 0, 25.7, 0] }
    applyGeometryToFeature(doc, 'sk1', { line1: [0, 0, Math.fround(25.7), 0], proj1: [1, 1] })
    expect(Object.keys(feat.initial!)).toEqual(['line1', 'proj1'])
  })

  it('installs when the solve dropped an entity the doc still carries', () => {
    const doc = makeDoc()
    const feat = doc.features!.find(f => f.id === 'sk1')!
    feat.initial = { line1: [0, 0, 25.7, 0], proj1: [1, 1] }
    applyGeometryToFeature(doc, 'sk1', { line1: [0, 0, Math.fround(25.7), 0] })
    expect(Object.keys(feat.initial!)).toEqual(['line1'])
  })

  it('installs when an entity came back with a different arity', () => {
    // A point lowering to a line (2 params to 4) is a different entity, not a
    // moved one, so a length mismatch can never read as "within tolerance".
    const doc = makeDoc()
    const feat = doc.features!.find(f => f.id === 'sk1')!
    feat.initial = { line1: [0, 0] }
    applyGeometryToFeature(doc, 'sk1', { line1: [0, 0, Math.fround(25.7), 0] })
    expect(feat.initial!.line1).toEqual([0, 0, 25.700001, 0])
  })

  it('keeps the existing array when both sides are empty', () => {
    const doc = makeDoc()
    const feat = doc.features!.find(f => f.id === 'sk1')!
    feat.initial = {}
    const before = feat.initial
    applyGeometryToFeature(doc, 'sk1', {})
    expect(feat.initial).toBe(before)
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
    const before = structuredClone(doc)
    applyRemoveDanglingContent(doc, { missing: { entities: ['x'], constraints: ['y'] } })
    expect(doc).toEqual(before)
    expect(doc.features).toHaveLength(2)
  })

  it('tolerates a feature that carries no entities or constraints arrays', () => {
    // A non-sketch feature (an extrude) has neither list; the cleanup must
    // treat it as having nothing removable rather than throwing.
    const doc = makeDoc()
    const before = structuredClone(doc)
    applyRemoveDanglingContent(doc, { ex1: { entities: ['x'], constraints: ['y'] } })
    expect(doc).toEqual(before)
    expect(doc.features!.find(f => f.id === 'ex1')!.initial).toBeUndefined()
  })

  it('no-ops when the doc has no features array', () => {
    const doc = { version: 1, kind: 'part' } as PartDoc
    const before = structuredClone(doc)
    applyRemoveDanglingContent(doc, { sk1: { entities: ['x'], constraints: ['y'] } })
    expect(doc).toEqual(before)
    expect(doc.features).toBeUndefined()
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

  it('is false for a feature that carries no entities or constraints arrays', () => {
    const doc = makeDoc()
    expect(hasDanglingContentInDoc(doc, { ex1: { entities: ['x'], constraints: ['y'] } })).toBe(false)
  })

  it('is false when the doc has no features array', () => {
    const doc = { version: 1, kind: 'part' } as PartDoc
    expect(hasDanglingContentInDoc(doc, { sk1: { entities: ['x'], constraints: ['y'] } })).toBe(false)
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
