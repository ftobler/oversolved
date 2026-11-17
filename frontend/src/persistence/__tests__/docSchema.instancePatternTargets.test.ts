// The version-10 retirement of the instance pattern's `sketch` field: the one
// target list holds a sketch ref as a row that expands to the sketch's points,
// so a stored sketch is folded into the leading `targets` entry. The merge is
// idempotent, a document that already holds the list is untouched, and the
// published schema no longer offers the retired field.
import { describe, it, expect } from 'vitest'
import { CURRENT_DOC_VERSION, loadPartDoc, migrate } from '@/persistence/docSchema'
import { FEATURE_SCHEMA_BY_KIND } from '@/persistence/partDocSchema'

function doc(instance: Record<string, unknown>, version = 9): Record<string, unknown> {
  return {
    version,
    kind: 'part',
    features: [
      { id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front', entities: [{ id: 'p', kind: 'point' }], initial: { p: [0, 0] }, constraints: [] },
      { id: 'ip1', kind: 'instance_pattern', label: 'Instance', instance_pattern: instance },
    ],
  }
}

function loaded(instance: Record<string, unknown>, version = 9): {
  instance_pattern: Record<string, unknown>
  migrations: string[]
} {
  const result = loadPartDoc(doc(instance, version))
  expect(result.ok, JSON.stringify(!result.ok ? result.error : null)).toBe(true)
  if (!result.ok) throw new Error('load failed')
  const feature = (result.doc.features as Record<string, unknown>[])[1]
  return { instance_pattern: feature.instance_pattern as Record<string, unknown>, migrations: result.migrations }
}

describe('the version-10 instance pattern target list', () => {
  it('is the ladder current version', () => {
    expect(CURRENT_DOC_VERSION).toBe(10)
  })

  it('folds a stored sketch into the leading target and drops the field', () => {
    const { instance_pattern, migrations } = loaded({ subject: 'body', source_body: '@b1', sketch: '@sk1' })
    expect(instance_pattern).toEqual({ subject: 'body', source_body: '@b1', targets: ['@sk1'] })
    expect(migrations).toContain('instance-pattern-targets')
  })

  it('merges both forms with the sketch first', () => {
    // The kernel refused this pair before, so it is never a document the app
    // wrote; a hand-authored one still lands on the one list it means.
    const { instance_pattern } = loaded({
      subject: 'body', sketch: '@sk1', targets: ['entity:sk1:p', '?@ex1:flatface'],
    })
    expect(instance_pattern.targets).toEqual(['@sk1', 'entity:sk1:p', '?@ex1:flatface'])
    expect(instance_pattern).not.toHaveProperty('sketch')
  })

  it('leaves a document that already holds the list untouched', () => {
    const before = doc({ subject: 'body', targets: ['@sk1', 'entity:sk1:p'] })
    expect(migrate(before, 9)).not.toContain('instance-pattern-targets')
    const { instance_pattern, migrations } = loaded({ subject: 'body', targets: ['@sk1', 'entity:sk1:p'] })
    expect(instance_pattern).toEqual({ subject: 'body', targets: ['@sk1', 'entity:sk1:p'] })
    expect(migrations).toEqual([])
  })

  it('is stable when the loaded document is loaded again', () => {
    const first = loadPartDoc(doc({ subject: 'body', sketch: '@sk1' }))
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = loadPartDoc(first.doc)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.migrations).toEqual([])
    expect(second.doc).toEqual(first.doc)
  })

  it('leaves a current-version document alone', () => {
    // A stamp at the ladder's current version promises the fold already ran. The
    // kernel still reads a lingering sketch key as the leading target, so a
    // hand-built current document needs no heal.
    const { instance_pattern, migrations } = loaded({ sketch: '@sk1' }, 10)
    expect(instance_pattern).toEqual({ sketch: '@sk1' })
    expect(migrations).toEqual([])
  })

  it('publishes one target list and no retired sketch field', () => {
    const params = FEATURE_SCHEMA_BY_KIND.instance_pattern.properties as Record<string, Record<string, unknown>>
    const props = (params.instance_pattern.properties ?? {}) as Record<string, unknown>
    expect(props).toHaveProperty('targets')
    expect(props).not.toHaveProperty('sketch')
  })
})
