// @vitest-environment node
//
// A straight source edge perpendicular to the sketch plane projects to one
// point, not a zero-length line. This is the true projection, the same rule the
// edge-on conic takes to its silhouette line: no warning, and the resolved kind
// is reported in `resolved_kinds` (a solve-time fact; the document row keeps
// the declared kind once projection-lowering-hygiene lands).
//
// The bug report's document is `bugreports/projection-review/degenerate-silent.yaml`:
// sketch `skA` on Top projecting the box's vertical edge (40, 0, -30) ->
// (40, 10, -30), stored as `line [40, 30, 40, 30]`.
//
// Skips when OCC.js or the Rust solver is absent.

import { describe, it, expect } from 'vitest'
import { applyAddProjectedEntity } from '@/utils/yamlMutations/sketch'
import { applyAddSketch } from '@/utils/yamlMutations/featureAdmin'
import type { PartDoc } from '@/types/cad'
import {
  BOX, oc, projectionBaseDoc, projectionTestHarness, solveBytes,
} from './projectionRealSupport'

const { h, base } = projectionTestHarness()

/** The sketch solve fields this pin reads. */
type SketchOut = {
  geometry?: Record<string, number[]>
  projection_errors?: string[]
  resolved_kinds?: Record<string, string>
  status?: string
}

const sketchOf = (result: ReturnType<typeof h.run>, id: string): SketchOut =>
  h.res(result, id) as SketchOut

describe.skipIf(!oc || !solveBytes)('a line perpendicular to the sketch plane projects as a point (real OCC + Rust solver)', () => {
  it('4. the box edge along the Top plane normal is the point (40, 30), and the sketch builds', () => {
    const { geometry } = base()
    const doc = projectionBaseDoc() as PartDoc
    applyAddSketch(doc, 'skT', 'End-on', '@builtin_plane_top')
    applyAddProjectedEntity(doc, 'skT', 'line', geometry.verticalEdge, 'v')

    const result = h.run(doc as unknown as Record<string, unknown>)
    const sketch = sketchOf(result, 'skT')
    expect(sketch.projection_errors).toBeUndefined()
    // The edge runs along world y; Top's local axes are world x and world -z,
    // so the endpoint (40, y, -30) lands at (40, 30) whatever y the edge has.
    expect(sketch.resolved_kinds).toEqual({ v: 'point' })
    expect(sketch.geometry!.v).toHaveLength(2)
    expect(sketch.geometry!.v[0]).toBeCloseTo(BOX.width, 9)
    expect(sketch.geometry!.v[1]).toBeCloseTo(BOX.height, 9)
    // A pinned point is no free parameter, and a point profile is a valid
    // sketch: the collapse must not turn into a sketch exception.
    expect(sketch.status).not.toBe('exception')
    expect(sketch.status).toBe('fully_constrained')
  })
})
