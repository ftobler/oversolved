// getFeatureIcon is a lookup that must stay total: every editor-backed feature
// kind and the built-in marker kinds render an icon, and only genuinely unknown
// kinds fall back. The completeness guard below fails when a new feature gains
// an editor schema but no icon case, which is otherwise invisible until the
// tree shows a plane where the feature should be.
import { describe, it, expect } from 'vitest'
import { getFeatureIcon } from '@/components/layout/featureIcons'
import { EDITOR_SCHEMAS } from '@/components/editors/featureEditorSchemas'

// Any string that is not wired to a case yields the fallback. Comparing against
// it is how a missing case is detected, since the fallback is a real icon value.
const FALLBACK = getFeatureIcon('definitely-not-a-feature-kind')

describe('getFeatureIcon', () => {
  it('falls back for an unknown kind, undefined, and the plane kind', () => {
    expect(getFeatureIcon('not-a-kind')).toBe(FALLBACK)
    expect(getFeatureIcon(undefined)).toBe(FALLBACK)
    // `plane` is intentionally served by the fallback rather than its own case.
    expect(getFeatureIcon('plane')).toBe(FALLBACK)
  })

  it('looks up case-insensitively', () => {
    expect(getFeatureIcon('EXTRUDE')).toBe(getFeatureIcon('extrude'))
    expect(getFeatureIcon('Extrude')).toBe(getFeatureIcon('extrude'))
  })

  it('maps every editor-backed feature kind to a non-fallback icon', () => {
    const missing = Object.keys(EDITOR_SCHEMAS).filter(kind => getFeatureIcon(kind) === FALLBACK)
    expect(missing, `editor-backed kinds with no icon case: ${missing.join(', ')}`).toEqual([])
  })

  it('maps the non-editor feature kinds that have a dedicated icon', () => {
    for (const kind of ['sketch', 'origin', 'import_step']) {
      expect(getFeatureIcon(kind), kind).not.toBe(FALLBACK)
      expect(getFeatureIcon(kind), kind).toBeTruthy()
    }
  })
})
