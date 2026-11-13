// @vitest-environment node
//
// A straight source edge perpendicular to the sketch plane projects to one
// point, not a zero-length line. This is the true projection, the same rule the
// edge-on conic takes to its silhouette line: no warning, and the resolved kind
// is reported in `resolved_kinds` (a solve-time fact; the document row keeps
// the declared kind once projection-lowering-hygiene lands).
//
// A constraint that names the collapsed line's start or end has no key on the
// point, so the merged kind-change rule drops it with a `dropped_constraints`
// record while the document keeps the row.
//
// The bug report's document is `bugreports/projection-review/degenerate-silent.yaml`:
// sketch `skA` on Top projecting the box's vertical edge (40, 0, -30) ->
// (40, 10, -30), stored as `line [40, 30, 40, 30]`.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect } from 'vitest'
import {
  applyAddProjectedEntity, applyAddEntity, applyAddConstraint, applySetFeaturePlane,
} from '@/utils/yamlMutations/sketch'
import { applyAddSketch } from '@/utils/yamlMutations/featureAdmin'
import type { PartDoc, SketchFeature } from '@/types/cad'
import {
  BOX, oc, projectionBaseDoc, projectionTestHarness, sketchOut, solveBytes,
} from './projectionRealSupport'

const { h, base } = projectionTestHarness()

const run = (doc: PartDoc) => h.run(doc as unknown as Record<string, unknown>)

/** The authored sketch, for the rows the solve does not touch. */
function sketchFeature(doc: PartDoc, id: string): SketchFeature {
  const found = (doc.features ?? []).find(f => f.id === id)
  if (!found) throw new Error(`document has no feature ${id}`)
  return found as SketchFeature
}

function expectPoint(actual: number[], expected: number[]): void {
  expect(actual).toHaveLength(expected.length)
  expected.forEach((v, i) => expect(actual[i]).toBeCloseTo(v, 6))
}

describe.skipIf(!oc || !solveBytes)('a line perpendicular to the sketch plane projects as a point (real OCC + Rust solver)', () => {
  it('4. the box edge along the Top plane normal is the point (40, 30), and the sketch builds', () => {
    const { geometry } = base()
    const doc = projectionBaseDoc() as PartDoc
    applyAddSketch(doc, 'skT', 'End-on', '@builtin_plane_top')
    applyAddProjectedEntity(doc, 'skT', 'line', geometry.verticalEdge, 'v')

    const sketch = sketchOut(h, run(doc), 'skT')
    expect(sketch.projection_errors).toBeUndefined()
    // The edge runs along world y; Top's local axes are world x and world -z,
    // so the endpoint (40, y, -30) lands at (40, 30) whatever y the edge has.
    expect(sketch.resolved_kinds).toEqual({ v: 'point' })
    expect(sketch.geometry!.v).toHaveLength(2)
    expectPoint(sketch.geometry!.v, [BOX.width, BOX.height])
    // A pinned point is no free parameter, and a point profile is a valid
    // sketch: the collapse must not turn into a sketch exception.
    expect(sketch.status).not.toBe('exception')
    expect(sketch.status).toBe('fully_constrained')
  })

  it('5. a coincidence on the projection start is dropped when the box edge turns end-on', () => {
    const { geometry } = base()
    const doc = projectionBaseDoc() as PartDoc
    applyAddSketch(doc, 'skE', 'Edge start', '@builtin_plane_front')
    applyAddProjectedEntity(doc, 'skE', 'line', geometry.verticalEdge, 'e')
    applyAddEntity(doc, 'skE', 'point', [4, 14], 'pin')
    applyAddConstraint(doc, 'skE', 'coincident', ['vertex:skE:pin:xy', 'vertex:skE:e:start'])
    const authored = sketchFeature(doc, 'skE').constraints ?? []
    const row = authored.find(c => c.kind === 'coincident')
    if (!row) throw new Error('the coincidence was not authored')

    // On Front the edge is a real segment: world (40, 0, -30) to (40, 10, -30)
    // is Front-local (40, 0) to (40, 10), so the start row lowers and binds the
    // point to it.
    const flat = sketchOut(h, run(doc), 'skE')
    expect(flat.projection_errors).toBeUndefined()
    expect(flat.dropped_constraints).toBeUndefined()
    expect(flat.geometry!.e).toHaveLength(4)
    expectPoint(flat.geometry!.pin, [BOX.width, 0])

    // Top's normal is the edge's own direction, so the same source is one point
    // there. The authored start key is gone from the resolved kind: the row is
    // dropped and named, and the point is left at its authored position rather
    // than rebound onto the projected point.
    applySetFeaturePlane(doc, 'skE', '@builtin_plane_top')
    const endOn = sketchOut(h, run(doc), 'skE')
    expect(endOn.projection_errors).toBeUndefined()
    expect(endOn.resolved_kinds).toEqual({ e: 'point' })
    expect(endOn.geometry!.e).toHaveLength(2)
    expectPoint(endOn.geometry!.e, [BOX.width, BOX.height])
    expect(endOn.dropped_constraints).toEqual([
      { id: row.id, kind: 'coincident', reason: 'operand start not on point' },
    ])
    // The document keeps the row, so a source that turns back re-enables it.
    expect(sketchFeature(doc, 'skE').constraints).toHaveLength(2)
    expectPoint(endOn.geometry!.pin, [4, 14])
  })
})
