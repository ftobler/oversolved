import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  GPROP_EPS,
  OCC_CONFUSION,
  TOL_LENGTH_SLACK,
  TOL_LOOP_CLOSURE,
  TOL_MOVE_FACE_TANGENT,
  TOL_NEAR_ZERO_AREA,
  TOL_PREVIEW_CELL,
  TOL_SELECT_DIRECTION,
  TOL_SURFACE_IDENTITY,
  TOL_SURFACE_PARALLEL,
  TOL_TOPOLOGY_EPS,
  TOL_TOPOLOGY_MERGE,
  TOL_TOPOLOGY_SPLIT,
  TOL_VOLUME_DEGENERATE,
  TOL_VOLUME_SUM,
} from '../solverConstants'
import { DEFAULT_MEASURE_TOLERANCE } from '../occ/measureTolerance'

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
    GPROP_EPS,
    OCC_CONFUSION,
    TOL_LOOP_CLOSURE,
    TOL_NEAR_ZERO_AREA,
    TOL_TOPOLOGY_EPS,
    TOL_TOPOLOGY_MERGE,
    TOL_TOPOLOGY_SPLIT,
    TOL_SELECT_DIRECTION,
    TOL_SURFACE_IDENTITY,
    TOL_SURFACE_PARALLEL,
    TOL_LENGTH_SLACK,
    TOL_VOLUME_DEGENERATE,
    TOL_VOLUME_SUM,
    TOL_PREVIEW_CELL,
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
  // mirrored in Rust or is a declared frontend-side rung. Renaming OCC_CONFUSION
  // to TOL_OCC_CONFUSION would then fail here instead of silently breaking the
  // exact-count assertion above.
  //
  // The two kinds are the whole ladder: the four sketch-topology rungs mirror
  // Rust because vertex-merge order feeds the query strings on both sides, and
  // the rungs below judge OCC reads (surface identity, direction, volume
  // budgets) or OCC tessellation (the preview lattice), which the sketch solver
  // never sees. A new rung joins one of the two lists deliberately; the exact
  // count in the mirror test is what makes an unlisted rename fail.
  const TS_ONLY_TOLERANCES = [
    'TOL_LOOP_CLOSURE',  // the loop chaining lives only on the TS side of the split
    'TOL_MOVE_FACE_TANGENT',
    'TOL_SELECT_DIRECTION',
    'TOL_SURFACE_IDENTITY',
    'TOL_SURFACE_PARALLEL',
    'TOL_LENGTH_SLACK',
    'TOL_VOLUME_DEGENERATE',
    'TOL_VOLUME_SUM',
    'TOL_PREVIEW_CELL',
  ]

  it('every TOL_ constant is mirrored in Rust or listed as a TS-side rung', () => {
    const src = readFileSync(join(__dirname, '../solverConstants.ts'), 'utf8')
    const declared = [...src.matchAll(/export const (TOL_[A-Z_]+)\s*=/g)].map((m) => m[1])
    expect(declared.length).toBeGreaterThan(0)
    const rust = rustTolerances()
    const unmirrored = declared.filter((n) => !rust.has(n))
    expect(unmirrored).toEqual(TS_ONLY_TOLERANCES)
  })

  // The order of the rungs is the claim the ladder comments make, and the one
  // thing a value edit can break silently. Length and angle rungs are world
  // quantities and compare with each other and with OCC's compiled-in confusion;
  // the volume budgets are fractions of the volume they judge, so they only
  // compare with each other.
  it('the TS-side rungs hold their stated order', () => {
    expect(TOL_LENGTH_SLACK).toBeLessThan(OCC_CONFUSION)  // f64 noise, under the kernel floor
    expect(OCC_CONFUSION).toBeLessThan(TOL_SURFACE_IDENTITY)  // kernel floor, under authored identity
    expect(TOL_SURFACE_IDENTITY).toBe(TOL_LOOP_CLOSURE)  // one scale for "this point is on this geometry"
    expect(TOL_SURFACE_PARALLEL).toBeLessThan(TOL_SURFACE_IDENTITY)  // analytic axes: noise only
    expect(TOL_VOLUME_DEGENERATE).toBeLessThan(TOL_VOLUME_SUM)  // empty vs additive closure
    // The read's accuracy target must sit under the budget it feeds, or the
    // guard would be judging the integrator's own error.
    expect(GPROP_EPS).toBeLessThan(TOL_VOLUME_SUM)
    expect(TOL_PREVIEW_CELL).toBe(TOL_MOVE_FACE_TANGENT)  // the two coarse rendering-side rungs stand level
    expect(TOL_PREVIEW_CELL).toBeGreaterThan(TOL_SURFACE_IDENTITY)  // a rendering coincidence, not a solver decision
    // select's position clauses (extreme, center, within) lean on the measure
    // floor spelled in occ/measureTolerance; if it drifts off the ladder, the
    // selector answers on a rung this file no longer names.
    expect(DEFAULT_MEASURE_TOLERANCE.abs).toBe(TOL_SURFACE_IDENTITY)
  })

  // The ladder's whole point is that a rung is declared once. These are the
  // modules the tolerance sweep migrated: each carried private literals
  // (SURFACE_TOL, UV_TOL, TOOL_FACE_TOL, SHAPE_TOL, VOLUME_EPS, DIRECTION_EPS,
  // a bare `* 1000` quantizer). A new module-level `const NAME = 1e-x` in one of
  // them is a rung that bypassed this file, and it fails here rather than in
  // geometry two features later.
  const MIGRATED_MODULES = [
    '../select/select.ts',
    '../occ/offsetShape.ts',
    '../occ/moveFace.ts',
    '../occ/moveFaceSurfaces.ts',
    '../features/splitByPlane.ts',
    '../features/hole.ts',
    '../features/shell.ts',
    '../features/sweep.ts',
    '../../components/Geometry3D/PreviewEdgeOverlay.tsx',
  ]

  it('the migrated modules declare no private tolerance literals', () => {
    for (const rel of MIGRATED_MODULES) {
      const src = readFileSync(join(__dirname, rel), 'utf8')
      const literals = [...src.matchAll(/^(?:const|let) ([A-Z][A-Z0-9_]*) = 1e-/gm)].map((m) => m[1])
      expect(literals, `${rel} declares private tolerance literal(s)`).toEqual([])
    }
  })
})
