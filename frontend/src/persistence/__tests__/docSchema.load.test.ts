// Golden loads and field-level failures for the document boundary. The golden
// fixtures are the historical shapes the ladder exists for; the failure cases
// pin that a bad file is refused by name and field instead of reaching a
// builder.
import { describe, it, expect } from 'vitest'
import {
  CURRENT_DOC_VERSION,
  docLoadErrorMessage,
  docVersion,
  loadAssemblyDocText,
  loadDocText,
  loadPartDoc,
  loadPartDocText,
  migrate,
  MAX_ARRAY_CELLS,
  MAX_ARRAY_COUNT,
  MAX_FEATURES,
} from '@/persistence/docSchema'
import {
  ALL_HISTORICAL_ASSEMBLY_DOCS,
  ALL_HISTORICAL_PART_DOCS,
  CURRENT_V3_PART,
  LEGACY_V0_PART,
  LEGACY_V1_PART,
} from '@/persistence/__fixtures__/historicalDocs'

describe('golden documents load and migrate', () => {
  for (const fixture of ALL_HISTORICAL_PART_DOCS) {
    it(`loads ${fixture.name}: ${fixture.note}`, () => {
      const result = loadPartDocText(fixture.text, { name: fixture.name })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.doc).toMatchSnapshot()
      expect(result.migrations).toMatchSnapshot()
    })
  }

  for (const fixture of ALL_HISTORICAL_ASSEMBLY_DOCS) {
    it(`loads ${fixture.name}: ${fixture.note}`, () => {
      const result = loadAssemblyDocText(fixture.text, { name: fixture.name })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.doc).toMatchSnapshot()
      expect(result.migrations).toMatchSnapshot()
    })
  }

  it('heals every pre-versioning shape in the oldest fixture', () => {
    const result = loadPartDocText(LEGACY_V0_PART.text, { name: LEGACY_V0_PART.name })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.migrations).toEqual([
      'drop-dead-axis-constraints',
      'plural-body-picks',
      'drop-redundant-inline-step-payload',
    ])
    interface SeenFeature {
      constraints?: Array<{ id: string }>
      transform?: { bodies?: string[]; body?: string }
      delete_body?: { bodies?: string[]; body?: string }
      file_id?: string
      file_data?: string
    }
    const features = result.doc.features as unknown as SeenFeature[]
    expect(features[0].constraints!.map(c => c.id)).toEqual(['c_ok'])
    expect(features[1].transform!.bodies).toEqual(['@body_ex1'])
    expect('body' in features[1].transform!).toBe(false)
    expect(features[2].delete_body!.bodies).toEqual(['@body_ex1'])
    expect('body' in features[2].delete_body!).toBe(false)
    expect('file_data' in features[3]).toBe(false)
    expect(features[3].file_id).toBe('file-abc')
  })

  it('does not skip the heals for a version-stamped legacy document', () => {
    const result = loadPartDocText(LEGACY_V1_PART.text, { name: LEGACY_V1_PART.name })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.migrations).toEqual(['plural-body-picks'])
    const transform = (result.doc.features as Array<{ transform: { bodies: string[] } }>)[0].transform
    expect(transform.bodies).toEqual(['@body_ex2'])
  })

  it('is idempotent: reloading a migrated doc applies nothing', () => {
    const first = loadPartDocText(LEGACY_V0_PART.text)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = loadPartDoc(first.doc)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.migrations).toEqual([])
    expect(second.doc).toEqual(first.doc)
  })

  it('reads empty text as the empty document an editor starts from', () => {
    const result = loadPartDocText('')
    expect(result).toEqual({ ok: true, doc: {}, migrations: [] })
  })
})

describe('the version gate', () => {
  // A stale singular body pick, the shape the plural-body-picks step heals.
  const staleBodyPick = () => ({
    features: [{ id: 't1', kind: 'transform', transform: { body: '@body_ex1' } }],
  })

  it('runs a step for a document behind its target version', () => {
    const doc = staleBodyPick()
    expect(migrate(doc, 1)).toEqual(['plural-body-picks'])
    expect((doc.features[0].transform as { bodies?: string[] }).bodies).toEqual(['@body_ex1'])
  })

  it('skips every step at the current version, stale keys included', () => {
    // The stamp is the document's promise that it is already current; the
    // ladder does not second-guess it, even when a healable-looking key sits
    // in the payload. Nothing in this app writes the stamp, so this boundary
    // only arises for a document another writer stamped.
    const doc = staleBodyPick()
    expect(migrate(doc, CURRENT_DOC_VERSION)).toEqual([])
    expect((doc.features[0].transform as { body?: string }).body).toBe('@body_ex1')
  })

  it('the current-version fixture is stamped at CURRENT_DOC_VERSION', () => {
    const result = loadPartDocText(CURRENT_V3_PART.text, { name: CURRENT_V3_PART.name })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(docVersion(result.doc)).toBe(CURRENT_DOC_VERSION)
    expect(result.migrations).toEqual([])
  })
})

