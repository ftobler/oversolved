// The naming scheme every user-facing sentence reads: a thing is named by its
// kind and ordinal ("line 3", "coincident 4", "sketch 2") or by the author's
// label, never by its id.
import { describe, expect, it } from 'vitest'
import {
  constraintDisplayName,
  entityDisplayName,
  entityKindPhrase,
  featureDisplayName,
  positionWord,
  sketchDisplayName,
} from '../displayNames'

const sketch = {
  id: 'sk9',
  kind: 'sketch',
  label: 'Profile',
  entities: [
    { id: 'ln_a', kind: 'line' },
    { id: 'ci_b', kind: 'circle' },
    { id: 'ln_c', kind: 'line' },
    { id: 'ln_d', kind: 'line' },
  ],
  constraints: [
    { id: 'c_h1', kind: 'horizontal' },
    { id: 'c_c1', kind: 'coincident' },
    { id: 'c_c2', kind: 'coincident' },
    { id: 'c_h2', kind: 'horizontal' },
  ],
}

describe('entityDisplayName', () => {
  it('numbers each kind by its own document order', () => {
    expect(entityDisplayName(sketch, 'ln_a')).toBe('line 1')
    expect(entityDisplayName(sketch, 'ln_c')).toBe('line 2')
    expect(entityDisplayName(sketch, 'ln_d')).toBe('line 3')
    expect(entityDisplayName(sketch, 'ci_b')).toBe('circle 1')
  })

  it('returns null for a row the sketch does not hold', () => {
    expect(entityDisplayName(sketch, 'nope')).toBeNull()
    expect(entityDisplayName(undefined, 'ln_a')).toBeNull()
  })

  it('uses the registry kind word, never the raw kind spelling', () => {
    const fit = { entities: [{ id: 'f1', kind: 'fit_spline' }] }
    expect(entityDisplayName(fit, 'f1')).toBe('spline 1')
  })

  it('keeps the article rule for a kind phrase', () => {
    expect(entityKindPhrase('line')).toBe('a line')
    expect(entityKindPhrase('arc')).toBe('an arc')
    expect(entityKindPhrase('not_a_kind')).toBeNull()
  })
})

describe('constraintDisplayName', () => {
  it('numbers each constraint kind by its own document order', () => {
    expect(constraintDisplayName(sketch, 'c_h1')).toBe('horizontal 1')
    expect(constraintDisplayName(sketch, 'c_c1')).toBe('coincident 1')
    expect(constraintDisplayName(sketch, 'c_c2')).toBe('coincident 2')
    expect(constraintDisplayName(sketch, 'c_h2')).toBe('horizontal 2')
  })

  it('returns null for a row the authored list does not hold', () => {
    expect(constraintDisplayName(sketch, 'c_missing')).toBeNull()
    expect(constraintDisplayName(undefined, 'c_h1')).toBeNull()
  })
})

describe('positionWord', () => {
  it('words the first ten and builds a real ordinal after them', () => {
    expect(positionWord(0)).toBe('first')
    expect(positionWord(9)).toBe('tenth')
    expect(positionWord(10)).toBe('11th')
    expect(positionWord(11)).toBe('12th')
    expect(positionWord(12)).toBe('13th')
    expect(positionWord(20)).toBe('21st')
    expect(positionWord(21)).toBe('22nd')
    expect(positionWord(22)).toBe('23rd')
    expect(positionWord(100)).toBe('101st')
    expect(positionWord(110)).toBe('111th')
  })
})

describe('featureDisplayName', () => {
  const features = [
    { id: 'sk1', kind: 'sketch', label: 'Base' },
    { id: 'ex1', kind: 'extrude' },
    { id: 'sk2', kind: 'sketch' },
  ]

  it('uses the author label when the feature has one', () => {
    expect(featureDisplayName(features[0], features)).toBe("sketch 'Base'")
  })

  it('suppresses a label that only repeats the kind word', () => {
    // The add commands bake a default label like `Sweep` or `Move Face`; it says
    // nothing the kind ordinal does not. The raw kind spelling with an ordinal
    // (`move_face 3`) is the same. Deliberate labels survive: a different case
    // (`SKETCH`) or a user-typed ordinal (`Sweep 7`) is not the default shape.
    const rows = [
      { id: 'sk1', kind: 'sketch', label: 'SKETCH' },
      { id: 'sw1', kind: 'sweep', label: 'Sweep' },
      { id: 'pl1', kind: 'plane', label: 'Plane' },
      { id: 'mf1', kind: 'move_face', label: 'move_face 3' },
      { id: 'lp1', kind: 'linear_pattern', label: 'linear_pattern 1' },
      { id: 'lp2', kind: 'linear_pattern', label: 'Linear Pattern 4' },
      { id: 'sw2', kind: 'sweep', label: 'Sweep 7' },
    ]
    expect(featureDisplayName(rows[0], rows)).toBe("sketch 'SKETCH'")
    expect(featureDisplayName(rows[1], rows)).toBe('sweep 1')
    expect(featureDisplayName(rows[2], rows)).toBe('plane 1')
    expect(featureDisplayName(rows[3], rows)).toBe('move face 1')
    expect(featureDisplayName(rows[4], rows)).toBe('linear pattern 1')
    // The toolbar writes the title-cased prefix into the generated label.
    expect(featureDisplayName(rows[5], rows)).toBe('linear pattern 2')
    expect(featureDisplayName(rows[6], rows)).toBe("sweep 'Sweep 7'")
    // A name that is not the kind word survives, even next to the kind.
    const named = [{ id: 'sk1', kind: 'sketch', label: 'Sketch of the base' }]
    expect(featureDisplayName(named[0], named)).toBe("sketch 'Sketch of the base'")
  })

  it('falls back to the kind and its ordinal among that kind', () => {
    expect(featureDisplayName(features[2], features)).toBe('sketch 2')
    expect(featureDisplayName(features[1], features)).toBe('extrude 1')
  })

  it('falls back to the kind alone when the list is not in hand', () => {
    expect(featureDisplayName({ id: 'sk7', kind: 'sketch' })).toBe('the sketch')
  })

  it('says part for a stored delete_body row', () => {
    expect(featureDisplayName({ id: 'd1', kind: 'delete_body' })).toBe('the delete part')
  })

  it('names a sketch from its id and the ordered rows', () => {
    expect(sketchDisplayName('sk2', features)).toBe('sketch 2')
    expect(sketchDisplayName('sk9', features)).toBe('the sketch')
  })
})
