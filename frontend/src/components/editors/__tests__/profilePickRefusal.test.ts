/**
 * A profile pick means "what this curve encloses", so a click on an entity that
 * can never close on its own is refused at the chip instead of being stored for
 * the build to reject. The same rule names the entity in the build's refusal:
 * a kind word and a per-kind ordinal, never the document id.
 */
import { describe, it, expect } from 'vitest'
import {
  EXTRUDE_SCHEMA,
  REVOLVE_SCHEMA,
  SWEEP_SCHEMA,
  WRAP_SCHEMA,
} from '@/components/editors/featureEditorSchemas'
import { profilePickRefusal } from '@/components/editors/featureEditorSchemas'
import { entityDisplayName } from '@/kernel/features/shared/partRef'
import type { PickFieldDef } from '@/components/editors/widgets/fieldTypes'
import { makeAncestryQuery } from '@/kernel/query'
import type { PartFeature } from '@/types/cad'

const SKETCH = {
  id: 'sk1',
  kind: 'sketch',
  label: 'Sketch 1',
  plane: '@builtin_plane_front',
  entities: [
    { id: 'l1', kind: 'line' },
    { id: 'c1', kind: 'circle' },
    { id: 'l2', kind: 'line' },
    { id: 'a1', kind: 'arc' },
    { id: 'e1', kind: 'ellipse' },
    { id: 'p1', kind: 'point' },
    { id: 's1', kind: 'spline' },
    { id: 'f1', kind: 'fit_spline' },
    { id: 'l3', kind: 'line' },
  ],
} as unknown as PartFeature

const FEATURES: PartFeature[] = [SKETCH]

function refusal(selectionId: string): string | null {
  return profilePickRefusal(selectionId, FEATURES)
}

/** The one entity of a `?` area query, the form a fill click stores. */
function areaOf(eids: string[]): string {
  return makeAncestryQuery([...eids.map((eid) => `@sk1/${eid}`), 'surface:0', '@sk1'], 'flatface')
}

function fieldOf(schema: { fields: unknown[] }, key: string): PickFieldDef {
  const field = schema.fields.find(
    (candidate): candidate is PickFieldDef =>
      (candidate as PickFieldDef).type === 'pick' && (candidate as PickFieldDef).key === key,
  )
  if (field === undefined) throw new Error(`no pick field '${key}'`)
  return field
}

describe('profilePickRefusal', () => {
  it('refuses a line, an arc and a point with their own kind word', () => {
    // The reason names what was clicked, so the user reads why this curve is
    // not a profile instead of a claim about the feature.
    expect(refusal('entity:sk1:l1')).toContain('a line has no area of its own')
    expect(refusal('entity:sk1:a1')).toContain('an arc has no area of its own')
    expect(refusal('entity:sk1:p1')).toContain('a point has no area of its own')
    for (const id of ['l1', 'a1', 'p1']) {
      expect(refusal(`entity:sk1:${id}`)).toContain('pick the area beside it, or a closed curve such as a circle')
    }
  })

  it('accepts the kinds that close or may close', () => {
    // A circle and an ellipse always enclose an area; a spline closes when its
    // ends are coincident, which is a solve fact, so the build stays the judge.
    for (const id of ['c1', 'e1', 's1', 'f1']) {
      expect(refusal(`entity:sk1:${id}`)).toBeNull()
    }
  })

  it('refuses a `?` area pick that narrows to one open entity', () => {
    // Clicking the fill beside a lone curve is the same gesture as clicking the
    // curve when only one entity bounds the region.
    expect(refusal(areaOf(['l1']))).toContain('a line has no area of its own')
    expect(refusal(areaOf(['a1']))).toContain('an arc has no area of its own')
  })

  it('reads a vertex pick as the entity that owns the vertex', () => {
    // A vertex pick names the curve it sits on, so a line endpoint is the line
    // gesture and not an unnamed point: it must be refused the same way.
    expect(refusal('vertex:sk1:l1:start')).toContain('a line has no area of its own')
    expect(refusal('vertex:sk1:a1:center')).toContain('an arc has no area of its own')
    expect(refusal('vertex:sk1:c1:center')).toBeNull()
  })

  it('accepts a `?` area pick of a region and a whole-sketch ref', () => {
    expect(refusal(areaOf(['l1', 'l2', 'l3']))).toBeNull()
    expect(refusal('@sk1')).toBeNull()
    expect(refusal('?9;@builtin_plane_front:flatface')).toBeNull()
  })

  it('keeps every document id out of the sentence', () => {
    // Every entity in the fixture, refused or not: a sentence that comes back
    // must not name the sketch or any entity, including the ones it did not
    // refuse.
    const ids = ['sk1', 'l1', 'c1', 'l2', 'a1', 'e1', 'p1', 's1', 'f1', 'l3']
    for (const eid of ids.slice(1)) {
      const reason = refusal(`entity:sk1:${eid}`)
      if (reason === null) continue
      for (const id of ids) expect(reason, `${eid}: ${id}`).not.toContain(id)
    }
    expect(refusal(`vertex:sk1:l1:start`)).not.toContain('sk1')
  })

  it('lets the pick through when the feature list is not supplied', () => {
    // The rule can only look an entity up in the document, the same limit the
    // build-order guard has.
    expect(profilePickRefusal('entity:sk1:l1')).toBeNull()
  })
})

