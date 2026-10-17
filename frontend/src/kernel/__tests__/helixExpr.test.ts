// The helix's expression-capable fields resolve against the variable context
// before the leaf solver runs.

import { describe, it, expect } from 'vitest'
import { resolveFeatureExpressions } from '../solverRegistry'
import { EXPR_FIELDS_BY_KIND } from '../evalExpr'

describe('helix expression fields', () => {
  it('lists the helix numeric fields', () => {
    expect(EXPR_FIELDS_BY_KIND.helix).toContain('pitch')
    expect(EXPR_FIELDS_BY_KIND.helix).toContain('start_angle')
  })

  it('resolves pitch and start_angle from variables', () => {
    const feature = {
      id: 'hx1', kind: 'helix',
      helix: { mode: 'pitch_turns', pitch: 'p', turns: 5, start_angle: 'a / 2', helix_angle: 5 },
    }
    const resolved = resolveFeatureExpressions(feature, { p: 3, a: 90 })
    expect('exception' in resolved).toBe(false)
    if (!('exception' in resolved)) {
      const helix = resolved.feature.helix as Record<string, unknown>
      expect(helix.pitch).toBe(3)
      expect(helix.start_angle).toBe(45)
    }
  })

  it('returns an exception on an unresolvable expression', () => {
    const feature = {
      id: 'hx1', kind: 'helix',
      helix: { mode: 'pitch_turns', pitch: 'missing_var + 1', turns: 5 },
    }
    const resolved = resolveFeatureExpressions(feature, {})
    expect('exception' in resolved).toBe(true)
  })
})
