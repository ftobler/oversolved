// The row-producing comparator: tolerance semantics, exact structural counts
// and the report/strict topology modes. Pure, no kernel.

import { describe, it, expect } from 'vitest'
import {
  DEFAULT_MEASURE_TOLERANCE,
  compareMeasures,
  valueWithinTolerance,
  vectorWithinTolerance,
  type MeasureRow,
} from '../measureTolerance'
import type { MeasureRecord } from '../measure'
import type { OracleMeasures } from '@/oracle/corpus'

function record(overrides: Partial<MeasureRecord> = {}): MeasureRecord {
  return {
    bodies: 1,
    volume: 100,
    area: 60,
    centroid: [5, 5, 5],
    bbox: [0, 0, 0, 10, 10, 10],
    faces: 6,
    edges: 12,
    vertices: 8,
    ...overrides,
  }
}

function expected(overrides: Partial<OracleMeasures> = {}): OracleMeasures {
  return {
    bodies: 1,
    volume: 100,
    area: 60,
    centroid: [5, 5, 5],
    bbox: [0, 0, 0, 10, 10, 10],
    ...overrides,
  }
}

function row(rows: MeasureRow[], measure: MeasureRow['measure']): MeasureRow {
  const found = rows.find((r) => r.measure === measure)
  if (!found) throw new Error(`no ${measure} row`)
  return found
}

describe('valueWithinTolerance', () => {
  it('accepts the boundary and rejects a step past it', () => {
    const tolerance = { rel: 1e-6, abs: 0 }
    expect(valueWithinTolerance(100, 100, tolerance)).toBe(true)
    expect(valueWithinTolerance(100 + 1e-6 * 100 - 1e-9, 100, tolerance)).toBe(true)
    expect(valueWithinTolerance(100 + 1e-6 * 100 + 1e-9, 100, tolerance)).toBe(false)
    // The absolute floor covers a measure near zero.
    expect(valueWithinTolerance(1e-7, 0)).toBe(true)
    expect(valueWithinTolerance(1e-3, 0)).toBe(false)
  })

  it('uses the supplied budget instead of the default', () => {
    const delta = 2e-6 * 100
    expect(valueWithinTolerance(100 + delta, 100)).toBe(false)
    expect(valueWithinTolerance(100 + delta, 100, { rel: 1e-5, abs: 0 })).toBe(true)
  })

  it('is false for a non-finite value', () => {
    expect(valueWithinTolerance(Number.NaN, 100)).toBe(false)
    expect(valueWithinTolerance(100, Number.POSITIVE_INFINITY)).toBe(false)
  })
})

describe('compareMeasures', () => {
  it('passes an identical record and emits one row per stated measure', () => {
    const result = compareMeasures(record(), expected(), { topology: 'strict' })
    expect(result.pass).toBe(true)
    expect(result.rows.map((r) => r.measure)).toEqual(['bodies', 'volume', 'area', 'centroid', 'bbox'])
    expect(result.rows.every((r) => r.enforced && r.within)).toBe(true)
  })

  it('uses the reference-supplied tolerance over the default', () => {
    const ours = record({ volume: 100 + 2e-6 * 100 })
    expect(compareMeasures(ours, expected()).pass).toBe(false)
    const result = compareMeasures(ours, expected(), { tolerance: { rel: 1e-5, abs: 0 } })
    expect(result.pass).toBe(true)
    expect(row(result.rows, 'volume').within).toBe(true)
  })

  it('fails a vector row on any single component and reports the per-component delta', () => {
    const result = compareMeasures(
      record({ bbox: [0, 0, 0, 10, 10, 11] }),
      expected(),
    )
    const bbox = row(result.rows, 'bbox')
    expect(bbox.within).toBe(false)
    expect(bbox.delta).toEqual([0, 0, 0, 0, 0, 1])
    expect(result.pass).toBe(false)
    expect(row(result.rows, 'centroid').within).toBe(true)
  })

  it('compares bodies, faces and edges exactly', () => {
    const result = compareMeasures(
      record({ bodies: 2 }),
      expected({ bodies: 2, faces: 7, edges: 13 }),
      { topology: 'strict' },
    )
    expect(row(result.rows, 'bodies').within).toBe(true)
    expect(row(result.rows, 'faces').within).toBe(false)
    expect(row(result.rows, 'faces').delta).toBe(-1)
    expect(row(result.rows, 'edges').within).toBe(false)
    expect(result.pass).toBe(false)
  })

  it('reports a topology mismatch without failing in report mode, and fails in strict', () => {
    const ours = record({ faces: 7, edges: 12 })
    const theirs = expected({ faces: 6, edges: 12 })

    const report = compareMeasures(ours, theirs, { topology: 'report' })
    expect(row(report.rows, 'faces')).toMatchObject({ within: false, enforced: false })
    expect(row(report.rows, 'edges')).toMatchObject({ within: true, enforced: false })
    expect(report.pass).toBe(true)

    const strict = compareMeasures(ours, theirs, { topology: 'strict' })
    expect(row(strict.rows, 'faces')).toMatchObject({ within: false, enforced: true })
    expect(strict.pass).toBe(false)
  })

  it('omits a row the expectation does not state', () => {
    const result = compareMeasures(record(), expected())
    expect(result.rows.map((r) => r.measure)).not.toContain('faces')
    expect(result.rows.map((r) => r.measure)).not.toContain('edges')
    expect(result.pass).toBe(true)
  })

  it('turns a missing centroid or bbox into a failing row instead of throwing', () => {
    const result = compareMeasures(record({ centroid: null, bbox: null }), expected())
    expect(row(result.rows, 'centroid')).toMatchObject({ ours: null, delta: null, within: false, enforced: true })
    expect(row(result.rows, 'bbox')).toMatchObject({ ours: null, delta: null, within: false, enforced: true })
    expect(result.pass).toBe(false)
  })

  it('hints a frame mismatch when only centroid and bbox disagree', () => {
    const result = compareMeasures(
      record({ centroid: [-5, 5, 5], bbox: [-10, 0, 0, 0, 10, 10] }),
      expected(),
    )
    expect(result.pass).toBe(false)
    expect(row(result.rows, 'centroid').hint).toContain('frame')
    expect(row(result.rows, 'bbox').hint).toContain('CadQuery XY extrusion +Z maps to Front')
    // A shape measure that also disagrees is a geometry difference, not a frame.
    const geometry = compareMeasures(
      record({ volume: 200, centroid: [-5, 5, 5], bbox: [-10, 0, 0, 0, 10, 10] }),
      expected(),
    )
    expect(row(geometry.rows, 'centroid').hint).toBeUndefined()
    expect(row(geometry.rows, 'bbox').hint).toBeUndefined()
  })

  it('defaults to the strict topology mode', () => {
    const result = compareMeasures(record({ faces: 7 }), expected({ faces: 6 }))
    expect(result.pass).toBe(false)
    // Sanity: the default budget is still the shared one.
    expect(DEFAULT_MEASURE_TOLERANCE).toEqual({ rel: 1e-6, abs: 1e-6 })
    expect(vectorWithinTolerance([1, 2, 3], [1, 2, 3])).toBe(true)
  })
})
