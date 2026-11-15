// The version-9 split of the retired `pattern` kind: every old mode lands on the
// kind and field names the table in feature/pattern-split-linear-circular.md
// names, the feature id is kept, the migration is idempotent, and a document
// that still names the retired kind is reported by name by the solver gate.
// The boundary checks the new kinds kept from the old loader are here too.
import { describe, it, expect } from 'vitest'
import { CURRENT_DOC_VERSION, loadPartDoc, migrate } from '@/persistence/docSchema'
import { FEATURE_SCHEMA_BY_KIND, featureParamsSchema } from '@/persistence/partDocSchema'
import { getSolver, isDocFullyPorted, unportedKinds } from '@/kernel/solverRegistry'

function legacyDoc(pattern: unknown, version?: number): Record<string, unknown> {
  return {
    ...(version === undefined ? {} : { version }),
    kind: 'part',
    features: [{ id: 'pt1', kind: 'pattern', label: 'Pattern', pattern }],
  }
}

function loadedFeature(doc: unknown): Record<string, unknown> {
  const result = loadPartDoc(doc)
  expect(result.ok, JSON.stringify(!result.ok ? result.error : null)).toBe(true)
  if (!result.ok) throw new Error('load failed')
  return (result.doc.features as Record<string, unknown>[])[0]
}

function migratedDef(pattern: unknown): { kind: string; def: Record<string, unknown> } {
  const feature = loadedFeature(legacyDoc(pattern))
  const kind = feature.kind as string
  return { kind, def: feature[kind] as Record<string, unknown> }
}

