// Three modules cap a fit spline: the document boundary refuses a stored curve
// over the limit, the mutation layer refuses one the editors build, and the
// geometry mirror refuses one it would have to interpolate. They must name the
// same number, derived from the vertex-key vocabulary, or a document can load
// and then fail to render (or vice versa).
import { describe, it, expect } from 'vitest'
import { MAX_FIT_POINT_KEY } from '@/types/vertexKeys'
import { MAX_FIT_POINTS as LOAD_LIMIT } from '@/persistence/docSchema'
import { MAX_FIT_POINTS as EDIT_LIMIT } from '@/utils/yamlMutations/fitSpline'
import { MAX_FIT_POINTS as CURVE_LIMIT } from '@/utils/geometry/fitSpline'

describe('fit-point limits', () => {
  it('is one value across the load, edit and geometry layers', () => {
    expect(LOAD_LIMIT).toBe(EDIT_LIMIT)
    expect(EDIT_LIMIT).toBe(CURVE_LIMIT)
  })

  it('counts the interior keys plus the two end points', () => {
    // `fit1`..`fit62` are interior; point 0 is `start` and the last is `end`.
    expect(LOAD_LIMIT).toBe(MAX_FIT_POINT_KEY + 2)
  })
})
