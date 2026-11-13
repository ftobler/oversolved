/**
 * Per-doc solvability gate for the WASM kernel.
 *
 * The router checks whether every feature kind in a document has a ported TS
 * solver. If yes, it dispatches locally through the TS kernel; if any unported
 * kind (e.g. `origin`) is present, the doc cannot be solved at all -- the Python
 * kernel that once served as the fallback is gone, so useSolver
 * surfaces a "Cannot solve" error instead. There is no explicit feature flag;
 * the gate is always active and only the kind-set membership decides whether a
 * doc is solvable.
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
import type { FeatureKind, PartFeature } from '@/types/cad'
import type { FeatureSolver } from './builder'
import { solveExtrude } from './features/extrude'
import { solveRevolve } from './features/revolve'
import { solveSweep } from './features/sweep'
import { solveHole } from './features/hole'
import { solveBoolean } from './features/boolean'
import { solveFillet, solveChamfer } from './features/filletChamfer'
import { solveShell } from './features/shell'
import { solveMoveFace } from './features/moveFace'
import { solveDeleteFace } from './features/deleteFace'
import { solvePattern } from './features/pattern'
import { solveTransform, solveMirror } from './features/transformMirror'
import { solveSplit } from './features/splitByPlane'
import { solveDeleteBody } from './features/deleteBody'
import { solveImportStep } from './features/importStep'
import { solveSketch } from './features/sketch'
import { faceBoundaryLookup } from './features/faceBoundary'
import { solvePlane } from './features/plane'
import { solveHelix } from './features/helix'
import { solveVariable } from './features/variable'
import { nestedFeatureParams } from './features/shared/featureParams'

// ─── Kind → solver dispatch ───

/**
 * Kinds the dispatch table covers. `origin` has no solver: it is a builtin repo
 * result, never a solved feature. `import_step` needs the per-build file map,
 * which is not on the shared dispatcher signature, so createFeatureSolver wires
 * it directly. The exclusion is the compiler's: add a variant to PartFeature
 * and this table fails to type-check until a solver lands beside it.
 */
type DispatchedKind = Exclude<FeatureKind, 'origin' | 'import_step'>

type FeatureOf<K extends FeatureKind> = Extract<PartFeature, { kind: K }>

/**
 * The dispatch signature with the feature parameter pinned to its variant, so
 * the table must carry one entry per kind and every call through it is typed to
 * that kind's variant. A solver swapped in for another kind evades the check
 * while the leaf solvers still accept a raw record; that typing is the
 * ratchet's work, not this table's.
 */
/**
 * The named variables already evaluated before the current feature, handed to a
 * leaf that re-solves an earlier feature from its raw spec (the pattern leaf
 * builds its source's tool). Every other leaf ignores it.
 */
export interface SolveVariableContext {
  variables: Record<string, number>
  laterVariables: Record<string, number>
}

type LeafSolver<K extends DispatchedKind> = (
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: FeatureOf<K>,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
  featuresById: Record<string, Record<string, unknown>>,
  solveContext?: SolveVariableContext,
) => Record<string, unknown>

export type SolverTable = { [K in DispatchedKind]: LeafSolver<K> }

const KIND_SOLVER: SolverTable = {
  sketch: (oc, _scope, table, feature, globalRepo, bodyStore, featuresById) =>
    solveSketch(
      feature,
      globalRepo,
      bodyStore,
      featuresById,
      // The sketch leaf is blind to OCC; the builder hands it the one lookup it
      // needs for a face projection's boundary (plain strings out).
      faceBoundaryLookup(oc, table, bodyStore, globalRepo),
    ),
  plane: solvePlane,
  helix: solveHelix,
  extrude: solveExtrude,
  revolve: solveRevolve,
  sweep: solveSweep,
  hole: solveHole,
  boolean: solveBoolean,
  fillet: solveFillet,
  chamfer: solveChamfer,
  shell: solveShell,
  move_face: solveMoveFace,
  delete_face: solveDeleteFace,
  pattern: solvePattern,
  transform: solveTransform,
  mirror: solveMirror,
  split: solveSplit,
  delete_body: solveDeleteBody,
  // Variables carry no OCC geometry. The builder path short-circuits them in
  // ``createFeatureSolver`` (passing the live variable context); this entry is
  // the ``getSolver`` fallback and resolves against an empty context.
  variable: (_oc, _scope, _table, feature) => solveVariable(feature, {}),
}

type AnyLeafSolver = SolverTable[DispatchedKind]

