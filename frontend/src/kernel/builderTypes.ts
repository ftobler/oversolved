// Public types for the feature-stack builder. They live here so the
// orchestration, ancestry-registration and validation modules can share them
// without importing builder.ts back (which would close a cycle).

import type { Repository } from './query'
import type { Body, BuildState } from './types3d'

export interface FeatureResult {
  [key: string]: unknown
  status?: string
  solve_ms?: number
}

export type FeatureSolver = (
  feature: Record<string, unknown>,
  globalRepo: Repository,
  bodyStore: Record<string, Body>,
  featuresById: Record<string, Record<string, unknown>>,
  variableContext?: Record<string, number>,
) => FeatureResult

export interface BuildDeps {
  // Solve a single feature. Called by the orchestration loop.
  trySolveFeature: FeatureSolver
  // Register solved geometry / topology into the repo after a feature solves.
  postRegister: (
    repo: Repository,
    featureId: string,
    feature: Record<string, unknown>,
    result: FeatureResult,
  ) => void
  // Create a fresh global repository.
  initGlobalRepo: () => Repository
  // Tessellate all bodies in the store (triangles for rendering).
  tessellateBodies: (
    bodyStore: Record<string, Body>,
    repo: Repository | null,
  ) => Record<string, Record<string, unknown>>
  /** Mesh-free B-rep identification (face_data/face_queries + edges/vertices and
   *  their queries) used by the in-loop ancestry registration, so "tessellation
   *  is for eyes only": the feature loop never triangulates to identify entities.
   *  Returns the same shape as ``tessellateBodies`` (a ``mesh`` with empty
   *  geometry arrays but populated ``face_data``). Optional -- when omitted (pure
   *  non-OCC tests) registration falls back to ``tessellateBodies``. */
  extractBrepMetadata?: (
    bodyStore: Record<string, Body>,
    repo: Repository | null,
  ) => Record<string, Record<string, unknown>>
  // Optional: normalize legacy projected_* entity kinds. Defaults to identity.
  normalizeProjectedEntities?: (f: Record<string, unknown>) => Record<string, unknown>
  /** Compute face geometry hashes for brep_diff.new_faces. Called per-body
   *  inside the feature loop / checkpoint assembly while OCC handles are live,
   *  so the downstream ``face_created_by`` tag correctly distinguishes new faces
   *  (attributed to the modifying feature) from inherited faces (original
   *  creator). When omitted, all faces get ``body.created_by``. */
  brepDiffNewFaceHashes?: (body: Body) => Set<string>
  /** Compute edge geometry hashes for brep_diff.new_edges. Same contract as
   *  ``brepDiffNewFaceHashes`` but for edge ancestry. */
  brepDiffNewEdgeHashes?: (body: Body) => Set<string>
  /** Compute vertex geometry hashes for purely-new vertices (endpoints of new
   *  edges minus endpoints of inherited edges). Same contract. */
  brepDiffNewVertexHashes?: (body: Body) => Set<string>
  /** Retain a checkpoint's live shape under an owner tag so a later feature in
   *  the same build that consumes/frees that shape cannot strand the snapshot,
   *  and the shape survives into the next build for incremental restore. A pure
   *  refcount bump -- it never touches the OCC shape, so it cannot disturb a
   *  downstream maker operating on the same handle (copying it here does). */
  retainCheckpointShape?: (shape: NonNullable<Body['shape']>, owner: string) => void
  /** Defensive copy of a (pristine, prev-build) checkpoint shape into a fresh
   *  handle, used only when restoring the clean prefix: the rebuilt tail may
   *  consume/free it, so it must be independent of the retained checkpoint copy
   *  that future rebuilds restore from again. When omitted (pure non-OCC tests)
   *  the handle is aliased. The copy is registered under ``owner`` (the per-
   *  build [[RESTORE_OWNER]] tag) so the next build's ``releaseRestoreCopies``
   *  can free it once the live store has replaced it -- an untagged copy would
   *  strand forever, invisible to every ``releaseOwner``. */
  copyBodyShape?: (
    shape: NonNullable<Body['shape']>,
    owner?: string,
  ) => NonNullable<Body['shape']>
  /** Evict every shape a discarded checkpoint held, by owner tag. Called for
   *  prev-state checkpoints that a new build discards. The wiring must drop
   *  BOTH remaining owners of the outgoing generation: the checkpoint retain
   *  (``'cp:' + fid``) and the base body registration (owner = the PRODUCING
   *  feature id -- bodySplit tags new bodies and replacements alike with the
   *  feature that minted them). The retain alone leaves rc>=1 on every
   *  superseded shape; for a modifier edit the leftover ref sits under a
   *  still-clean creator and strands one solid per edit. */
  releaseCheckpoint?: (fid: string) => void
  /** Release the previous build's clean-prefix restore copies (owner tag
   *  [[RESTORE_OWNER]]). Called right before the restore mints fresh ones, so
   *  exactly one generation of copies is ever alive; copies a surviving clean
   *  checkpoint retained stay at its ``cp:*`` reference until that checkpoint
   *  is itself evicted. */
  releaseRestoreCopies?: () => void
  /** Deps bound to a THROWAWAY scope + HandleTable plus its ``dispose()``,
   *  used for the second full build behind ``spec._validate``. That comparison
   *  build discards its BuildState when validation ends, so handed the
   *  caller's deps it pins every inner shape in the persistent cache under
   *  ``<fid>`` / ``'cp:'+fid`` owners that no later eviction can ever name --
   *  one stranded solid generation per validated solve. Fresh wiring here
   *  contains the inner generation completely: ``dispose()`` drops scope and
   *  table wholesale once the diff is computed. When omitted (pure non-OCC
   *  tests) validation runs on the caller's own deps. */
  isolatedValidationDeps?: () => { deps: BuildDeps; dispose: () => void }
}

export interface BuildOptions {
  prevState?: BuildState | null
  pickBoundary?: number | null
  rollbackPosition?: number | null
}

export interface BuildResponse {
  solve_ms: number
  result: Record<string, unknown>
  bodies: Record<string, unknown>
  // The worker owns `_build_state` (checkpoint cache) and mutates it between
  // solves; main-thread consumers must treat it as read-only. The solver-client
  // stub that satisfies this field is deeply frozen.
  _build_state: Readonly<BuildState>
  pick_bodies?: Record<string, unknown>
  _validation?: RebuildValidation
}

export interface RebuildValidation {
  level: 1 | 2 | 3
  passed: boolean
  fp_only?: boolean
  diffs: Record<string, unknown>
}
