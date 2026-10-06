import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  OCC_CONFUSION,
  TOL_LOOP_CLOSURE,
  TOL_NEAR_ZERO_AREA,
  TOL_TOPOLOGY_EPS,
  TOL_TOPOLOGY_MERGE,
  TOL_TOPOLOGY_SPLIT,
} from '../solverConstants'

// The topology tolerances are mirrored by value into
// sketch-solver/src/topology/mod.rs; float parity there is load-bearing
// (vertex-merge order feeds the query strings). This guard parses the Rust
// source directly so either side drifting fails here instead of in geometry.
const RUST_TOPOLOGY_MOD = join(__dirname, '../../../../sketch-solver/src/topology/mod.rs')

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
    OCC_CONFUSION,
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

  // The relationship the profile handoff actually depends on, and the one thing
  // no test stated before: three different predicates decide "closed", and they
  // run in the order loosest-first. TOL_TOPOLOGY_MERGE decides an area EXISTS,
  // TOL_LOOP_CLOSURE decides a loop is emitted from it, OCC_CONFUSION decides
  // whether the kernel will connect the resulting edges. Ordered the other way
  // round, every area the user can see would be one the kernel accepts; ordered
  // as they are, the band in between is a sketch that looks closed and is not.
  //
  // Deliberately its own `it`: the mirror test above asserts an exact Rust
  // count, and OCC_CONFUSION has no Rust twin.
  it('the tolerance ladder holds: OCC confusion < loop closure <= topology merge', () => {
    expect(OCC_CONFUSION).toBeLessThan(TOL_LOOP_CLOSURE)
    expect(TOL_LOOP_CLOSURE).toBeLessThanOrEqual(TOL_TOPOLOGY_MERGE)
  })

  // Asserting `!rust.has('OCC_CONFUSION')` would test the regex, not the code:
  // the mirror parser only ever matches `TOL_*`. What actually needs pinning is
  // the TS side of that contract -- every TOL_ constant declared here is either
  // mirrored in Rust or is the one documented exception. Renaming OCC_CONFUSION
  // to TOL_OCC_CONFUSION would then fail here instead of silently breaking the
  // exact-count assertion above.
  it('every TOL_ constant is mirrored in Rust, except the documented one', () => {
    const src = readFileSync(join(__dirname, '../solverConstants.ts'), 'utf8')
    const declared = [...src.matchAll(/export const (TOL_[A-Z_]+)\s*=/g)].map((m) => m[1])
    expect(declared.length).toBeGreaterThan(0)
    const rust = rustTolerances()
    // TOL_LOOP_CLOSURE is the loop-chaining tolerance; it has no Rust twin
    // because the chaining lives only on the TS side of the split.
    const unmirrored = declared.filter((n) => !rust.has(n))
    expect(unmirrored).toEqual(['TOL_LOOP_CLOSURE'])
  })
})