function isDispatchedKind(kind: string): kind is DispatchedKind {
  return Object.hasOwn(KIND_SOLVER, kind)
}

/** Resolve a leaf solver for the given feature kind, or null if unported. */
export function getSolver(kind: string): AnyLeafSolver | null {
  return isDispatchedKind(kind) ? KIND_SOLVER[kind] : null
}

// ─── Ported kind set ───

/**
 * Feature kinds that have a TS/WASM solver. Derived from the dispatch table
 * plus the import_step special case, so the gate and the table cannot drift:
 * a kind counts as solvable exactly when createFeatureSolver can dispatch it.
 */
export const PORTED_FEATURE_KINDS: ReadonlySet<string> = Object.freeze(
  new Set<string>([...Object.keys(KIND_SOLVER), 'import_step']),
)

// ─── Per-doc gate ───

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

// ─── Expression resolution ───

// Kept re-exported here: callers and tests reach the one resolver through the
// dispatch module, while the pattern leaf imports the implementation directly
// and does not drag the solver table into the cycle.
import { resolveFeatureExpressions } from './featureExpressions'
export { resolveFeatureExpressions }

// ─── Builder adapter ───

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
  files?: ReadonlyMap<string, Uint8Array>,
  ): FeatureSolver {
  return (
    feature: Record<string, unknown>,
    globalRepo: Repository,
    bodyStore: Record<string, Body>,
    featuresById: Record<string, Record<string, unknown>>,
    variableContext: Record<string, number> = {},
    laterVariables: Record<string, number> = {},
  ) => {
    const kind = feature.kind as string | undefined
    if (!kind) {
      return { status: 'exception', exception: 'feature missing kind' }
    }
    // Canonical params once, here: a flat param is legacy input and is folded
    // into the sub-dict (flat wins) before any leaf reads it, so the leaf
    // solvers below only ever read the sub-dict. resolveFeatureExpressions
    // repeats the fold harmlessly (it is idempotent) to stay correct when a
    // caller reaches it directly.
    const canonical = nestedFeatureParams(feature).feature
    // Variables carry no geometry: evaluate their expression against the
    // accumulated variable context and short-circuit the OCC path entirely.
    if (kind === 'variable') {
      return solveVariable(canonical, variableContext, laterVariables)
    }
    // import_step is special-cased next to variable because it needs the solve
    // file map, which is not on the shared FeatureSolver signature. Resolve its
    // expression params (scale) first, exactly as the generic dispatch would.
    if (kind === 'import_step') {
      const resolvedImport = resolveFeatureExpressions(canonical, variableContext, laterVariables)
      if ('exception' in resolvedImport) {
        return { status: 'exception', exception: resolvedImport.exception }
      }
      return solveImportStep(oc, scope, table, resolvedImport.feature, globalRepo, bodyStore, files)
    }
    if (!isDispatchedKind(kind)) {
      return { status: 'exception', exception: `unported feature kind: ${kind}` }
    }
    // Resolve any math-expression params (e.g. distance="50+25") to numbers
    // before dispatch. Named variables from preceding features supply the
    // context; the leaf solvers only ever read numbers.
    const resolved = resolveFeatureExpressions(canonical, variableContext, laterVariables)
    if ('exception' in resolved) {
      return { status: 'exception', exception: resolved.exception }
    }
    // hole.ts and boolean.ts take featuresById as their 7th argument; other
    // solvers ignore it. The pattern leaf alone reads the variable context, to
    // resolve an earlier source feature's expressions exactly as the source's
    // own solve did.
    return dispatchFeature(
      kind, oc, scope, table, resolved.feature, globalRepo, bodyStore, featuresById,
      { variables: variableContext, laterVariables },
    )
  }
}

/**
 * Call the table entry for `kind`. The feature reaches the kernel as a
 * structured clone off the worker wire, so the runtime kind check above is the
 * only thing that makes the variant assumption true; this cast is that blind
 * boundary, not an erasure of the dispatch type -- the table's mapped type
 * still ties every kind to its variant at registration.
 */
function dispatchFeature<K extends DispatchedKind>(
  kind: K,
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Record<string, unknown>,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
  featuresById: Record<string, Record<string, unknown>>,
  solveContext: SolveVariableContext,
): Record<string, unknown> {
  return KIND_SOLVER[kind](
    oc, scope, table, feature as FeatureOf<K>, globalRepo, bodyStore, featuresById, solveContext,
  )
}
