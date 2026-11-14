// Self-heal migration for documents authored before the transform/delete_body
// body pick was pluralized: the singular `body` key becomes a one-element
// `bodies` list so the plural kernel read and the list mutators see the ref.
// Mirrors dropDeadAxisConstraints (mutate in place, return the count rewritten).
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { migrateLegacyBodyPicks, migratePatternSourceFeatures } from '@/utils/yamlMigrations'

// The singular `body` pick is a pre-pluralization artifact (transform from
// 2026-07-29, delete_body from 2026-07-27); these docs are written in that
// stale shape on purpose.
function legacyTransformDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      { id: 't1', kind: 'transform', transform: { body: '@body_ex1', operation: 'new', translation: [0, 0, 0], rotation_angle: 0, scale: 1 } },
    ],
  } as unknown as PartDoc
}

function legacyDeleteBodyDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      { id: 'db1', kind: 'delete_body', delete_body: { body: '@body_ex1' } },
    ],
  } as unknown as PartDoc
}

describe('migrateLegacyBodyPicks', () => {
  it('rewrites a transform singular body to a one-element bodies list and drops body', () => {
    const doc = legacyTransformDoc()
    expect(migrateLegacyBodyPicks(doc)).toBe(1)
    const sub = doc.features![0] as unknown as { transform: { bodies: string[]; body?: string } }
    expect(sub.transform.bodies).toEqual(['@body_ex1'])
    expect('body' in sub.transform).toBe(false)
  })

  it('rewrites a delete_body singular body the same way', () => {
    const doc = legacyDeleteBodyDoc()
    expect(migrateLegacyBodyPicks(doc)).toBe(1)
    const sub = doc.features![0] as unknown as { delete_body: { bodies: string[]; body?: string } }
    expect(sub.delete_body.bodies).toEqual(['@body_ex1'])
    expect('body' in sub.delete_body).toBe(false)
  })

  it('turns an empty-string body into an empty bodies list and drops body', () => {
    const doc = legacyTransformDoc()
    ;(doc.features![0] as unknown as { transform: { body: string } }).transform.body = ''
    expect(migrateLegacyBodyPicks(doc)).toBe(1)
    const sub = doc.features![0] as unknown as { transform: { bodies: string[]; body?: string } }
    expect(sub.transform.bodies).toEqual([])
    expect('body' in sub.transform).toBe(false)
  })

  it('rewrites both kinds in one document', () => {
    const doc: PartDoc = {
      version: 1,
      kind: 'part',
      features: [
        { id: 't1', kind: 'transform', transform: { body: '@body_ex1', operation: 'new' } },
        { id: 'db1', kind: 'delete_body', delete_body: { body: '@body_ex2' } },
      ],
    } as unknown as PartDoc
    expect(migrateLegacyBodyPicks(doc)).toBe(2)
    const t = doc.features![0] as unknown as { transform: { bodies: string[] } }
    const d = doc.features![1] as unknown as { delete_body: { bodies: string[] } }
    expect(t.transform.bodies).toEqual(['@body_ex1'])
    expect(d.delete_body.bodies).toEqual(['@body_ex2'])
  })

  it('is idempotent: a second pass rewrites nothing', () => {
    const doc = legacyTransformDoc()
    expect(migrateLegacyBodyPicks(doc)).toBe(1)
    expect(migrateLegacyBodyPicks(doc)).toBe(0)
  })

  it('leaves a plural bodies list untouched', () => {
    const doc: PartDoc = {
      version: 1,
      kind: 'part',
      features: [
        { id: 't1', kind: 'transform', transform: { bodies: ['@body_ex1', '@body_ex2'], operation: 'new' } },
      ],
    } as unknown as PartDoc
    expect(migrateLegacyBodyPicks(doc)).toBe(0)
    const sub = doc.features![0] as unknown as { transform: { bodies: string[] } }
    expect(sub.transform.bodies).toEqual(['@body_ex1', '@body_ex2'])
  })

  it('leaves the mirror feature singular body untouched', () => {
    const doc: PartDoc = {
      version: 1,
      kind: 'part',
      features: [
        { id: 'm1', kind: 'mirror', mirror: { body: '@body_ex1', plane: '@top' } },
      ],
    } as unknown as PartDoc
    expect(migrateLegacyBodyPicks(doc)).toBe(0)
    const sub = doc.features![0] as unknown as { mirror: { body: string } }
    expect(sub.mirror.body).toBe('@body_ex1')
  })

  it('skips a row that names the kind without carrying its def', () => {
    // The document loader accepts a payload-less row, and the pre-union pass
    // skipped it; throwing here would abandon the heal for every later row
    // (docSchema catches the step's throw, so the rest of the document would
    // silently keep its singular body picks).
    const doc = {
      version: 1,
      kind: 'part',
      features: [
        { id: 'x1', kind: 'delete_body' },
        { id: 't1', kind: 'transform', transform: { body: '@body_ex1', operation: 'new' } },
        { id: 'db1', kind: 'delete_body', delete_body: { body: '@body_ex2' } },
      ],
    } as unknown as PartDoc
    expect(migrateLegacyBodyPicks(doc)).toBe(2)
    const t = doc.features![1] as unknown as { transform: { bodies: string[] } }
    const d = doc.features![2] as unknown as { delete_body: { bodies: string[] } }
    expect(t.transform.bodies).toEqual(['@body_ex1'])
    expect(d.delete_body.bodies).toEqual(['@body_ex2'])
  })

  it('returns the count of features rewritten, not the number of keys touched', () => {
    const doc: PartDoc = {
      version: 1,
      kind: 'part',
      features: [
        { id: 't1', kind: 'transform', transform: { body: '@b1', operation: 'new' } },
        { id: 't2', kind: 'transform', transform: { bodies: ['@b2'], operation: 'new' } },
      ],
    } as unknown as PartDoc
    expect(migrateLegacyBodyPicks(doc)).toBe(1)
  })
})

