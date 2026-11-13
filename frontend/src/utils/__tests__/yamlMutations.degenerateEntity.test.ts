// @vitest-environment node
//
// The applier half of the size floor. The drive refuses a degenerate add_entity
// before the session sees it, but the draw tools and a direct dispatch reach
// the appliers without that gate, and a double click on one spot is enough to
// produce a zero-length line. The same shared predicate refuses it here, before
// any container is materialized, so the UI stores no row the solve must drop.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'
import {
  applyAddEntity,
  applyAddEntityWithConstraint,
  applyResizeCircle,
  applySetConstraintValue,
} from '@/utils/yamlMutations/sketch'
import type { PartDoc, SketchFeature } from '@/types/cad'

function sketchDoc(): PartDoc {
  return makeDoc(makeSketch('sk1', {
    entities: [{ id: 'c1', kind: 'circle' }, { id: 'l1', kind: 'line' }],
    initial: { c1: [0, 0, 5], l1: [0, 0, 10, 0] },
    constraints: [{ id: 'dim', kind: 'radius', target: '$c1', value: 5 }],
  }))
}

function sketch(doc: PartDoc): SketchFeature {
  return doc.features![0] as SketchFeature
}

function storedEntityIds(doc: PartDoc): string[] {
  return (sketch(doc).entities ?? []).map(entity => entity.id)
}

describe('appliers refuse a degenerate seed with the shared size predicate', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('stores no zero-length line and reports the reason', () => {
    const doc = sketchDoc()
    applyAddEntity(doc, 'sk1', 'line', [1, 1, 1, 1], 'lz')
    // The sketch container exists already, so an empty insert is the no-op. The
    // count is the pin: a stored row would appear here.
    expect(storedEntityIds(doc)).toEqual(['c1', 'l1'])
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('line'),
      expect.objectContaining({ featureId: 'sk1', kind: 'line' }),
    )
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('TOL_TOPOLOGY_MERGE')
  })

  it('stores no zero-radius circle and the same rule reaches a snapped add', () => {
    const doc = sketchDoc()
    applyAddEntity(doc, 'sk1', 'circle', [0, 0, 0], 'c0')
    applyAddEntityWithConstraint(
      doc, 'sk1', 'circle', [0, 0, 0], 'center', undefined, 'coincident', '@builtin_origin', 'c0b',
    )
    expect(storedEntityIds(doc)).toEqual(['c1', 'l1'])
    expect(sketch(doc).constraints).toHaveLength(1)
    // A valid seed still lands, so the guard is not refusing the whole kind.
    applyAddEntity(doc, 'sk1', 'circle', [0, 0, 2], 'c2')
    expect(storedEntityIds(doc)).toContain('c2')
  })

  it('refuses an ellipse whose axes are out of order and spells the swap', () => {
    const doc = sketchDoc()
    applyAddEntity(doc, 'sk1', 'ellipse', [0, 0, 1, 3, 0], 'e1')
    expect(storedEntityIds(doc)).toEqual(['c1', 'l1'])
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('[cx, cy, b, a, theta + 90]')
  })

  it('leaves a resize_circle and a radius dimension at zero unchanged', () => {
    const doc = sketchDoc()
    applyResizeCircle(doc, 'sk1', 'c1', 0)
    expect(sketch(doc).initial!.c1).toEqual([0, 0, 5])
    applyResizeCircle(doc, 'sk1', 'c1', 5e-6)
    expect(sketch(doc).initial!.c1).toEqual([0, 0, 5])
    applySetConstraintValue(doc, 'sk1', 'dim', 0)
    expect(sketch(doc).constraints?.[0].value).toBe(5)
    expect(warnSpy).toHaveBeenCalled()
  })

  it('accepts the size boundary and a closed cubic', () => {
    const doc = sketchDoc()
    applyAddEntity(doc, 'sk1', 'circle', [0, 0, 2e-5], 'c_edge')
    applyAddEntity(doc, 'sk1', 'spline', [0, 0, 5, 5, -5, 5, 0, 0], 'sp')
    expect(storedEntityIds(doc)).toEqual(['c1', 'l1', 'c_edge', 'sp'])
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
