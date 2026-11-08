// The tree must not be able to forget a feature kind's visibility toggle: this
// is the review of every kind the 2026-11-08 ruling asked for. A kind added to
// the document schema with no table row fails here (and the table's
// Record<FeatureKind, ...> fails the type check), so the decision is made on
// purpose instead of inherited from whatever the old `||` chain happened to
// cover.
import { describe, it, expect } from 'vitest'
import { FEATURE_SCHEMA_BY_KIND } from '@/persistence/partDocSchema'
import {
  FEATURE_VISIBILITY_BY_KIND, hasFeatureVisibilityToggle,
  type FeatureVisibilityRule,
} from '@/components/layout/featureVisibilityKinds'
import type { FeatureKind } from '@/types/cad'

const KINDS = Object.keys(FEATURE_SCHEMA_BY_KIND).sort()
const TABLE_KINDS = Object.keys(FEATURE_VISIBILITY_BY_KIND).sort()
// A widened view: the `as const` source narrows each row to its literal shape,
// and the tests read `reason` across the whole table.
const TABLE: Record<FeatureKind, FeatureVisibilityRule> = FEATURE_VISIBILITY_BY_KIND

describe('feature visibility table', () => {
  it('decides every kind in the document schema, and no others', () => {
    expect(TABLE_KINDS).toEqual(KINDS)
  })

  it('gives each kind an eye or a written reason not to', () => {
    for (const [kind, rule] of Object.entries(TABLE)) {
      if (rule.toggle) {
        expect(rule.reason, `${kind} has an eye but carries a reason`).toBeUndefined()
      } else {
        expect(rule.reason?.trim(), `${kind} is excluded without a reason`).toBeTruthy()
      }
    }
  })

  it('excludes only the origin, the world datum', () => {
    // Deliberate list: a second exclusion has to change this test as well as
    // the table, so it cannot arrive as an unnoticed table edit.
    const excluded = Object.entries(TABLE)
      .filter(([, rule]) => !rule.toggle)
      .map(([kind]) => kind)
    expect(excluded).toEqual(['origin'])
  })

  it('answers the tree predicate from the table', () => {
    for (const kind of KINDS) {
      expect(hasFeatureVisibilityToggle(kind)).toBe(kind !== 'origin')
    }
    expect(hasFeatureVisibilityToggle(undefined)).toBe(false)
    // Own-property lookup: a prototype member is not a decided kind.
    expect(hasFeatureVisibilityToggle('constructor')).toBe(false)
  })
})
