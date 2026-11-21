// The Source Features chip of every pattern kind. The bug this replaces was a
// hand-listed pair of kinds in the applier: the curve and instance patterns,
// added later, silently warned and no-opped. These cases iterate PATTERN_KINDS
// instead of spelling a kind; ADDERS below is a Record<PatternKind, ...>, so a
// fifth kind fails the type check until its add is registered here.
import { describe, it, expect } from 'vitest'
import {
  PATTERN_KINDS, patternSubOf,
  type PartDoc, type PartFeature, type PatternKind,
} from '@/types/cad'
import {
  applyAddCircularPattern, applyAddCurvePattern, applyAddInstancePattern, applyAddLinearPattern,
  applyAddMirrorSource, applyAddPatternSource, applyRemoveMirrorSource, applyRemovePatternSource,
  applyReorderPickField,
} from '@/utils/yamlMutations'
import { MutationRefusal } from '@/utils/yamlMutations/helpers'
import {
  PATTERN_SOURCE_KINDS, isPatternSourceKind, patternSourceKindSentence,
} from '@/kernel/features/patternSourceKinds'

type AddPattern = (doc: PartDoc, featureId: string, fields?: Record<string, unknown>) => void

const ADDERS: Record<PatternKind, AddPattern> = {
  linear_pattern: (doc, featureId, fields) => applyAddLinearPattern(doc, featureId, undefined, fields),
  circular_pattern: (doc, featureId, fields) => applyAddCircularPattern(doc, featureId, undefined, fields),
  // The path is the curve kind's own add argument, not a source row.
  curve_pattern: (doc, featureId, fields) => applyAddCurvePattern(doc, featureId, undefined, '', fields),
  instance_pattern: (doc, featureId, fields) => applyAddInstancePattern(doc, featureId, undefined, fields),
}

function subOf(doc: PartDoc, kind: PatternKind): Record<string, unknown> {
  const feature = doc.features?.find(f => f.id === 'pt1')
  const sub = patternSubOf(feature)
  if (sub === null) throw new Error(`no ${kind} sub-definition on the document`)
  return sub
}

function addFeature(kind: PatternKind, fields: Record<string, unknown> = {}): PartDoc {
  const doc: PartDoc = { features: [] }
  ADDERS[kind](doc, 'pt1', { subject: 'feature', ...fields })
  return doc
}

describe('patternSubOf', () => {
  it('answers null for a non-pattern, a missing payload and no feature', () => {
    expect(patternSubOf(undefined)).toBeNull()
    expect(patternSubOf({ id: 'ex1', kind: 'extrude', extrude: {} } as PartFeature)).toBeNull()
    // A loaded row can name a pattern kind without carrying its payload.
    expect(patternSubOf({ id: 'p1', kind: 'curve_pattern' } as unknown as PartFeature)).toBeNull()
  })
})

describe('pattern source appliers cover every PATTERN_KINDS entry', () => {
  it.each(PATTERN_KINDS)('%s toggles a source on and off', (kind) => {
    const doc = addFeature(kind, { source_features: ['@ex1'] })
    applyAddPatternSource(doc, 'pt1', '@rv1')
    expect(subOf(doc, kind).source_features).toEqual(['@ex1', '@rv1'])
    applyAddPatternSource(doc, 'pt1', '@ex1')
    expect(subOf(doc, kind).source_features).toEqual(['@rv1'])
    applyRemovePatternSource(doc, 'pt1', 0)
    expect(subOf(doc, kind).source_features).toEqual([])
    // An out-of-range remove leaves the list alone.
    applyRemovePatternSource(doc, 'pt1', 4)
    expect(subOf(doc, kind).source_features).toEqual([])
  })

  it.each(PATTERN_KINDS)('%s folds a legacy singular source in before the edit', (kind) => {
    const doc: PartDoc = {
      features: [{
        id: 'pt1', kind, [kind]: { subject: 'feature', source_feature: '@ex1' },
      } as unknown as PartFeature],
    }
    applyAddPatternSource(doc, 'pt1', '@ex2')
    const sub = subOf(doc, kind)
    expect(sub.source_features).toEqual(['@ex1', '@ex2'])
    expect(sub).not.toHaveProperty('source_feature')
  })

  it.each(PATTERN_KINDS)('%s reorders its source chips', (kind) => {
    const doc = addFeature(kind, { source_features: ['@ex1', '@rv1'] })
    applyReorderPickField(doc, 'pt1', 'source_features', 0, 1)
    expect(subOf(doc, kind).source_features).toEqual(['@rv1', '@ex1'])
  })

  it.each(PATTERN_KINDS)('%s refuses a source edit on a row without its definition', (kind) => {
    const doc: PartDoc = { features: [{ id: 'pt1', kind } as unknown as PartFeature] }
    expect(() => applyAddPatternSource(doc, 'pt1', '@ex1')).toThrow(MutationRefusal)
    expect(() => applyRemovePatternSource(doc, 'pt1', 0)).toThrow(MutationRefusal)
  })

  it('refuses a source edit on a feature that is not a pattern, by name', () => {
    const doc: PartDoc = {
      features: [{ id: 'ex1', kind: 'extrude', extrude: { sketch: [], distance: 5 } }],
    }
    const edit = () => applyAddPatternSource(doc, 'ex1', '@ex2')
    expect(edit).toThrow(MutationRefusal)
    expect(edit).toThrow(/not a pattern/)
    // The refusal names the row the caller asked about, not a silent absence.
    expect(edit).toThrow(/ex1/)
    expect(doc.features![0].kind).toBe('extrude')
  })

  it('refuses a source edit on a feature that does not exist', () => {
    expect(() => applyAddPatternSource({ features: [] }, 'pt9', '@ex1'))
      .toThrow(/pt9/)
  })
})