describe('profile field wiring', () => {
  it('all four profile fields carry the rule', () => {
    // Extrude, revolve, sweep profile and wrap: the four picks that name a
    // profile area.
    expect(fieldOf(EXTRUDE_SCHEMA, 'sketch').validatePick).toBe(profilePickRefusal)
    expect(fieldOf(REVOLVE_SCHEMA, 'sketch').validatePick).toBe(profilePickRefusal)
    expect(fieldOf(SWEEP_SCHEMA, 'sketch').validatePick).toBe(profilePickRefusal)
    expect(fieldOf(WRAP_SCHEMA, 'sketch').validatePick).toBe(profilePickRefusal)
  })

  it('the sweep Path field keeps accepting a line or an arc', () => {
    // A path is a curve to follow, not an area: the profile rule would refuse
    // exactly what a sweep path wants.
    expect(fieldOf(SWEEP_SCHEMA, 'path').validatePick).toBeUndefined()
  })
})

describe('entityDisplayName', () => {
  const sketch = {
    id: 'sk9',
    kind: 'sketch',
    label: 'Sketch 9',
    entities: [
      { id: 'ln_a', kind: 'line' },
      { id: 'ci_b', kind: 'circle' },
      { id: 'ln_c', kind: 'line' },
      { id: 'ln_d', kind: 'line' },
      { id: 'ar_e', kind: 'arc' },
    ],
  } as unknown as PartFeature

  it('names an entity by its kind and per-kind ordinal in document order', () => {
    // The ordinal is the 1-based position among the entities OF THAT KIND, so a
    // circle between two lines never renumbers the lines.
    expect(entityDisplayName(sketch, 'ln_a')).toBe('line 1')
    expect(entityDisplayName(sketch, 'ln_c')).toBe('line 2')
    expect(entityDisplayName(sketch, 'ln_d')).toBe('line 3')
    expect(entityDisplayName(sketch, 'ci_b')).toBe('circle 1')
    expect(entityDisplayName(sketch, 'ar_e')).toBe('arc 1')
  })

  it('counts a projected entity as its base kind', () => {
    // A projection is a base-kind entity carrying a `source` query, not a
    // distinct kind, so it takes a number in the line sequence. Deliberate:
    // the ordinal counts what the user sees in the sketch, and the tree shows
    // the projected line like any other line.
    const projected = {
      id: 'skp',
      kind: 'sketch',
      entities: [
        { id: 'pl_one', kind: 'line', source: '?9;@body_ex1:edge' },
        { id: 'dl_two', kind: 'line' },
      ],
    } as unknown as PartFeature
    expect(entityDisplayName(projected, 'pl_one')).toBe('line 1')
    expect(entityDisplayName(projected, 'dl_two')).toBe('line 2')
  })

  it('returns null for an entity the sketch does not have', () => {
    expect(entityDisplayName(sketch, 'nope')).toBeNull()
  })

  it('does not print the id it was given', () => {
    for (const eid of ['ln_a', 'ci_b', 'ln_c', 'ln_d', 'ar_e']) {
      expect(entityDisplayName(sketch, eid)).not.toContain(eid)
    }
  })
})