describe('loadDocText routes by the entry kind', () => {
  it('sends an assembly entry to the assembly checks and everything else to the part checks', () => {
    expect(loadDocText('kind: assembly\nfeatures: []', 'assembly').ok).toBe(true)
    expect(loadDocText('kind: part\nfeatures: []', 'part').ok).toBe(true)
    expect(loadDocText('features: []', undefined).ok).toBe(true)
    // A stamped kind the part checks would refuse is the mismatch the routing
    // exists to surface, not a payload the entry kind may override.
    const mismatch = loadDocText('kind: assembly\nfeatures: []', undefined)
    expect(mismatch.ok).toBe(false)
    if (!mismatch.ok) expect(mismatch.error.field).toBe('kind')
  })
})

describe('kind is checked against the loader', () => {
  it('a part loader refuses an assembly document by kind', () => {
    const result = loadPartDoc({ kind: 'assembly', features: [] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('kind')
  })

  it('an assembly loader refuses a part document by kind', () => {
    const result = loadAssemblyDocText('kind: part\nfeatures: []')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('kind')
  })

  it('refuses an unsupported stamped kind', () => {
    const result = loadPartDocText('kind: drawing\nfeatures: []')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('kind')
  })

  it('accepts a kind-less part payload', () => {
    const result = loadPartDocText('features: []')
    expect(result.ok).toBe(true)
  })
})

describe('shape failures name the document and the field', () => {
  const partWith = (feature: Record<string, unknown>) =>
    loadPartDoc({ version: 1, kind: 'part', features: [feature] }, { name: 'Broken Bracket' })

  it('rejects a non-mapping payload', () => {
    for (const raw of ['text', 3, [1, 2]]) {
      const result = loadPartDoc(raw, { name: 'Odd' })
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.error.field).toBe('document')
    }
  })

  it('rejects a feature without an id or kind', () => {
    const noId = partWith({ kind: 'sketch' })
    expect(noId.ok).toBe(false)
    if (!noId.ok) expect(noId.error.field).toBe('features[0].id')
    const noKind = partWith({ id: 'sk1' })
    expect(noKind.ok).toBe(false)
    if (!noKind.ok) expect(noKind.error.field).toBe('features[0].kind')
  })

  it('rejects NaN and Infinity numeric fields with the exact path', () => {
    const nan = partWith({ id: 'ex1', kind: 'extrude', extrude: { sketch: '@sk1', distance: NaN } })
    expect(nan.ok).toBe(false)
    if (!nan.ok) expect(nan.error.field).toBe('features[0].extrude.distance')
    const inf = partWith({ id: 't1', kind: 'transform', transform: { bodies: ['@b1'], scale: Infinity } })
    expect(inf.ok).toBe(false)
    if (!inf.ok) expect(inf.error.field).toBe('features[0].transform.scale')
  })

  it('rejects non-finite coordinate arrays', () => {
    const result = partWith({
      id: 'sk1',
      kind: 'sketch',
      initial: { line1: [0, 0, NaN, 0] },
      entities: [{ id: 'line1', kind: 'line' }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.field).toBe('features[0].initial.line1[2]')
  })

  it('accepts expression strings in numeric fields', () => {
    const result = partWith({ id: 'ex1', kind: 'extrude', extrude: { sketch: '@sk1', distance: '50 + 25' } })
    expect(result.ok).toBe(true)
  })

  it('carries the name, the field and the raw text in the report', () => {
    const result = loadPartDocText('features:\n  - id: ex1\n    kind: extrude\n    extrude:\n      distance: .nan\n', { name: 'Bracket' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.docName).toBe('Bracket')
    expect(result.error.field).toBe('features[0].extrude.distance')
    expect(result.error.rawText).toContain('distance: .nan')
    expect(docLoadErrorMessage(result.error)).toContain('"Bracket" at features[0].extrude.distance')
  })

  it('reports unparseable YAML without throwing', () => {
    const result = loadPartDocText('[unparseable', { name: 'Junk' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('document')
    expect(result.error.rawText).toBe('[unparseable')
  })
})

describe('constraint operands carry the real wire and dict forms', () => {
  const partWithConstraints = (constraints: Array<Record<string, unknown>>) =>
    loadPartDoc({
      version: 1,
      kind: 'part',
      features: [{
        id: 'sk1',
        kind: 'sketch',
        entities: [{ id: 'bottom', kind: 'line' }, { id: 'right', kind: 'line' }],
        constraints,
      }],
    }, { name: 'Operands' })

  it('accepts the dict operands the oracle recipes write', () => {
    const result = partWithConstraints([
      { id: 'c1', kind: 'coincident', a: { entity: 'bottom', point: 'end' }, b: { entity: 'right', point: 'start' } },
      { id: 'c2', kind: 'horizontal', target: { entity: 'bottom' } },
    ])
    expect(result.ok).toBe(true)
  })

  it('accepts string operands and the external_xy origin form', () => {
    const result = partWithConstraints([
      { id: 'c1', kind: 'coincident', a: '$bottomend', b: '@builtin_origin' },
      { id: 'c2', kind: 'coincident', a: '$bottomstart', b: { external_xy: [0, 0] } },
    ])
    expect(result.ok).toBe(true)
  })

  it('accepts an ngon member list of operands and the lowered role/ref list', () => {
    const result = partWithConstraints([
      { id: 'c1', kind: 'ngon', refs: ['$bottom', { entity: 'right' }], circle: '$bottom' },
      { id: 'c2', kind: 'ngon', refs: [{ role: 'a', ref: { entity: 'bottom' } }] },
    ])
    expect(result.ok).toBe(true)
  })

  it('refuses malformed operands by field', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ id: 'c1', kind: 'coincident', a: { entity: 5 } }, 'features[0].constraints[0].a.entity'],
      [{ id: 'c1', kind: 'coincident', a: { point: 'start' } }, 'features[0].constraints[0].a.entity'],
      [{ id: 'c1', kind: 'coincident', a: { external_xy: [0] } }, 'features[0].constraints[0].a.external_xy'],
      [{ id: 'c1', kind: 'coincident', a: { entity: 'bottom', point: 'middle' } }, 'features[0].constraints[0].a.point'],
      [{ id: 'c1', kind: 'dock', point: '$bottomstart', host: 5 }, 'features[0].constraints[0].host'],
      [{ id: 'c1', kind: 'fixed', target: { entity: 'bottom' }, axis: 5 }, 'features[0].constraints[0].axis'],
      [{ id: 'c1', kind: 'ngon', refs: [{ role: 'a' }] }, 'features[0].constraints[0].refs[0].ref'],
      [{ id: 'c1', kind: 'ngon', refs: [{ ref: '$bottom' }] }, 'features[0].constraints[0].refs[0].role'],
    ]
    for (const [constraint, field] of cases) {
      const result = partWithConstraints([constraint])
      expect(result.ok, `${field} should be refused`).toBe(false)
      if (!result.ok) expect(result.error.field).toBe(field)
    }
  })
})

describe('hostile sizes are capped before the builder', () => {
  it('rejects an array count of 1e9 before it can expand', () => {
    const result = loadPartDoc({
      version: 1,
      kind: 'part',
      features: [{ id: 'a1', kind: 'array', array: { source_body: '@b1', count_x: 1e9 } }],
    }, { name: 'Hostile' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('features[0].array.count_x')
    expect(result.error.message).toContain(String(MAX_ARRAY_COUNT))
  })

  it('rejects an expression count that evaluates past the cap', () => {
    const result = loadPartDoc({
      version: 1,
      kind: 'part',
      features: [{ id: 'a1', kind: 'array', array: { count_x: '10 * 1e8' } }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.field).toBe('features[0].array.count_x')
  })

  it('rejects a count pair whose product would hang the worker', () => {
    const result = loadPartDoc({
      version: 1,
      kind: 'part',
      features: [{ id: 'a1', kind: 'array', array: { count_x: 900, count_y: 900 } }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain(String(MAX_ARRAY_CELLS))
  })

  it('rejects a sparse billion-entry features list without walking it', () => {
    const features: unknown[] = []
    features.length = 1e9
    const result = loadPartDoc({ kind: 'part', features }, { name: 'Sparse' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain(String(MAX_FEATURES))
  })

  it('rejects an oversized entities list without walking it', () => {
    const entities: unknown[] = []
    entities.length = 1e9
    const result = loadPartDoc({
      version: 1,
      kind: 'part',
      features: [{ id: 'sk1', kind: 'sketch', entities }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.field).toBe('features[0].entities')
  })

  it('tolerates unknown keys, deep nesting included', () => {
    let nested: Record<string, unknown> = {}
    const root = nested
    for (let i = 0; i < 100_000; i++) {
      nested.child = {}
      nested = nested.child as Record<string, unknown>
    }
    const result = loadPartDoc({ version: 1, kind: 'part', features: [], junk: root })
    expect(result.ok).toBe(true)
  })

  it('accepts unknown feature kinds, prototype names included', () => {
    const result = loadPartDoc({
      version: 1,
      kind: 'part',
      features: [{ id: 'x1', kind: '__proto__' }, { id: 'x2', kind: 'future_thing' }],
    })
    expect(result.ok).toBe(true)
  })

  it('accepts a count inside the cap', () => {
    const result = loadPartDoc({
      version: 1,
      kind: 'part',
      features: [{ id: 'a1', kind: 'array', array: { source_body: '@b1', count_x: 10, count_y: 5 } }],
    })
    expect(result.ok).toBe(true)
  })
})
