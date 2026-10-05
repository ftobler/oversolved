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
import { solveVariable } from './features/variable'
import { evalFeatureParams, EXPR_FIELDS_BY_KIND } from './evalExpr'

// ─── Ported kind set ───

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
  'variable',
]))

/** Kinds that the TS kernel cannot solve (origin, etc.). */
export const UNPORTED_KINDS = new Set([
  'origin',
])

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

// ─── Kind → solver dispatch ───

type LeafSolver = (
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  feature: Record<string, unknown>,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
  featuresById?: Record<string, Record<string, unknown>>,
) => Record<string, unknown>

// Leaf solvers take heterogeneous parameter lists; this catch-all accepts any
// of them, and the cast narrows the erased result to the dispatch signature.
type HeterogeneousSolver = (...args: never[]) => unknown
const _s = (fn: HeterogeneousSolver): LeafSolver => fn as unknown as LeafSolver

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
  // Variables carry no OCC geometry. The builder path short-circuits them in
  // ``createFeatureSolver`` (passing the live variable context); this entry is
  // the ``getSolver`` fallback and resolves against an empty context.
  variable: _s((_oc, _scope, _table, feature: Record<string, unknown>) => solveVariable(feature, {})),
}

/** Resolve a leaf solver for the given feature kind, or null if unported. */
export function getSolver(kind: string): LeafSolver | null {
  return KIND_SOLVER[kind] ?? null
}

// ─── Expression resolution ───

/**
 * Where each kind's expression-capable params live. Most kinds nest them under
 * `feature[kind]`; `plane` keeps them in `feature.definition`; `import_step`
 * reads `scale` straight off the feature. An empty string means feature-level.
 */
const EXPR_SUBKEY_BY_KIND: Record<string, string> = {
  extrude: 'extrude',
  revolve: 'revolve',
  fillet: 'fillet',
  chamfer: 'chamfer',
  hole: 'hole',
  array: 'array',
  circular_array: 'circular_array',
  transform: 'transform',
  plane: 'definition',
  import_step: '',
}

/**
 * Resolve any expression-string params on a feature to numbers before the leaf
 * solver runs. Returns a shallow copy with the relevant sub-dict cloned and
 * evaluated; the original feature (and the document) keeps its raw expression
 * strings. Plain-number fields are untouched, so legacy docs cost nothing.
 *
 * On a failed evaluation the leaf solver is never reached: an `exception`
 * result is returned carrying the parse message. `context` supplies named
 * variables (currently empty; the variable table feature will populate it).
 */
export function resolveFeatureExpressions(
  feature: Record<string, unknown>,
  context: Record<string, number> = {},
): { feature: Record<string, unknown> } | { exception: string } {
  const kind = feature.kind as string | undefined
  if (!kind) return { feature }
  const exprFields = EXPR_FIELDS_BY_KIND[kind]
  if (!exprFields) return { feature }

  // Leaf solvers overlay feature-level fields over the sub-dict
  // (`{ ...sub, ...feature }`), so a param may be stored either flat on the
  // feature or nested under its sub-key. Evaluate both so neither storage form
  // silently slips past with an unresolved expression string.
  const subKey = EXPR_SUBKEY_BY_KIND[kind] ?? ''
  const copy: Record<string, unknown> = { ...feature }
  const targets: Record<string, unknown>[] = [copy]
  if (subKey !== '') {
    copy[subKey] = { ...(copy[subKey] as Record<string, unknown> | undefined) }
    targets.push(copy[subKey] as Record<string, unknown>)
  }

  for (const target of targets) evalFeatureParams(target, exprFields, context)

  for (const target of targets) {
    const errKey = Object.keys(target).find((k) => k.endsWith('_error'))
    if (errKey) return { exception: String(target[errKey]) }
  }

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
  ) => {
    const kind = feature.kind as string | undefined
    if (!kind) {
      return { status: 'exception', exception: 'feature missing kind' }
    }
    // Variables carry no geometry: evaluate their expression against the
    // accumulated variable context and short-circuit the OCC path entirely.
    if (kind === 'variable') {
      return solveVariable(feature, variableContext)
    }
    // import_step is special-cased next to variable because it needs the solve
    // file map, which is not on the shared FeatureSolver signature. Resolve its
    // expression params (scale) first, exactly as the generic dispatch would.
    if (kind === 'import_step') {
      const resolvedImport = resolveFeatureExpressions(feature, variableContext)
      if ('exception' in resolvedImport) {
        return { status: 'exception', exception: resolvedImport.exception }
      }
      return solveImportStep(oc, scope, table, resolvedImport.feature, globalRepo, bodyStore, files)
    }
    const solver = KIND_SOLVER[kind]
    if (!solver) {
      return { status: 'exception', exception: `unported feature kind: ${kind}` }
    }
    // Resolve any math-expression params (e.g. distance="50+25") to numbers
    // before dispatch. Named variables from preceding features supply the
    // context; the leaf solvers only ever read numbers.
    const resolved = resolveFeatureExpressions(feature, variableContext)
    if ('exception' in resolved) {
      return { status: 'exception', exception: resolved.exception }
    }
    // hole.ts takes featuresById as its 7th argument; other solvers ignore it.
    return solver(oc, scope, table, resolved.feature, globalRepo, bodyStore, featuresById)
  }
}
