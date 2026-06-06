import { describe, it, expect } from 'vitest'
import {
  TOL_LOOP_CLOSURE,
  TOL_NEAR_ZERO_AREA,
  TOL_TOPOLOGY_EPS,
  TOL_TOPOLOGY_MERGE,
  TOL_TOPOLOGY_SPLIT,
} from './solverConstants'

describe('solverConstants', () => {
  const toleranceConstants = [
    TOL_LOOP_CLOSURE,
    TOL_NEAR_ZERO_AREA,
    TOL_TOPOLOGY_EPS,
    TOL_TOPOLOGY_MERGE,
    TOL_TOPOLOGY_SPLIT,
  ]

  it('all tolerance constants are finite and positive', () => {
    // Port of test_tolerance_constants_importable (tests/kernel/test_tolerance_constants.py:14)
    for (const c of toleranceConstants) {
      expect(typeof c).toBe('number')
      expect(Number.isFinite(c)).toBe(true)
      expect(c).toBeGreaterThan(0)
    }
  })

  it('TOL_TOPOLOGY_MERGE exceeds TOL_TOPOLOGY_EPS', () => {
    // Port of test_topology_merge_exceeds_eps (test_tolerance_constants.py:30)
    expect(TOL_TOPOLOGY_MERGE).toBeGreaterThan(TOL_TOPOLOGY_EPS)
  })

  // Python tests test_loop_closure_used_in_profile_loops and
  // test_topology_uses_constants use `inspect.getsource` to verify
  // imports — Python code hygiene, n/a for TS.
})
