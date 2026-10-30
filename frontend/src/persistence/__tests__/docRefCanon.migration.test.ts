// Migration unit tests for doc-ref-canon: the ladder folds the two tolerated
// spellings onto their canonical one. A feature-level reference to a feature is
// `@id` (never `$id`, which stays host-local to a sketch's own entities), and
// every non-base param lives in the feature's kind sub-dict.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { CURRENT_DOC_VERSION, loadPartDoc, migrate } from '@/persistence/docSchema'
import { nestedFeatureParams } from '@/kernel/features/shared/featureParams'
import { canonicalizeFeatureParams, migrateFeatureRefsToAbsolute } from '@/utils/yamlMigrations'
import type { PartDoc } from '@/types/cad'

type Dict = Record<string, unknown>

function sub(doc: PartDoc, index: number, kind: string): Dict {
  return (doc.features as unknown as Dict[])[index][kind] as Dict
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('feature refs become absolute', () => {
  it('rewrites a feature-level $id to @id', () => {
    const doc: PartDoc = {
      features: [
        { id: 'sk1', kind: 'sketch' },
        { id: 'ex1', kind: 'extrude', extrude: { sketch: '$sk1', distance: 5 } },
      ] as unknown as PartDoc['features'],
    }
    const result = loadPartDoc(doc)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(sub(result.doc, 1, 'extrude').sketch).toBe('@sk1')
    expect(result.migrations).toContain('feature-refs-absolute')
  })

  it('rewrites a flat legacy extrude ref and nests it in one pass', () => {
    const doc: PartDoc = {
      features: [
        { id: 'sk1', kind: 'sketch' },
        { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 5 },
      ] as unknown as PartDoc['features'],
    }
    const result = loadPartDoc(doc)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const ex = result.doc.features as unknown as Dict[]
    expect(ex[1].sketch).toBeUndefined()
    expect((ex[1].extrude as Dict).sketch).toBe('@sk1')
    expect((ex[1].extrude as Dict).distance).toBe(5)
  })

  it('leaves a $line1 constraint operand inside its own sketch untouched', () => {
    const doc: PartDoc = {
      features: [{
        id: 'sk1', kind: 'sketch',
        entities: [{ id: 'line1', kind: 'line' }],
        constraints: [{ id: 'c1', kind: 'horizontal', a: '$line1' }],
      }],
    } as unknown as PartDoc
    const result = loadPartDoc(doc)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const sketch = result.doc.features as unknown as Dict[]
    const constraint = (sketch[0].constraints as Dict[])[0]
    expect(constraint.a).toBe('$line1')
    expect(result.migrations).not.toContain('feature-refs-absolute')
  })

  it('leaves a $id that names no feature in the document untouched', () => {
    const doc: PartDoc = {
      features: [{ id: 'ex1', kind: 'extrude', extrude: { sketch: '$not_a_feature' } }],
    } as unknown as PartDoc
    expect(migrateFeatureRefsToAbsolute(doc)).toBe(0)
    expect(sub(doc, 0, 'extrude').sketch).toBe('$not_a_feature')
  })

  it('leaves the legacy $sketch.entity sweep-path form untouched', () => {
    const doc: PartDoc = {
      features: [
        { id: 'spine', kind: 'sketch' },
        { id: 'sw1', kind: 'sweep', sweep: { path: '$spine.s1' } },
      ] as unknown as PartDoc['features'],
    }
    expect(migrateFeatureRefsToAbsolute(doc)).toBe(0)
    expect(sub(doc, 1, 'sweep').path).toBe('$spine.s1')
  })
})

describe('params become nested', () => {
  it('moves a flat distance into the extrude sub-dict', () => {
    const doc: PartDoc = {
      features: [{ id: 'ex1', kind: 'extrude', distance: 6, operation: 'new' }],
    } as unknown as PartDoc
    expect(canonicalizeFeatureParams(doc)).toBe(1)
    expect(sub(doc, 0, 'extrude')).toEqual({ distance: 6, operation: 'new' })
    expect((doc.features as unknown as Dict[])[0].distance).toBeUndefined()
  })

  it('keeps the flat value on conflict and reports the dropped nested one', () => {
    const { feature, dropped } = nestedFeatureParams({ id: 'ex1', kind: 'extrude', distance: 6, extrude: { distance: 9 } })
    expect((feature.extrude as Dict).distance).toBe(6)
    expect(dropped).toEqual(['extrude.distance'])
  })

  it('logs the dropped value through the migration', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const doc: PartDoc = {
      features: [{ id: 'ex1', kind: 'extrude', distance: 6, extrude: { distance: 9 } }],
    } as unknown as PartDoc
    expect(canonicalizeFeatureParams(doc)).toBe(1)
    expect(sub(doc, 0, 'extrude').distance).toBe(6)
    expect(warn).toHaveBeenCalled()
    const message = warn.mock.calls.map(c => String(c[0])).join('\n')
    expect(message).toContain('extrude.distance')
  })

  it('leaves a sketch alone: its entities and plane stay feature-level', () => {
    const doc: PartDoc = {
      features: [{ id: 'sk1', kind: 'sketch', plane: '@builtin_plane_front', entities: [{ id: 'l', kind: 'line' }] }],
    } as unknown as PartDoc
    expect(canonicalizeFeatureParams(doc)).toBe(0)
    expect((doc.features as unknown as Dict[])[0].plane).toBe('@builtin_plane_front')
  })

  it('leaves import_step alone: file_id and scale are feature-level by design', () => {
    const doc: PartDoc = {
      features: [{ id: 'is1', kind: 'import_step', file_id: 'f', scale: 2 }],
    } as unknown as PartDoc
    expect(canonicalizeFeatureParams(doc)).toBe(0)
    expect((doc.features as unknown as Dict[])[0].scale).toBe(2)
  })

  it('is idempotent', () => {
    const doc: PartDoc = {
      features: [{ id: 'ex1', kind: 'extrude', distance: 6, extrude: { direction: 'normal' } }],
    } as unknown as PartDoc
    expect(canonicalizeFeatureParams(doc)).toBe(1)
    expect(canonicalizeFeatureParams(doc)).toBe(0)
    expect(sub(doc, 0, 'extrude')).toEqual({ distance: 6, direction: 'normal' })
  })
})

describe('the ladder gate', () => {
  it('runs the canonicalization steps below the current version and skips them at it', () => {
    const doc = () => ({
      features: [{ id: 'ex1', kind: 'extrude', distance: 5 }],
    }) as unknown as Record<string, unknown>
    // The canonicalization steps target version 3; anything behind THAT runs
    // them, whatever the ladder's top version currently is.
    expect(migrate(doc(), 2)).toContain('canonical-feature-params')
    expect(migrate(doc(), CURRENT_DOC_VERSION)).toEqual([])
  })

  it('is idempotent end to end: a migrated document reloads with no steps', () => {
    const first = loadPartDoc({
      features: [{ id: 'sk1', kind: 'sketch' }, { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 5 }],
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = loadPartDoc(first.doc)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.migrations).toEqual([])
    expect(second.doc).toEqual(first.doc)
  })
})
