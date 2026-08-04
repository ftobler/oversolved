// Self-heal migration for documents authored before the transform/delete_body
// body pick was pluralized: the singular `body` key becomes a one-element
// `bodies` list so the plural kernel read and the list mutators see the ref.
// Mirrors dropDeadAxisConstraints (mutate in place, return the count rewritten).
import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { migrateLegacyBodyPicks } from '@/utils/yamlMigrations'

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