describe('migratePatternSourceFeatures', () => {
  function patternDoc(pattern: Record<string, unknown>): PartDoc {
    return {
      version: 7,
      kind: 'part',
      features: [{ id: 'pt1', kind: 'pattern', pattern }],
    } as unknown as PartDoc
  }

  it('folds the single legacy source into a one-element list', () => {
    const doc = patternDoc({ subject: 'feature', source_feature: '@ex1' })
    expect(migratePatternSourceFeatures(doc)).toBe(1)
    const sub = (doc.features![0] as unknown as { pattern: Record<string, unknown> }).pattern
    expect(sub.source_features).toEqual(['@ex1'])
    expect('source_feature' in sub).toBe(false)
  })

  it('drops an empty legacy source without inventing one', () => {
    const doc = patternDoc({ subject: 'feature', source_feature: '' })
    expect(migratePatternSourceFeatures(doc)).toBe(1)
    const sub = (doc.features![0] as unknown as { pattern: Record<string, unknown> }).pattern
    expect(sub.source_features).toEqual([])
    expect('source_feature' in sub).toBe(false)
  })

  it('keeps a multi-source list and drops a stale scalar beside it', () => {
    const doc = patternDoc({ source_features: ['@ex1', '@rv1'], source_feature: '@ex2' })
    expect(migratePatternSourceFeatures(doc)).toBe(1)
    const sub = (doc.features![0] as unknown as { pattern: Record<string, unknown> }).pattern
    expect(sub.source_features).toEqual(['@ex1', '@rv1'])
    expect('source_feature' in sub).toBe(false)
  })

  it('leaves a malformed scalar for the validator to refuse', () => {
    const doc = patternDoc({ source_feature: 5 })
    expect(migratePatternSourceFeatures(doc)).toBe(0)
    expect((doc.features![0] as unknown as { pattern: Record<string, unknown> }).pattern.source_feature).toBe(5)
  })

  it('is idempotent and leaves a list-only pattern alone', () => {
    const doc = patternDoc({ source_features: ['@ex1'] })
    expect(migratePatternSourceFeatures(doc)).toBe(0)
    const once = patternDoc({ source_feature: '@ex1' })
    expect(migratePatternSourceFeatures(once)).toBe(1)
    expect(migratePatternSourceFeatures(once)).toBe(0)
  })
})