describe('a hole is a source like any other', () => {
  // The shared kind list is the one rule the kernel's tool table, the editor
  // chip and this applier pair read. A hole has no operation; its only meaning
  // is a cut, so it is admitted without an `operation` key on the row.
  it('names the hole in the one shared kind list', () => {
    expect(PATTERN_SOURCE_KINDS).toEqual(['extrude', 'revolve', 'sweep', 'wrap', 'hole'])
    expect(isPatternSourceKind('hole')).toBe(true)
    for (const kind of ['extrude', 'revolve', 'sweep', 'wrap']) expect(isPatternSourceKind(kind)).toBe(true)
    for (const kind of ['sketch', 'fillet', 'chamfer', 'mirror', 'linear_pattern', '']) {
      expect(isPatternSourceKind(kind), kind).toBe(false)
    }
    expect(patternSourceKindSentence('pattern')).toBe(
      'a feature pattern repeats an extrude, revolve, sweep, wrap or hole',
    )
    expect(patternSourceKindSentence('mirror')).toBe(
      'a mirror source repeats an extrude, revolve, sweep, wrap or hole',
    )
  })

  it.each(PATTERN_KINDS)('%s accepts a hole source row', (kind) => {
    const doc = addFeature(kind, { source_features: ['@ex1'] })
    applyAddPatternSource(doc, 'pt1', '@h1')
    expect(subOf(doc, kind).source_features).toEqual(['@ex1', '@h1'])
    // The row itself carries no operation: a hole is a cut by definition.
    expect(subOf(doc, kind)).not.toHaveProperty('operation')
  })

  it('the mirror accepts a hole source row', () => {
    const doc: PartDoc = {
      features: [{
        id: 'mi1', kind: 'mirror', mirror: { subject: 'feature', source_features: ['@ex1'] },
      } as unknown as PartFeature],
    }
    applyAddMirrorSource(doc, 'mi1', '@h1')
    const feature = doc.features![0]
    const sub = feature.kind === 'mirror' ? feature.mirror : undefined
    expect(sub?.source_features).toEqual(['@ex1', '@h1'])
  })
})

// The mirror keeps its sources under its own sub-dict, so it has its own
// applier pair: the same toggle, legacy fold and named refusal are what proves
// it was not left on the warn-only path the pattern appliers came from.
describe('the mirror source appliers match the pattern pair', () => {
  const mirror = (): PartDoc => ({
    features: [{
      id: 'mi1', kind: 'mirror', mirror: { subject: 'feature', source_feature: '@ex1' },
    } as unknown as PartFeature],
  })

  it('folds a legacy source and toggles one on and off', () => {
    const doc = mirror()
    applyAddMirrorSource(doc, 'mi1', '@ex2')
    const feature = doc.features![0]
    const sub = feature.kind === 'mirror' ? feature.mirror : undefined
    expect(sub?.source_features).toEqual(['@ex1', '@ex2'])
    applyAddMirrorSource(doc, 'mi1', '@ex1')
    const after = doc.features![0]
    const toggled = after.kind === 'mirror' ? after.mirror : undefined
    expect(toggled?.source_features).toEqual(['@ex2'])
    applyRemoveMirrorSource(doc, 'mi1', 0)
    const removed = doc.features![0]
    const final = removed.kind === 'mirror' ? removed.mirror : undefined
    expect(final?.source_features).toEqual([])
  })

  it('refuses a source edit on a feature that is not a mirror', () => {
    const doc: PartDoc = {
      features: [{ id: 'ex1', kind: 'extrude', extrude: { sketch: [], distance: 5 } }],
    }
    expect(() => applyAddMirrorSource(doc, 'ex1', '@ex2')).toThrow(MutationRefusal)
    expect(() => applyRemoveMirrorSource(doc, 'ex1', 0)).toThrow(/not a feature mirror/)
  })

  it('refuses a source edit on a mirror row without its definition', () => {
    const doc: PartDoc = { features: [{ id: 'mi1', kind: 'mirror' } as unknown as PartFeature] }
    expect(() => applyAddMirrorSource(doc, 'mi1', '@ex2')).toThrow(/has no mirror definition/)
  })

  it('reorders its source chips', () => {
    // The mirror chip is a multi pick, so it is draggable like the pattern's;
    // the reorder writes the mirror's own sub-dict.
    const doc: PartDoc = {
      features: [{
        id: 'mi1', kind: 'mirror', mirror: { subject: 'feature', source_features: ['@ex1', '@ex2'] },
      } as unknown as PartFeature],
    }
    applyReorderPickField(doc, 'mi1', 'source_features', 0, 1)
    const feature = doc.features![0]
    const sub = feature.kind === 'mirror' ? feature.mirror : undefined
    expect(sub?.source_features).toEqual(['@ex2', '@ex1'])
  })
})
