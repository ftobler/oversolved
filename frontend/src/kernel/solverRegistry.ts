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
import { solveArray, solveCircularArray } from './features/array'
import { solveTransform, solveMirror } from './features/transformMirror'
import { solveDeleteBody } from './features/deleteBody'
import { solveImportStep } from './features/importStep'
import { solveSketch } from './features/sketch'
import { solvePlane } from './features/plane'
import { solveHelix } from './features/helix'
import { solveVariable } from './features/variable'
import { nestedFeatureParams } from './features/shared/featureParams'
import { evalFeatureParams, EXPR_FIELDS_BY_KIND, isExprFieldKind, type ExprFieldKind } from './evalExpr'

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
type LeafSolver<K extends DispatchedKind> = (
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: FeatureOf<K>,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
  featuresById: Record<string, Record<string, unknown>>,
) => Record<string, unknown>

export type SolverTable = { [K in DispatchedKind]: LeafSolver<K> }

const KIND_SOLVER: SolverTable = {
  sketch: (_oc, _scope, _table, feature, globalRepo, bodyStore, featuresById) =>
    solveSketch(feature, globalRepo, bodyStore, featuresById),
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
  array: solveArray,
  circular_array: solveCircularArray,
  transform: solveTransform,
  mirror: solveMirror,
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

/**
 * Where each kind's expression-capable params live. Most kinds nest them under
 * `feature[kind]`; `plane` keeps them in `feature.definition`; `import_step`
 * reads `scale` straight off the feature. An empty string means feature-level.
 * Each value is pinned to a key of that kind's payload, so a mistyped sub-key
 * cannot survive a rename of the def field it names.
 */
type ExprSubKey<K extends ExprFieldKind> = '' | Extract<keyof FeatureOf<K>, string>

const EXPR_SUBKEY_BY_KIND: { [K in ExprFieldKind]: ExprSubKey<K> } = {
  extrude: 'extrude',
  revolve: 'revolve',
  fillet: 'fillet',
  chamfer: 'chamfer',
  shell: 'shell',
  move_face: 'move_face',
  hole: 'hole',
  array: 'array',
  circular_array: 'circular_array',
  transform: 'transform',
  plane: 'definition',
  helix: 'helix',
  import_step: '',
  boolean: 'boolean',
}

/**
 * Resolve any expression-string params on a feature to numbers before the leaf
 * solver runs. A feature is canonicalized first: every flat param is folded into
 * the sub-dict (flat wins, the same rule the loader migration applies), so the
 * one target evaluated is the sub-dict (the feature itself for `import_step`,
 * whose `scale` is feature-level by design). Returns a shallow copy with the
 * sub-dict cloned and evaluated; the original feature (and the document) keeps
 * its raw expression strings. Plain-number fields are untouched, so legacy docs
 * cost nothing.
 *
 * On a failed evaluation the leaf solver is never reached: an `exception`
 * result is returned carrying the parse message. `context` supplies named
 * variables (currently empty; the variable table feature will populate it).
 */
export function resolveFeatureExpressions(
  feature: Record<string, unknown>,
  context: Record<string, number> = {},
  laterVariables: Record<string, number> = {},
): { feature: Record<string, unknown> } | { exception: string } {
  const kind = feature.kind as string | undefined
  if (!kind) return { feature }
  if (!isExprFieldKind(kind)) return { feature }
  const exprFields = EXPR_FIELDS_BY_KIND[kind]

  const { feature: canonical } = nestedFeatureParams(feature)
  const subKey = EXPR_SUBKEY_BY_KIND[kind]
  const copy: Record<string, unknown> = { ...canonical }
  const target: Record<string, unknown> = subKey === ''
    ? copy
    : (copy[subKey] = { ...(copy[subKey] as Record<string, unknown> | undefined) })

  evalFeatureParams(target, exprFields, context, laterVariables)

  const errKey = Object.keys(target).find((k) => k.endsWith('_error'))
  if (errKey) return { exception: String(target[errKey]) }

  return { feature: copy }
}

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
    // hole.ts takes featuresById as its 7th argument; other solvers ignore it.
    return dispatchFeature(kind, oc, scope, table, resolved.feature, globalRepo, bodyStore, featuresById)
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
): Record<string, unknown> {
  return KIND_SOLVER[kind](oc, scope, table, feature as FeatureOf<K>, globalRepo, bodyStore, featuresById)
}
