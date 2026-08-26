import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  TOL_LOOP_CLOSURE,
  TOL_NEAR_ZERO_AREA,
  TOL_TOPOLOGY_EPS,
  TOL_TOPOLOGY_MERGE,
  TOL_TOPOLOGY_SPLIT,
} from './solverConstants'

// The topology tolerances are mirrored by value into
// sketch-solver/src/topology/mod.rs; float parity there is load-bearing
// (vertex-merge order feeds the query strings). This guard parses the Rust
// source directly so either side drifting fails here instead of in geometry.
const RUST_TOPOLOGY_MOD = join(__dirname, '../../../sketch-solver/src/topology/mod.rs')

function rustTolerances(): Map<string, number> {
  const src = readFileSync(RUST_TOPOLOGY_MOD, 'utf8')
  const found = new Map<string, number>()
  for (const [, name, value] of src.matchAll(/pub const (TOL_[A-Z_]+): f64 = ([0-9.e+-]+);/g)) {
    found.set(name, Number(value))
  }
  return found
}

describe('solverConstants', () => {
  const toleranceConstants = [
    TOL_LOOP_CLOSURE,
    TOL_NEAR_ZERO_AREA,
    TOL_TOPOLOGY_EPS,
    TOL_TOPOLOGY_MERGE,
    TOL_TOPOLOGY_SPLIT,
  ]

  // All tolerance constants are importable, finite, and positive.
  it('all tolerance constants are finite and positive', () => {
    for (const c of toleranceConstants) {
      expect(typeof c).toBe('number')
      expect(Number.isFinite(c)).toBe(true)
      expect(c).toBeGreaterThan(0)
    }
  })

  // TOL_TOPOLOGY_MERGE > TOL_TOPOLOGY_EPS (merge threshold must exceed coincidence threshold).
  it('TOL_TOPOLOGY_MERGE exceeds TOL_TOPOLOGY_EPS', () => {
    expect(TOL_TOPOLOGY_MERGE).toBeGreaterThan(TOL_TOPOLOGY_EPS)
  })

  // Python tests test_loop_closure_used_in_profile_loops and
  // test_topology_uses_constants use `inspect.getsource` to verify
  // imports, Python code hygiene, n/a for TS.

  it('the four topology tolerances equal their Rust mirrors', () => {
    const rust = rustTolerances()
    const mirrored: Array<[string, number]> = [
      ['TOL_TOPOLOGY_EPS', TOL_TOPOLOGY_EPS],
      ['TOL_TOPOLOGY_MERGE', TOL_TOPOLOGY_MERGE],
      ['TOL_TOPOLOGY_SPLIT', TOL_TOPOLOGY_SPLIT],
      ['TOL_NEAR_ZERO_AREA', TOL_NEAR_ZERO_AREA],
    ]
    // Exact count: a rename on the Rust side must break this loudly, not
    // shrink the comparison set silently.
    expect(rust.size).toBe(mirrored.length)
    for (const [name, tsValue] of mirrored) {
      expect(rust.get(name), name).toBeDefined()
      expect(rust.get(name)).toBe(tsValue)
    }
  })
})
