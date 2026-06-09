/**
 * Tests for the testFixture test helper.
 *
 * Invariants:
 *   - makeDoc / makeSketch produce feature/entity IDs equal to the supplied
 *     parseable strings.
 *   - JSON-serialising a doc built by the helper yields no extra metadata
 *     layer -- only the expected keys appear.
 */

import { describe, it, expect } from 'vitest'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'

describe('parseable_fixture_builds_doc', () => {
  it('feature ID equals the parseable string', () => {
    const doc = makeDoc(
      makeSketch('sketch1', {
        entities: [
          { id: 'line1', kind: 'line' },
          { id: 'arc1', kind: 'arc' },
        ],
        constraints: [
          { id: 'c1', kind: 'horizontal', target: '$line1' },
        ],
        initial: { line1: [0, 0, 10, 0] },
      }),
    )

    expect(doc.features![0].id).toBe('sketch1')
  })

  it('entity IDs equal the parseable strings', () => {
    const doc = makeDoc(
      makeSketch('sketch1', {
        entities: [
          { id: 'line1', kind: 'line' },
          { id: 'arc1', kind: 'arc' },
        ],
      }),
    )

    const entityIds = doc.features![0].entities!.map(e => e.id)
    expect(entityIds).toEqual(['line1', 'arc1'])
  })

  it('constraint IDs equal the parseable strings', () => {
    const doc = makeDoc(
      makeSketch('sketch1', {
        constraints: [
          { id: 'c1', kind: 'horizontal', target: '$line1' },
        ],
      }),
    )

    const constraintIds = doc.features![0].constraints!.map(c => c.id)
    expect(constraintIds).toEqual(['c1'])
  })

  it('multiple features preserve all IDs', () => {
    const doc = makeDoc(
      makeSketch('sketch1'),
      makeSketch('sketch2', { plane: '@builtin_plane_top' }),
    )

    const featureIds = doc.features!.map(f => f.id)
    expect(featureIds).toEqual(['sketch1', 'sketch2'])
  })
})

describe('parseable_fixture_does_not_leak_into_yaml', () => {
  it('JSON round-trip contains no extra metadata keys on the feature', () => {
    const doc = makeDoc(
      makeSketch('sketch1', {
        entities: [{ id: 'line1', kind: 'line' }],
        constraints: [{ id: 'c1', kind: 'horizontal', target: '$line1' }],
        initial: { line1: [0, 0, 10, 0] },
        label: 'Rectangle',
      }),
    )

    // Serialise and re-parse (simulates YAML round-trip via JSON equivalence).
    const parsed = JSON.parse(JSON.stringify(doc)) as typeof doc
    const feature = parsed.features![0]

    const allowedKeys = new Set(['id', 'kind', 'plane', 'entities', 'constraints', 'initial', 'label'])
    for (const key of Object.keys(feature)) {
      expect(allowedKeys.has(key), `unexpected key "${key}" on feature`).toBe(true)
    }
  })

  it('JSON round-trip contains no extra metadata keys on entities', () => {
    const doc = makeDoc(
      makeSketch('sketch1', {
        entities: [{ id: 'line1', kind: 'line' }],
      }),
    )

    const parsed = JSON.parse(JSON.stringify(doc)) as typeof doc
    const entity = parsed.features![0].entities![0]

    // Only standard PartEntityDef keys are allowed.
    const allowedKeys = new Set(['id', 'kind', 'construction', 'source'])
    for (const key of Object.keys(entity)) {
      expect(allowedKeys.has(key), `unexpected key "${key}" on entity`).toBe(true)
    }
  })

  it('a hand-built doc and a helper-built doc with the same IDs serialise identically', () => {
    const helperDoc = makeDoc(
      makeSketch('sketch1', {
        entities: [{ id: 'line1', kind: 'line' }],
        constraints: [{ id: 'c1', kind: 'horizontal', target: '$line1' }],
        initial: { line1: [0, 0, 10, 0] },
      }),
    )

    // Hand-built doc -- same IDs, no helper.
    const handDoc = {
      version: 1,
      kind: 'part',
      features: [
        {
          id: 'sketch1',
          kind: 'sketch',
          plane: '@builtin_plane_front',
          entities: [{ id: 'line1', kind: 'line' }],
          constraints: [{ id: 'c1', kind: 'horizontal', target: '$line1' }],
          initial: { line1: [0, 0, 10, 0] },
        },
      ],
    }

    expect(JSON.stringify(helperDoc)).toBe(JSON.stringify(handDoc))
  })
})
