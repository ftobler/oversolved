// Three modules cap a fit spline: the document boundary refuses a stored curve
// over the limit, the mutation layer refuses one the editors build, and the
// geometry mirror refuses one it would have to interpolate. They must name the
// same number, derived from the vertex-key vocabulary, or a document can load
// and then fail to render (or vice versa).
import { describe, it, expect } from 'vitest'
import { FIT_POINT_KEY, MAX_FIT_POINT_KEY, VERTEX_POINT_KEY_SUFFIXES } from '@/types/vertexKeys'
import { MAX_FIT_POINTS as LOAD_LIMIT } from '@/persistence/docSchema'
import { MAX_FIT_POINTS as EDIT_LIMIT } from '@/utils/yamlMutations/fitSpline'
import { MAX_FIT_POINTS as CURVE_LIMIT } from '@/utils/geometry/fitSpline'

describe('fit-point limits', () => {
  it('is one value across the load, edit and geometry layers', () => {
    expect(LOAD_LIMIT).toBe(EDIT_LIMIT)
    expect(EDIT_LIMIT).toBe(CURVE_LIMIT)
  })

  it('counts the interior keys plus the two end points', () => {
    // Point 0 is `start`, the last is `end`, and the interior keys run from
    // fit1 up to the bound.
    expect(LOAD_LIMIT).toBe(MAX_FIT_POINT_KEY + 2)
  })

  it('builds the vertex-key vocabulary from the same bound', () => {
    // Raising the limit must raise the accepted key in one edit, not leave the
    // regex behind and silently reject the new interior points.
    expect(FIT_POINT_KEY.test(`fit${MAX_FIT_POINT_KEY}`)).toBe(true)
    expect(FIT_POINT_KEY.test(`fit${MAX_FIT_POINT_KEY + 1}`)).toBe(false)
    expect(VERTEX_POINT_KEY_SUFFIXES).toContain(`fit${MAX_FIT_POINT_KEY}`)
  })
})
