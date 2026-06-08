/**
 * Per-doc fallback router for the WASM kernel migration (phase 2g).
 *
 * The router checks whether every feature kind in a document has a ported TS
 * solver. If yes, it dispatches locally through the TS kernel; if any unported
 * kind (e.g. `origin`) is present, the doc cannot be solved locally. The router
 * itself is the seam 2g flips default-on: there is no
 * explicit feature flag; the gate is always active and only the kind-set
 * membership determines which path a doc takes.
 *
 * ``createFeatureSolver`` is the key adapter: it wraps the OCC-backed leaf
 * solvers (which take ``(oc, scope, table, …)``) into the builder's pluggable
 * ``FeatureSolver`` signature so they can be injected as ``BuildDeps.trySolveFeature``.
 */

import type { OccModule } from './occ/occTypes'
import type { DisposeScope } from './occ/disposeScope'
import type { HandleTable } from './occ/handleTable'
import type { Repository } from './query'
import type { Body } from './types3d'
import type { FeatureSolver } from './builder'
import { solveExtrude } from './features/extrude'
import { solveRevolve } from './features/revolve'
import { solveSweep } from './features/sweep'
import { solveHole } from './features/hole'
import { solveBoolean } from './features/boolean'
import { solveFillet, solveChamfer } from './features/filletChamfer'
import { solveArray, solveCircularArray } from './features/array'
import { solveTransform, solveMirror } from './features/transformMirror'
import { solveDeleteBody } from './features/deleteBody'
import { solveImportStep } from './features/importStep'
import { solveSketch } from './features/sketch'
import { solvePlane } from './features/plane'

// ── Ported kind set ──────────────────────────────────────────────────────

/** Feature kinds that have a TS/WASM solver. */
export const PORTED_FEATURE_KINDS = Object.freeze(new Set([
  'sketch',
  'plane',
  'extrude',
  'revolve',
  'sweep',
  'fillet',
  'chamfer',
  'boolean',
  'hole',
  'array',
  'circular_array',
  'transform',
  'mirror',
  'delete_body',
  'import_step',
]))

/** Kinds that the TS kernel cannot solve (origin, etc.). */
export const UNPORTED_KINDS = new Set([
  'origin',
])

// ── Per-doc gate ─────────────────────────────────────────────────────────

/** Return true when every feature in `features` has a ported TS solver. */
export function isDocFullyPorted(features: Array<{ kind?: unknown }>): boolean {
  for (const f of features) {
    const kind = f.kind as string | undefined
    if (!kind) continue
    if (!PORTED_FEATURE_KINDS.has(kind)) return false
  }
  return true
}

/**
 * Return the set of unported kinds found in `features`, or an empty set when
 * every kind is ported.  Useful for diagnostics.
 */
export function unportedKinds(features: Array<{ kind?: unknown }>): Set<string> {
  const missing = new Set<string>()
  for (const f of features) {
    const kind = f.kind as string | undefined
    if (kind && !PORTED_FEATURE_KINDS.has(kind)) missing.add(kind)
  }
  return missing
}

// ── Kind → solver dispatch ───────────────────────────────────────────────

type LeafSolver = (
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Record<string, unknown>,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
  featuresById?: Record<string, Record<string, unknown>>,
) => Record<string, unknown>

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _s = (fn: (...args: any[]) => any): LeafSolver => fn

const KIND_SOLVER: Record<string, LeafSolver> = {
  sketch: _s((_oc, _scope, _table, feature: Record<string, unknown>, globalRepo: Repository, bodyStore: Record<string, Body>) =>
    solveSketch(feature, globalRepo, bodyStore),
  ),
  plane: _s(solvePlane),
  extrude: _s(solveExtrude),
  revolve: _s(solveRevolve),
  sweep: _s(solveSweep),
  hole: _s(solveHole),
  boolean: _s(solveBoolean),
  fillet: _s(solveFillet),
  chamfer: _s(solveChamfer),
  array: _s(solveArray),
  circular_array: _s(solveCircularArray),
  transform: _s(solveTransform),
  mirror: _s(solveMirror),
  delete_body: _s(solveDeleteBody),
  import_step: _s(solveImportStep),
}

/** Resolve a leaf solver for the given feature kind, or null if unported. */
export function getSolver(kind: string): LeafSolver | null {
  return KIND_SOLVER[kind] ?? null
}

// ── Builder adapter ──────────────────────────────────────────────────────

/**
 * Create a ``FeatureSolver`` adapter that dispatches per-feature-kind to
 * the correct OCC-backed TS solver.
 *
 * This is the glue that plugs the TS kernel into ``builder.ts``'s
 * ``BuildDeps.trySolveFeature`` slot.  The caller owns the ``OccModule``,
 * ``DisposeScope``, and ``HandleTable`` lifetimes (typically one scope per
 * build, disposed after ancestry registration).
 */
export function createFeatureSolver(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  ): FeatureSolver {
  return (
    feature: Record<string, unknown>,
    globalRepo: Repository,
    bodyStore: Record<string, Body>,
    featuresById: Record<string, Record<string, unknown>>,
  ) => {
    const kind = feature.kind as string | undefined
    if (!kind) {
      return { status: 'exception', exception: 'feature missing kind' }
    }
    const solver = KIND_SOLVER[kind]
    if (!solver) {
      return { status: 'exception', exception: `unported feature kind: ${kind}` }
    }
    // hole.ts takes featuresById as its 7th argument; other solvers ignore it.
    return solver(oc, scope, table, feature, globalRepo, bodyStore, featuresById)
  }
}