describe('the version-9 pattern split', () => {
  it('is the ladder current version', () => {
    expect(CURRENT_DOC_VERSION).toBe(9)
  })

  it('migrates a linear pattern 1:1 and keeps the feature id', () => {
    const feature = loadedFeature(legacyDoc({
      subject: 'body', source_body: '@b1', mode: 'linear', count: 3, pitch: 10,
      direction: [1, 0, 0], invert: true, centered: true, skip: [1],
    }))
    expect(feature.id).toBe('pt1')
    expect(feature.kind).toBe('linear_pattern')
    expect(feature.linear_pattern).toEqual({
      subject: 'body', source_body: '@b1', count: 3, pitch: 10,
      direction: [1, 0, 0], invert: true, centered: true, skip: [1],
    })
    expect(feature).not.toHaveProperty('pattern')
  })

  it('migrates a rectangular grid to direction 1 plus second_direction', () => {
    const { kind, def } = migratedDef({
      subject: 'body', source_body: '@b1', mode: 'rectangular',
      count_x: 3, pitch_x: 5, direction_x_query: '@sk_dir/lx', invert_x: true, centered_x: true,
      count_y: 2, pitch_y: 6, direction_y: [0, 1, 0], invert_y: true, centered_y: false,
      skip: [[1, 0], [0, 1]],
    })
    expect(kind).toBe('linear_pattern')
    expect(def).toEqual({
      subject: 'body', source_body: '@b1', second_direction: true,
      count: 3, pitch: 5, direction_query: '@sk_dir/lx', invert: true, centered: true,
      count_2: 2, pitch_2: 6, direction_2: [0, 1, 0], invert_2: true, centered_2: false,
      skip: [[1, 0], [0, 1]],
    })
  })

  it('ignores the one-axis fields a rectangular row never read', () => {
    // The old rectangular mode read `_x`/`_y` only; a stray `centered`, `pitch`
    // or `direction` beside them must not turn the grid centered or move it.
    const { def } = migratedDef({
      subject: 'body', source_body: '@b1', mode: 'rectangular',
      count_x: 2, count_y: 2, pitch_x: 5, pitch_y: 6,
      centered: true, pitch: 99, direction: [0, 0, 1],
    })
    expect(def).toEqual({
      subject: 'body', source_body: '@b1', second_direction: true,
      count: 2, count_2: 2, pitch: 5, pitch_2: 6,
    })
  })

  it('turns an evenly spaced circular pattern into a full, equal-spaced turn', () => {
    const { kind, def } = migratedDef({
      subject: 'body', source_body: '@b1', mode: 'circular', count: 4,
      axis: '@sk_axis/c1', invert_axis: true, centered: true,
    })
    expect(kind).toBe('circular_pattern')
    expect(def).toEqual({
      subject: 'body', source_body: '@b1', count: 4, axis: '@sk_axis/c1',
      invert_axis: true, centered: true, angle: 360, equal_spacing: true,
    })
  })

  it('turns an explicit step_angle into the increment form', () => {
    const { kind, def } = migratedDef({
      subject: 'feature', source_features: ['@ex1', '@rv1'], mode: 'circular', count: 4, step_angle: 30,
    })
    expect(kind).toBe('circular_pattern')
    expect(def).toMatchObject({ angle: 30, equal_spacing: false, source_features: ['@ex1', '@rv1'] })
  })

  it('folds the singular source before the split, so the new row holds the list', () => {
    const result = loadPartDoc(legacyDoc({ subject: 'feature', source_feature: '@ex1', count: 3, pitch: 20 }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.migrations).toEqual(['pattern-source-features', 'pattern-split'])
    const feature = (result.doc.features as Record<string, unknown>[])[0]
    expect(feature.kind).toBe('linear_pattern')
    expect(feature.linear_pattern).toMatchObject({ source_features: ['@ex1'] })
    expect(feature.linear_pattern).not.toHaveProperty('source_feature')
  })

  it('drops the retired include_source flag', () => {
    const feature = loadedFeature(legacyDoc({
      subject: 'body', source_body: '@b1', count: 3, include_source: false,
    }))
    expect(feature.linear_pattern).not.toHaveProperty('include_source')
  })

  it('keeps only whole-number skip entries on a circular row', () => {
    const { def } = migratedDef({
      subject: 'body', source_body: '@b1', mode: 'circular', count: 4, skip: [1, [2, -1]],
    })
    // A grid cell names a grid a circular pattern does not have, so the split
    // drops it rather than storing an entry that can never match.
    expect(def.skip).toEqual([1])
  })

  it('is a no-op the second time', () => {
    const doc = legacyDoc({ subject: 'body', source_body: '@b1', mode: 'rectangular', count_x: 2, count_y: 2 })
    expect(migrate(doc, 0)).toContain('pattern-split')
    const once = JSON.stringify(doc)
    expect(migrate(doc, CURRENT_DOC_VERSION)).toEqual([])
    expect(JSON.stringify(doc)).toBe(once)
  })

  it('reports a version-9 document that still names the retired kind', () => {
    const result = loadPartDoc(legacyDoc({ subject: 'body', source_body: '@b1', count: 2 }, CURRENT_DOC_VERSION))
    // The loader is forward-tolerant, so the row loads; the solver gate is what
    // names it, and no solver answers to the retired kind.
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const features = result.doc.features as Array<{ kind?: unknown }>
    expect(unportedKinds(features)).toEqual(new Set(['pattern']))
    expect(isDocFullyPorted(features)).toBe(false)
    expect(getSolver('pattern')).toBeNull()
    expect(result.migrations).not.toContain('pattern-split')
  })
})

describe('the split kinds boundary checks', () => {
  function doc(kind: string, sub: unknown): Record<string, unknown> {
    return { version: CURRENT_DOC_VERSION, kind: 'part', features: [{ id: 'pt1', kind, [kind]: sub }] }
  }

  it('accepts count 1 and a 1x1 grid, the quiet no-ops', () => {
    expect(loadPartDoc(doc('linear_pattern', { subject: 'body', source_body: '@b1', count: 1 })).ok).toBe(true)
    expect(loadPartDoc(doc('linear_pattern', {
      subject: 'body', source_body: '@b1', second_direction: true, count: 1, count_2: 1,
    })).ok).toBe(true)
    expect(loadPartDoc(doc('circular_pattern', { subject: 'body', source_body: '@b1', count: 1 })).ok).toBe(true)
  })

  it('refuses a count the solve cannot use', () => {
    for (const count of [0, -2, 2.5]) {
      const result = loadPartDoc(doc('linear_pattern', { subject: 'body', source_body: '@b1', count }))
      expect(result.ok, String(count)).toBe(false)
      if (result.ok) continue
      expect(result.error.field).toBe('features[0].linear_pattern.count')
    }
  })

  it('refuses a negative circular angle and names the axis route', () => {
    const result = loadPartDoc(doc('circular_pattern', { subject: 'body', source_body: '@b1', angle: -30 }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.field).toBe('features[0].circular_pattern.angle')
  })

  it('refuses a grid cell in a circular skip list', () => {
    const result = loadPartDoc(doc('circular_pattern', { subject: 'body', source_body: '@b1', skip: [[1, 0]] }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.field).toBe('features[0].circular_pattern.skip')
      expect(result.error.message).toContain('grid')
    }
  })

  it('refuses a skip entry naming the original or a non-integer', () => {
    const zero = loadPartDoc(doc('linear_pattern', { subject: 'body', source_body: '@b1', skip: [0] }))
    expect(zero.ok).toBe(false)
    if (!zero.ok) {
      expect(zero.error.field).toBe('features[0].linear_pattern.skip')
      expect(zero.error.message).toContain('original')
    }
    const seedCell = loadPartDoc(doc('linear_pattern', { subject: 'body', source_body: '@b1', skip: [[0, 0]] }))
    expect(seedCell.ok).toBe(false)
    if (!seedCell.ok) expect(seedCell.error.message).toContain('original')
  })

  it('refuses a non-string source and a malformed direction', () => {
    const source = loadPartDoc(doc('linear_pattern', { subject: 'feature', source_feature: 5 }))
    expect(source.ok).toBe(false)
    if (!source.ok) expect(source.error.field).toBe('features[0].linear_pattern.source_feature')

    const list = loadPartDoc(doc('linear_pattern', { subject: 'feature', source_features: '@ex1' }))
    expect(list.ok).toBe(false)
    if (!list.ok) expect(list.error.field).toBe('features[0].linear_pattern.source_features')

    const direction = loadPartDoc(doc('linear_pattern', {
      subject: 'feature', source_features: ['@ex1'], direction: [1, 0],
    }))
    expect(direction.ok).toBe(false)
    if (!direction.ok) expect(direction.error.field).toBe('features[0].linear_pattern.direction')
  })

  it('publishes the params under each kind key with a feature-ref pattern', () => {
    for (const kind of ['linear_pattern', 'circular_pattern'] as const) {
      const schema = FEATURE_SCHEMA_BY_KIND[kind]
      expect(schema.additionalProperties).toBe(false)
      const properties = schema.properties as Record<string, unknown>
      expect(properties).toHaveProperty(kind)
      expect(properties).not.toHaveProperty('source_feature')
      const params = featureParamsSchema(kind)!
      const source = (params.properties as Record<string, Record<string, unknown>>).source_features
      const pattern = new RegExp((source.items as Record<string, unknown>).pattern as string)
      expect(pattern.test('$ex1')).toBe(false)
      expect(pattern.test('@ex1')).toBe(true)
    }
  })
})
