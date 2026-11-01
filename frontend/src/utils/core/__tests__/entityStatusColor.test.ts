// One status colour map for sketch geometry. The two copies this replaced
// disagreed about an unknown status, which is the regression pinned here.
import { describe, it, expect } from 'vitest'
import { entityStatusColor, sketchStatusColor } from '@/utils/core/entityStatusColor'
import {
  COLOR_ERROR, COLOR_FULLY_CONSTRAINED, COLOR_INACTIVE, COLOR_SOLVED,
} from '@/utils/core/partColors'

describe('sketchStatusColor', () => {
  it('marks a sketch outside its editor inactive whatever its solve said', () => {
    expect(sketchStatusColor('fully_constrained', false)).toBe(COLOR_INACTIVE)
    expect(sketchStatusColor(undefined, false)).toBe(COLOR_INACTIVE)
  })

  it('maps the three solver statuses', () => {
    expect(sketchStatusColor('fully_constrained', true)).toBe(COLOR_FULLY_CONSTRAINED)
    expect(sketchStatusColor('underconstrained', true)).toBe(COLOR_SOLVED)
    expect(sketchStatusColor('overconstrained', true)).toBe(COLOR_ERROR)
    expect(sketchStatusColor('exception', true)).toBe(COLOR_ERROR)
  })

  it('an unknown or absent status is inactive, not solved', () => {
    // The old sketch-wide map defaulted to the solved blue, so a sketch with no
    // solve yet painted as if it had solved within limits.
    expect(sketchStatusColor(undefined, true)).toBe(COLOR_INACTIVE)
    expect(sketchStatusColor('something_new', true)).toBe(COLOR_INACTIVE)
  })
})

describe('entityStatusColor', () => {
  it('uses the entity own status when the solve reported one', () => {
    expect(entityStatusColor('fully_constrained', 'underconstrained', true)).toBe(COLOR_FULLY_CONSTRAINED)
    expect(entityStatusColor('overconstrained', 'underconstrained', true)).toBe(COLOR_ERROR)
    expect(entityStatusColor('underconstrained', 'fully_constrained', true)).toBe(COLOR_SOLVED)
  })

  it('falls back to the sketch answer for an entity with no status', () => {
    expect(entityStatusColor(undefined, 'underconstrained', true)).toBe(COLOR_SOLVED)
    expect(entityStatusColor(undefined, 'fully_constrained', true)).toBe(COLOR_FULLY_CONSTRAINED)
  })

  it('agrees with the sketch map about an unknown status', () => {
    expect(entityStatusColor(undefined, undefined, true)).toBe(COLOR_INACTIVE)
    expect(entityStatusColor(undefined, 'something_new', true)).toBe(COLOR_INACTIVE)
  })

  it('ignores every status outside the editor', () => {
    expect(entityStatusColor('fully_constrained', 'fully_constrained', false)).toBe(COLOR_INACTIVE)
  })
})
