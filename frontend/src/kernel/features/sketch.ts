/**
 * The sketch constraint solver, backed by the Rust WASM kernel.
 *
 * Takes a sketch feature in the live PartDoc format (``$``-ref constraints,
 * optional ``source`` on projected entities, ``center_rect`` sugar) and lowers
 * it through the same pipeline the shadow comparator uses. Returns a result
 * dict compatible with ``applySolveResult`` so downstream features can
 * reference the solved geometry via the repository.
 *
 * The WASM binary is loaded asynchronously once (``initSketchSolver()``) and
 * cached; the actual ``solveSketch`` call is synchronous. When the binary is
 * unavailable (not provisioned under ``/wasm/``), ``solveSketch`` throws so the
 * builder's try/catch returns a clean exception (the browser kernel is the only
 * solver; there is no backend fallback).
 *
 * center_rect sugar is expanded by the mutation layer before a doc reaches the
 * kernel; the reject further down is a defensive skip for hand-edited or
 * imported documents that still carry the raw sugar.
 */

import type { Sketch, SketchFeature, Entity, Constraints, PartDoc, PartFeature } from '@/types/cad'
import { getEntityKind } from '@/types/cad'
import type { Repository } from '../query'
import { getPoint3d } from '../query'
import type { PartSolid } from '../types3d'
import { partDocToSketches, type DroppedConstraint } from '@/wasm-kernel/partDocToSketches'
import { lowerSketch, ORIGIN_ID, type EntityLayout } from '@/wasm-kernel/lowerSketch'
import {
  encodeInput, decodeOutput, STATUS_NAME, Status, CONSTRAINT_FLAG, ConstraintKindCode, Sel,
  type FlatConstraint, type FlatDragAnchor, type FlatInput, type SolverOutput,
} from '@/wasm-kernel/codec'
import type { DragMember } from '@/types/drag'
import { entityVertexIndices, entityCoordPairs, fitSplineHandlesFromFlags } from '@/registry'
import { deriveConstraints, unflattenGeometry } from '@/utils/geometry/geometryMapping'
import { ellipseAxisDrag, isEllipseAxisKey, type EllipseAxisKey } from '@/utils/geometry/ellipseAxis'
import { ignoredConstraintWarning, weakConstraintNoun, weakConstraintWarning } from '@/utils/constraintProblems'
import { constraintDisplayName, entityDisplayName, featureDisplayName, featureRows, sketchDisplayName } from '@/utils/core/displayNames'
import {
  tangentKindsAdmitted,
  tangentNeedsSharedEndpointReason,
} from '@/utils/constraintApplicability'
import {
  ENTITY_SIZE_FLOOR, degenerateEntityWarning, entitySizeProblem, type DegenerateEntity,
} from '@/utils/entitySizeProblems'
import { solveTopology, reconcileMaterializedContacts, stampAreaBuildability, type TopologyBytes, type WireContact } from '../topologyDecorate'
import { declaredContacts } from './shared/declaredContacts'
import { frameToPlaneTransform, projectWorldToFrame, type Frame3D } from '../types3d'
import { resolveSketchPlane, enrichSketchEntity } from './postRegister'
import { loadProfileLoopsWasm, loadSolverWasm, loadTopologyWasm, resetSolverWasm } from '@/wasm-kernel/solverWasm'
import { setProfileLoopsBytes } from '@/wasm-kernel/profileLoops'
import { isKernelTrap, swallowUnlessTrap } from '../errors'
import { memoizedLoad } from '../occ/memoizedLoad'
import { resolveDragMode, PROBE_STEP_REL, type CircleDragMode } from './circleDragMode'
import { resolve3dGeometry, projectTo2d, projectCenter, type PlaneFrame } from './projectionLowering'
import { reconcileFaceProjection, classifyProjectionSource, isProjectionPosition, defaultProjectionBlock, isDefaultProjectionBlock, type ProjectionMemberEntity, type ProjectionMemberReport } from './projectionMembers'
import type { FaceBoundaryLookup } from './faceBoundary'
import type { PlaneLike } from './shared/planes'
import type { SolveBytes } from '@/wasm-kernel/codec'
import type { ProfileLoopsBytes, SketchSolverBundle } from '@/wasm-kernel/wasmTypes'

type Dict = Record<string, unknown>

export interface SketchResult {
  [key: string]: unknown
  status: string
  /** Remaining degrees of freedom from the solver's diagnostics. The MCP delta
   *  row repeats this count, and the underconstrained warning states it; the
   *  tree and editor read the warning text. */
  dof?: number
  /** Realised angular precision of the solved geometry, in radians, from the
   *  solver's contract finish (the target is `OCC_ANGULAR`). NaN means no
   *  measured miss for the shipped params: an unsatisfied solve, a drag frame,
   *  or a green solve whose finish was restored because it would have flipped
   *  the verdict. INFINITY is the solver's row-classification failure. The
   *  kernel half reads this to widen its own angular calls by what the solve
   *  actually reached. */
  angular_miss?: number
  /** Realised positional precision, in document length units (target
   *  `OCC_CONFUSION * 1e-2`). NaN and INFINITY as `angular_miss`. */
  linear_miss?: number
  geometry?: Record<string, number[]>
  features?: Record<string, { status: string }>
  /** Per-constraint solve facts, keyed by doc constraint id: the render block,
   *  the miss fraction and the non-driver (redundant) / culprit markers. Feeds
   *  `applySolveResult` so the constraint overlays can paint what the solve
   *  found; omitted when no constraint produced a render. */
  constraints?: Constraints
  /** The document origin (0,0,0) expressed in this sketch's local 2D frame.
   *  Both the hard solve and the drag path need the same value so @builtin_origin
   *  constraints pin to the same point. Computed once here, consumed by the drag
   *  path via solveResult.originLocal -- no round-trip recomputation. */
  originLocal?: [number, number]
  /** For projected entities whose lowered kind differs from the kind declared
   *  at pick time (tilted circle -> ellipse, partial ellipse -> spline): the
   *  resolved kind, so the doc entity can adopt it and its params stay matched. */
  resolved_kinds?: Record<string, string>
  /** Entity ids the cold solve moved by at least half the document's storage
   *  grid. The write-back keeps the authored `initial` array by reference for
   *  every entity absent here. Always present on a cold solve (possibly
   *  empty); the drag path commits through a mutation, not this report. */
  entity_moved?: string[]
  /** Entity ids of projected entities whose source query could not be resolved
   *  this solve. An unresolved projection with a cached position keeps it; one
   *  that never had a position is also left out of the geometry and the profile. */
  projection_errors?: string[]
  /** The subset of `projection_errors` whose held entity has no position: the
   *  rows the solve also leaves out of the geometry and the profile. */
  projection_unpositioned?: string[]
  /** Face projections only: the per-constraint derived membership this solve.
   *  The ids and params are solve-time facts (no member is a document row); the
   *  write-back installs only the `members` map, and a freeze mutation copies
   *  the entities into document rows through the journal. */
  projection_members?: Record<string, ProjectionMemberReport>
  /** The solved curves the size rule rejected, with the reason each one is left
   *  out of the profile topology. Kept structured so the verdict code can name
   *  the cause without parsing the joined warning text. */
  degenerate_entities?: DegenerateEntity[]
  /** The authored constraints this solve could not use, from both drop routes
   *  (the live-doc lowering and the solver's survivors filter). The sketch
   *  editor draws each as a red tile at its surviving local operand and the
   *  cleanup command removes them; the warning text names the same ids. */
  dropped_constraints?: DroppedConstraint[]
  /** The constraints the solve found weak (a second-order root): satisfied, yet
   *  holding the profile's direction only at an extreme. `moveEstimate` is how
   *  far the profile can rotate along it, in degrees. The warning text names
   *  them by kind and value; this list keeps the ids for machines. */
  weak_constraints?: Array<{ constraintId: string; moveEstimate: number }>
}

let solverBytes: SolveBytes | null = null
// The Rust area builder (`detect_topology_bytes`). The browser wires it in
// `initSketchSolver` (awaited alongside the solver); a headless loader brings
// it along in its bundle, and `setSketchTopology` injects it on its own. Only
// null on a fresh checkout with no `just wasm`, in which case the missing
// solver makes `solveSketch` throw first.
let topologyBytes: TopologyBytes | null = null

// The auto-loaded solver, memoized per successful result. The null/rejection
// eviction matters here: `loadSolverWasm` evicts its own failed package so a
// later call retries, and pinning this cell's null would leave every sketch
// failing with "Rust solver not initialised" for the session after one
// transient failure. The injectors (`setSketchSolver`/`resetSketchSolver`)
// reset the cell and put their bytes ahead of any auto-load.
const solverCell = memoizedLoad(async (): Promise<SolveBytes | null> => {
  // Wire the area builder alongside the solver (they share one wasm module) and
  // AWAIT both, so the first synchronous solve never races a half-loaded
  // topology. A null topology loader (mock / fresh checkout) leaves any
  // already-injected loader in place.
  let topoLoad: Promise<TopologyBytes | null>
  try {
    topoLoad = loadTopologyWasm?.() ?? Promise.resolve(null)
  } catch (e) {
    swallowUnlessTrap(e)
    topoLoad = Promise.resolve(null)
  }
  // The profile-loop family rides the same package. Isolate its loader the same
  // way so a mock without it leaves the facade to its own error.
  let loopsLoad: Promise<ProfileLoopsBytes | null>
  try {
    loopsLoad = loadProfileLoopsWasm?.() ?? Promise.resolve(null)
  } catch (e) {
    swallowUnlessTrap(e)
    loopsLoad = Promise.resolve(null)
  }
  const [bytes, topo, loops] = await Promise.all([
    loadSolverWasm(),
    topoLoad.catch(() => null),
    loopsLoad.catch(() => null),
  ])
  if (topo) topologyBytes = topo
  // Only install a facade the loader actually produced: a test mock (or a
  // build that predates the export) must not clobber one an injected host
  // already wired, exactly like the topology line above.
  if (loops) setProfileLoopsBytes(loops)
  solverBytes = bytes
  return bytes
})

// A loader that returns a FRESH sketch module (solver plus the area builder of
// the same instance) for a headless host: the nodejs package instantiates its
// wasm at require time, so after a trap only a new module is usable, never the
// cached one. Browser hosts and byte injectors leave this null; they reload
// through `solverCell` / `resetSolverWasm` instead.
let solverLoader: (() => SketchSolverBundle | null) | null = null

/** Put a loaded bundle into the module cells. The area builder is replaced with
 *  the solver because the two are one instance; a bundle whose topology export
 *  is missing must not keep the trapped instance's builder. */
function adoptSketchBundle(bundle: SketchSolverBundle | null): SolveBytes | null {
  if (bundle === null) return null
  solverBytes = bundle.solve
  topologyBytes = bundle.topology
  setProfileLoopsBytes(bundle.profileLoops)
  return bundle.solve
}

/** Inject a pre-loaded solver (node tests call this with ``loadSolver()``). An
 *  explicit injection has no reload source, so it also clears a loader: trap
 *  recovery then drops it instead of resurrecting a module the caller replaced. */
export function setSketchSolver(bytes: SolveBytes | null): void {
  solverLoader = null
  solverBytes = bytes
  solverCell.reset()
}

/**
 * Install a headless module loader (`loadSolverFresh`). Recovery re-runs it
 * after a sketch-package trap, which is the only way an injected-bytes host
 * could ever replace a poisoned instance. The first load happens here so boot
 * is synchronously ready exactly as `setSketchSolver(loadSolver())` was.
 */
export function setSketchSolverLoader(loader: (() => SketchSolverBundle | null) | null): void {
  solverLoader = loader
  solverBytes = null
  topologyBytes = null
  solverCell.reset()
  if (loader !== null) adoptSketchBundle(loader())
}

// Set when a call into the Rust module traps. solveLocally's recovery reads it
// to decide whether the sketch module (a separate wasm instance with its own
// heap, so an OCC trap does not damage it) also has to be discarded.
let sketchTrapPending = false

/** The three solve entry points below all run the same bytes call; marking the
 *  trap here means the recovery knows which module was corrupted. */
function runSolverBytes(bytes: SolveBytes, input: FlatInput): SolverOutput {
  try {
    return decodeOutput(bytes(encodeInput(input)))
  } catch (e) {
    if (isKernelTrap(e)) sketchTrapPending = true
    throw e
  }
}

/** `detect_topology_bytes` shares the solver's wasm instance, so a trap there
 *  faults the same module; mark it before the build converts it to a sketch
 *  exception. */
function runTopology(
  richGeom: Parameters<typeof solveTopology>[0],
  featureId: string,
  contacts: WireContact[],
): ReturnType<typeof solveTopology> {
  try {
    return solveTopology(richGeom, featureId, topologyBytes, contacts)
  } catch (e) {
    if (isKernelTrap(e)) sketchTrapPending = true
    throw e
  }
}

/** @internal: whether the last trap came out of the sketch module. Clears the
 *  flag, so one recovered trap does not make the next OCC trap look like a
 *  sketch fault too. */
export function consumeSketchTrap(): boolean {
  const pending = sketchTrapPending
  sketchTrapPending = false
  return pending
}

/** Whether the Rust area builder shares the loaded sketch module. Recovery
 *  requires both after a sketch-package trap: a solver without topology builds
 *  an exception per sketch, which the drive reply would read as ok. */
export function isSketchTopologyReady(): boolean {
  return topologyBytes !== null
}

/** Inject a pre-loaded Rust area builder; null restores the TS fallback. */
export function setSketchTopology(bytes: TopologyBytes | null): void {
  topologyBytes = bytes
}

/** Start loading the Rust solver + area builder from ``/wasm/`` (browser path);
 *  a failed auto-load is retried on the next call instead of pinned. A host
 *  that installed a loader loads through it, synchronously, so a byte-injected
 *  browser path and a loader-owned headless path share one entry. */
export function initSketchSolver(): Promise<SolveBytes | null> {
  if (solverBytes) return Promise.resolve(solverBytes)
  if (solverLoader !== null) return Promise.resolve(adoptSketchBundle(solverLoader()))
  return solverCell.load()
}

/** Clear the cached solver (tests). The installed loader, like the area builder
 *  loader, is environment state rather than per-test state and is preserved;
 *  the next `initSketchSolver` would load through it again. Use
 *  `setSketchSolverLoader(null)` to return the module to the browser path. */
export function resetSketchSolver(): void {
  solverBytes = null
  solverCell.reset()
}

/**
 * Discard the Rust solver after a WASM trap. Unlike `resetSketchSolver`, this
 * also clears `solverWasm`'s package memo: that cache is what holds the
 * instantiated module behind `solve_sketch_bytes`, so resetting only this
 * module's cell would hand the next call the same corrupt instance.
 *
 * A host with a loader (the headless path, `setSketchSolverLoader`) gets a
 * fresh module here, immediately: nothing else can replace an instance the
 * require cache would otherwise hand back. Without a loader the browser path
 * rebuilds from `/wasm/` on the next call, so a replacement is armed either
 * way. Returns whether a replacement module is actually in hand now: a loader
 * that produced none reports false, which is what `solveLocally` turns into a
 * fault that does not claim a reload.
 */
export function resetSketchSolverAfterTrap(): boolean {
  solverBytes = null
  topologyBytes = null
  setProfileLoopsBytes(null)
  solverCell.reset()
  if (solverLoader !== null) {
    try {
      adoptSketchBundle(solverLoader())
    } catch (e) {
      // A module load cannot be reading the trapped heap, so no trap reaches
      // here; swallowUnlessTrap keeps the audit's shape anyway. Leaving the
      // cells null lets the reload latch report the unrecovered kernel instead
      // of a build that silently loses sketches.
      swallowUnlessTrap(e)
    }
    return isSketchSolverReady() && isSketchTopologyReady()
  }
  resetSolverWasm()
  return true
}

/**
 * Project one body/sketch source query; `declaredPoint` asks for the curve
 * centre when the source is curved (a projection declared `point`).
 */
export function projectSourceQuery(
  source: string,
  plane: PlaneFrame,
  globalRepo: Repository,
  declaredPoint: boolean,
): ReturnType<typeof projectTo2d> {
  if (!source || source.startsWith('$')) return null
  const resolvedSrc = globalRepo.query(source, null) as Dict | null
  if (!resolvedSrc) return null
  // A registry point carries 2D external_xy and needs its owning sketch frame
  // to become 3D; the builtin origin has no sketch and lifts to the document
  // origin. Without this the origin projection resolved nothing and the entity
  // stayed at the stale/default point.
  const data3d = 'external_xy' in resolvedSrc
    ? { kindH: 'point' as const, data: { point: getPoint3d(resolvedSrc, globalRepo) } }
    : resolve3dGeometry(resolvedSrc, (sketchId) =>
        (globalRepo.elements.get('_pt_' + sketchId) as PlaneLike | undefined) ?? null)
  if (!data3d) return null
  // A projection DECLARED point on a curved source means its centre; every other
  // declared kind keeps the resolved geometry's own projection. The default
  // `point` used for a missing kind is not a declaration, so it stays on the
  // resolved-kind path.
  return (declaredPoint ? projectCenter(data3d, plane) : null) ?? projectTo2d(data3d, plane)
}

/**
 * Lower every projected entity (one carrying a ``source`` ancestry query) in a
 * sketch feature: resolve the source geometry via the repository, project it
 * onto the sketch plane, and fold the resulting 2D params into ``initial``.
 * The entity's ``source`` is stripped and its id is added to ``pinnedIds`` so
 * the solver treats the lowered params as immovable -- the design invariant
 * "a projected entity is just an entity whose params are pinned".
 *
 * A face projection has no target: its boundary edges are derived into member
 * entities on every solve (never document rows), their ids are kept stable
 * through the constraint's `members` map, and the report is returned for the
 * write-back and for the freeze command. The input feature is never mutated.
 *
 * Returns the mutated feature plus the bookkeeping the caller surfaces to the
 * doc (resolved kinds for tilted-circle/partial-ellipse lowering) and to the
 * UI (ids of projections that could not be resolved this solve). An unresolved
 * projection that already had a position keeps it; one that never had any is
 * reported in `unpositionedIds` so the solve can leave its default all-zero
 * params out of the geometry and the profile.
 * Mirrors Python's
 * ``_project_source_to_params`` + ``_resolve_source_geometry``.
 */
function lowerProjectionConstraints(
  feature: Dict,
  plane: ReturnType<typeof resolveSketchPlane>,
  globalRepo: Repository,
  faceBoundary?: FaceBoundaryLookup,
  featuresById: Record<string, Dict> = {},
): {
  loweredFeature: Dict
  resolvedKinds: Record<string, string>
  projectionMembers: Record<string, ProjectionMemberReport>
  projectionErrors: string[]
  projectionWarnings: string[]
  pinnedIds: string[]
  unpositionedIds: string[]
  /** The projection constraints whose held entity never had a position: the
   *  subset of `projectionErrors` that is also left out of the profile. */
  projectionUnpositioned: string[]
} {
  const entities = (feature.entities as Array<Dict>) ?? []
  const featureId = (feature.id as string) ?? ''
  const constraints = [...((feature.constraints as Array<Dict>) ?? [])]
  // Legacy v5 (and raw) docs may still carry `source` on the entity instead of
  // a `projection` constraint. Fold those into projection constraints here so
  // the solve path matches the migrated document model.
  const existingTargets = new Set(
    constraints.filter((c) => c.kind === 'projection' && typeof c.target === 'string').map((c) => c.target as string),
  )
  for (const ent of entities) {
    const src = (ent as { source?: unknown }).source
    if (src && typeof src === 'string' && !existingTargets.has(`$${ent.id}`)) {
      constraints.push({ id: `proj_${ent.id}`, kind: 'projection', target: `$${ent.id}`, source: src })
      existingTargets.add(`$${ent.id}`)
    }
  }
  const projections = constraints.filter((c) => c.kind === 'projection')
  const resolvedKinds: Record<string, string> = {}
  const projectionMembers: Record<string, ProjectionMemberReport> = {}
  const projectionErrors: string[] = []
  const projectionWarnings: string[] = []
  const pinnedIds: string[] = []
  const unpositionedIds: string[] = []
  const projectionUnpositioned: string[] = []
  // Entities derived from a face boundary are passed to `partDocToSketches` as
  // solve facts (with the resolved kinds), never written into the feature or
  // its `initial`.

  if (projections.length === 0) {
    return {
      loweredFeature: feature, resolvedKinds, projectionMembers, projectionErrors, projectionWarnings,
      pinnedIds, unpositionedIds, projectionUnpositioned,
    }
  }

  const initial: Record<string, number[]> = { ...((feature.initial as Record<string, number[]>) ?? {}) }
  const seenTargets = new Set<string>()
  // Order-sensitive features for the source classifier: `featuresById` keeps the
  // document order (the builder inserts by iterating the log), which is the only
  // input the forward-reference rule needs. Built lazily because the clean solve
  // never asks.
  let sourceDoc: PartDoc | null = null
  const documentForSources = (): PartDoc => {
    sourceDoc ??= {
      version: 1,
      kind: 'part',
      features: Object.entries(featuresById).map(([id, def]) => ({ ...(def as object), id }) as PartFeature),
    }
    return sourceDoc
  }
  for (const pc of projections) {
    const cid = pc.id as string
    const targetRef = typeof pc.target === 'string' ? pc.target : ''
    const source = typeof pc.source === 'string' ? pc.source : ''
    // A face projection (no target) is one live constraint whose members are
    // derived here. The face miss edits nothing: the stored map stays pinned and
    // the members return with the same ids when the face resolves again.
    if (targetRef === '') {
      const boundary = faceBoundary?.(source) ?? null
      const reconciled = reconcileFaceProjection(
        pc as { id: string; members?: Record<string, string>; excluded?: string[] },
        boundary,
      )
      const report: ProjectionMemberReport = {
        members: reconciled.members,
        entities: [],
        orphans: [...reconciled.orphans],
      }
      projectionMembers[cid] = report
      const projectionName = constraintDisplayName(feature, cid) ?? 'the projection'
      if (boundary === null) {
        projectionErrors.push(cid)
        projectionWarnings.push(
          `${projectionName} did not resolve; `
          + 'no face members are derived this solve, so there is nothing to freeze',
        )
        continue
      }
      const edgeByToken = new Map(boundary.edges.map((edge) => [edge.token, edge]))
      const excludedTokens = new Set((pc.excluded as string[] | undefined) ?? [])
      const seams = new Set(boundary.seams ?? [])
      // A face whose every edge is excluded is an intentionally empty live
      // projection, not a failure: only live edges that all failed to project
      // may report an error.
      const liveEdges = boundary.edges.filter((edge) =>
        edge.token !== '' && !excludedTokens.has(edge.token) && !seams.has(edge.query)).length
      for (const [token, memberId] of Object.entries(reconciled.members)) {
        const edge = edgeByToken.get(token)
        if (edge === undefined) continue  // orphan: kept in the map, no geometry
        let projected: ReturnType<typeof projectTo2d> = null
        try {
          projected = projectSourceQuery(edge.query, plane as PlaneFrame, globalRepo, false)
        } catch (e) {
          swallowUnlessTrap(e)
        }
        if (!projected) {
          projectionWarnings.push(
            `${projectionName}: a projected member's source did not resolve`,
          )
          continue
        }
        pinnedIds.push(memberId)
        report.entities.push({ id: memberId, kind: projected.kind, params: [...projected.params] })
      }
      // A face that resolves but yields no member is a failure only when it had
      // a live edge to project; an all-excluded (or all-orphan) boundary is an
      // intentionally empty live projection, not a dangling one.
      if (report.entities.length === 0 && liveEdges > 0) {
        projectionErrors.push(cid)
        projectionWarnings.push(
          `${projectionName}: the picked face has no boundary edge to project`,
        )
      }
      continue
    }
    const targetId = targetRef.startsWith('$') ? targetRef.slice(1) : targetRef
    if (!targetId) { projectionErrors.push(cid); continue }
    // Duplicate projection on one entity: the later constraint is the error.
    if (seenTargets.has(targetId)) { projectionErrors.push(cid); continue }
    seenTargets.add(targetId)
    const ent = entities.find((e) => e.id === targetId)
    const declaredKind = (ent?.kind as string) ?? 'point'
    // Read before any branch writes `initial`: an unresolved projection can only
    // "keep its last position" if it had one on entry. A block equal to the kind
    // defaults is the old fallback's baked zero curve, and a block of another
    // arity is a cache of a resolve that lowered to a different kind; neither is
    // a position in this kind's slots.
    const stored = initial[targetId]
    const hadPosition = isProjectionPosition(stored, declaredKind, ent?.handles)
    let resolved = false
    try {
      if (source.startsWith('$')) {
        const sourceEid = source.slice(1)
        const srcParams = initial[sourceEid]
        if (srcParams) {
          initial[targetId] = [...srcParams]
          resolved = true
        }
      } else if (source) {
        const projected = projectSourceQuery(source, plane as PlaneFrame, globalRepo, ent?.kind === 'point')
        if (projected) {
          initial[targetId] = projected.params
          if (projected.warning) {
            projectionWarnings.push(
              `${constraintDisplayName(feature, cid) ?? 'the projection'}: ${projected.warning}`,
            )
          }
          // The resolved kind is a solve fact here. The write-back adopts it on
          // the document row (a projection's kind is derived, not authored), so
          // the lowering itself never writes the input feature.
          if (projected.kind !== declaredKind) {
            resolvedKinds[targetId] = projected.kind
          }
          resolved = true
        }
      }
    } catch (e) {
      swallowUnlessTrap(e)
    }
    // Whether resolved or not, the entity stays in the solve and is pinned:
    // resolved -> at the freshly projected params; unresolved -> at its cached
    // (last projected) params, or default params when the stored block is not a
    // position in this kind (it never had one, or it is another kind's block).
    // A foreign block is replaced rather than kept: passing it on would make the
    // solver pad or truncate it to this kind's arity. The projection constraint
    // id is reported as an error only when unresolved.
    if (!resolved && !hadPosition) {
      initial[targetId] = defaultProjectionBlock(declaredKind, ent?.handles)
    }
    pinnedIds.push(targetId)
    if (!resolved) {
      projectionErrors.push(cid)
      // A sketch source carries its cause in the document, so name it instead of
      // the generic did-not-resolve sentence. A body query keeps the two-state
      // wording: whether the face still exists is only known to the solve, not
      // to the document.
      const sourceProblem = source.startsWith('?') || source === '@builtin_origin'
        ? null
        : classifyProjectionSource(documentForSources(), featureId, source, targetId)
      const stateText = hadPosition
        ? 'the entity keeps its last position; convert the projection to fixed to unlink it'
        : 'the entity has no position yet and is left out of the profile; delete the projection, there is nothing to freeze'
      // Named, not silent: the drive reply reads this as a warning row on the
      // sketch, so an unresolved projection cannot read as a clean build. The
      // sentence has to say which of the two states the entity is in, because
      // only one of them keeps its geometry.
      projectionWarnings.push(
        `${constraintDisplayName(feature, cid) ?? 'the projection'} did not resolve; `
        + `${sourceProblem === null ? stateText : sourceProblem.kind}`,
      )
      if (!hadPosition) {
        unpositionedIds.push(targetId)
        projectionUnpositioned.push(cid)
      }
    }
  }

  return {
    loweredFeature: { ...feature, constraints, initial },
    resolvedKinds,
    projectionMembers,
    projectionErrors,
    projectionWarnings,
    pinnedIds,
    unpositionedIds,
    projectionUnpositioned,
  }
}

/**
 * Solve a single sketch feature with the Rust kernel. Must call
 * ``initSketchSolver()`` first; throws if the solver is not loaded.
 * Returns a result compatible with Python's ``_dispatch_sketch`` output.
 *
 * Projected entities (those carrying a ``source`` ancestry query) are lowered
 * here before the Rust solver sees them: the source geometry is resolved via
 * the repository, projected onto the sketch plane, and the resulting 2D params
 * replace the entity's initial values. The entity is then marked as pinned so
 * the solver treats it as immovable. This mirrors Python's
 * ``_project_source_to_params`` + ``_resolve_source_geometry``.
 */
/**
 * Refuse a solver output whose declared counts disagree with the layout we sent.
 *
 * The solver writes its OWN `entity_status` / `params_solved` lengths onto the
 * wire (`codec.rs` emits `out.entity_status.len()`); nothing ties either of them
 * to the `layout` this side built, and the zips downstream are positional. A
 * TRUNCATED buffer already fails loudly -- DataView throws reading past the end
 * -- but a well-formed buffer whose counts merely disagree does not: the zips
 * then read off the end and put `undefined` into fields typed `string`
 * (`STATUS_NAME[...]`) and `number` (`params[0]` in paramsToPreview), with no
 * throw and nothing to fail a test. An entity would silently lose its geometry
 * and report `status: undefined`.
 *
 * The skew is not hypothetical for this codec: a stale js/wasm pairing shipped
 * once already and decoded shifted offsets instead of failing, which is why the
 * magic number became the version handshake. The magic catches a LAYOUT change;
 * it cannot catch a COUNT disagreement. This is the other half of that guard,
 * and it has to live here because the layout is only in scope on this side.
 *
 * `skipStatusPass` is the caller's own request flag, not a second opinion about
 * it: the wire contract is `n_entities_status == layout.length`, or 0 when the
 * request set `skip_status_pass` (the codec header documents the 0). Every drag call
 * site asks for the skip, because that path reads the params and the overall
 * status only. Deriving the expectation from the flag that was actually sent
 * means neither call site has to hand-maintain a boolean, and an empty status
 * array is checked as the REQUIRED answer there rather than merely tolerated.
 *
 * Throwing matches what solveSketch already does for every other unusable input
 * (an unlowerable sketch, an uninitialised solver): a wrong sketch is worse than
 * an absent one, because the wrong one gets built on.
 */
export function assertSolverOutputMatchesLayout(
  out: SolverOutput,
  layout: EntityLayout[],
  skipStatusPass: boolean,
  sketchName = 'the sketch',
): void {
  const expectedStatuses = skipStatusPass ? 0 : layout.length
  if (out.entityStatus.length !== expectedStatuses) {
    throw new Error(
      `${sketchName}: solver returned ${out.entityStatus.length} entity statuses, expected ${expectedStatuses}`,
    )
  }
  let needed = 0
  for (const ent of layout) needed = Math.max(needed, ent.offset + ent.size)
  if (out.paramsSolved.length < needed) {
    throw new Error(
      `${sketchName}: solver returned ${out.paramsSolved.length} params, layout needs ${needed}`,
    )
  }
  // Codes are indices into STATUS_NAME. An out-of-range one is the same skew
  // arriving as a value rather than as a length, and reads back `undefined`.
  if (out.overallStatus >= STATUS_NAME.length) {
    throw new Error(`${sketchName}: solver returned unknown status code ${out.overallStatus}`)
  }
  for (let i = 0; i < out.entityStatus.length; i++) {
    if (out.entityStatus[i] >= STATUS_NAME.length) {
      // The entity id stays on this kernel alarm: a skew this deep is a solver
      // bug, and the id is the debugging handle.
      throw new Error(
        `${sketchName}: solver returned unknown status code ${out.entityStatus[i]} for entity ${layout[i].id}`,
      )
    }
  }
}

/**
 * Refuse an output whose per-constraint verdict arrays disagree with the wire
 * constraints this side sent. Same class of skew `assertSolverOutputMatchesLayout`
 * guards on the entity side: the counts are the solver's own claim about
 * itself, and `constraintIds` is zipped positionally against them. The drag
 * path asks for no verdicts (the walk is cold-only), so there the required
 * answer is exactly empty, not merely tolerated.
 */
export function assertConstraintVerdictsMatchInput(
  out: SolverOutput,
  nConstraints: number,
  dragMode: boolean,
  sketchName = 'the sketch',
): void {
  const expected = dragMode ? 0 : nConstraints
  if (out.constraintFlags.length !== expected || out.constraintMiss.length !== expected) {
    throw new Error(
      `${sketchName}: solver returned ${out.constraintFlags.length} constraint flags and `
      + `${out.constraintMiss.length} constraint misses, expected ${expected}`,
    )
  }
}

/** Fraction of the total per-constraint miss the culprit set must cover. */
export const CULPRIT_COVERAGE = 0.9

/**
 * Wire indices of the constraints carrying an unsatisfied solve's miss:
 * largest miss first until `CULPRIT_COVERAGE` of the total is covered.
 *
 * A two-way conflict splits the miss between both sides, so a largest-first
 * walk keeps both, while a one-sided blame (one bad dimension against a set of
 * satisfied ones) stops after the offender. The magnitudes are comparable
 * across constraint kinds because the solver already divided each row's
 * residual by its Jacobian row norm and the sketch scale (see
 * `constraint_miss` in sketch-solver/src/solve.rs). An all-zero miss (the
 * defect sits in the pin rows, not the constraints) selects nothing. A
 * non-finite value is not a measurement: one Infinity makes the total
 * unmeetable by every finite miss, so the whole positive set (not just the
 * offender) would be blamed; non-finite entries are dropped.
 */
export function culpritConstraintIndices(miss: number[]): Set<number> {
  const order = miss
    .map((m, i) => [m, i] as const)
    .filter(([m]) => Number.isFinite(m) && m > 0)
    .sort((a, b) => b[0] - a[0])
  const culprits = new Set<number>()
  const total = order.reduce((sum, [m]) => sum + m, 0)
  if (!(total > 0)) return culprits
  let covered = 0
  for (const [m, i] of order) {
    culprits.add(i)
    covered += m
    if (covered >= CULPRIT_COVERAGE * total) break
  }
  return culprits
}

/**
 * The build warning an underconstrained sketch reports. The wording matches the
 * assembly's own underconstrained verdict (utils/core/assemblyStatus.ts) so the
 * two editors speak the same language, and the free names let an author (or a
 * hovering user) find the geometry still holding DOF. The ids themselves stay on
 * the solve result (`free_entities`) and the MCP feature row's `free` list, where
 * a machine reads them. A sketch's DOF count can exceed its free entity count (a
 * point owns two), so the head states the solver's number and the tail names
 * entities.
 */
export function underconstrainedWarning(dof: number, freeNames: readonly string[]): string {
  const head = `Underconstrained: ${dof} degree${dof === 1 ? '' : 's'} of freedom.`
  if (freeNames.length === 0) return head
  const shown = freeNames.slice(0, 5)
  const rest = freeNames.length - shown.length
  return `${head} Free: ${shown.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}.`
}

/** Wire kind code -> the document's kind name, for a dropped constraint whose
 *  authored id no longer names a readable def. */
const CONSTRAINT_KIND_NAME: Readonly<Record<number, string>> = Object.fromEntries(
  Object.entries(ConstraintKindCode).map(([name, code]) => [code, name]),
)

/** True when a coincident pins a contact between the two tangent operands in
 *  the same shape the solver reads: two endpoints, or one endpoint against the
 *  other side's locus (`Absent`). A spline side must be its start or end. */
function tangentHasContact(
  input: FlatInput,
  layout: EntityLayout[],
  first: number,
  second: number,
): boolean {
  const isSpline = (kind: string | undefined) => kind === 'spline' || kind === 'fit_spline'
  const endpoint = (index: number, point: number): boolean => {
    const kind = layout[index]?.kind
    return (kind === 'line' || kind === 'arc' || isSpline(kind))
      && (point === Sel.start || point === Sel.end)
  }
  return input.constraints.some(constraint => {
    if (constraint.kind !== ConstraintKindCode.coincident) return false
    const refs = constraint.refs.map(entry => entry.ref)
    if (refs.length !== 2) return false
    const [a, b] = refs
    if (a.kind !== 'entity' || b.kind !== 'entity') return false
    const ordered = a.index === first && b.index === second
      ? [a, b] as const
      : a.index === second && b.index === first
        ? [b, a] as const
        : null
    if (ordered === null) return false
    const [firstRef, secondRef] = ordered
    const firstEnd = endpoint(firstRef.index, firstRef.point)
    const secondEnd = endpoint(secondRef.index, secondRef.point)
    const linked = (firstEnd && (secondEnd || secondRef.point === Sel.absent))
      || (secondEnd && firstRef.point === Sel.absent)
    if (!linked) return false
    // The solver's contact must pin every spline side by an end, and at least
    // one spline end must be the contact.
    const firstOk = !isSpline(layout[first]?.kind) || firstEnd
    const secondOk = !isSpline(layout[second]?.kind) || secondEnd
    const namesSplineEnd = (isSpline(layout[first]?.kind) && firstEnd)
      || (isSpline(layout[second]?.kind) && secondEnd)
    return firstOk && secondOk && namesSplineEnd
  })
}

/** The specific drop reason for a spline tangent with no pinned end, or null
 *  when the row is dropped for some other reason. */
function splineTangentDropReason(
  input: FlatInput,
  layout: EntityLayout[],
  constraint: FlatConstraint,
): string | null {
  const refs = constraint.refs.map(entry => entry.ref)
  if (refs.length !== 2) return null
  const [a, b] = refs
  if (a.kind !== 'entity' || b.kind !== 'entity') return null
  const firstKind = layout[a.index]?.kind
  const secondKind = layout[b.index]?.kind
  if (firstKind === undefined || secondKind === undefined) return null
  // A line/spline tangent has a free body form, so a drop there is not the
  // shared-endpoint rule.
  if (firstKind === 'line' || secondKind === 'line') return null
  const isSpline = (kind: string) => kind === 'spline' || kind === 'fit_spline'
  if (!isSpline(firstKind) && !isSpline(secondKind)) return null
  if (!tangentKindsAdmitted(firstKind, secondKind)) return null
  if (tangentHasContact(input, layout, a.index, b.index)) return null
  const partner = isSpline(firstKind) && isSpline(secondKind)
    ? 'spline'
    : isSpline(firstKind) ? secondKind : firstKind
  return tangentNeedsSharedEndpointReason(partner)
}

/** Why the solver's survivors filter removed a constraint. The wire flag says
 *  only that it was dropped; the flat payload and the entity layout on this
 *  side hold enough to distinguish a stale ref from an unreadable operand. */
function droppedConstraintReason(input: FlatInput, layout: EntityLayout[], index: number): string {
  const c: FlatConstraint | undefined = input.constraints[index]
  for (const { ref } of c?.refs ?? []) {
    if (ref.kind === 'entity' && layout[ref.index] === undefined) return 'stale reference'
  }
  if (c !== undefined && c.kind === ConstraintKindCode.tangent) {
    const reason = splineTangentDropReason(input, layout, c)
    if (reason !== null) return reason
  }
  return 'operand kind'
}

/**
 * The authored constraints the solver dropped, one structured record each. A
 * constraint naming operands it cannot use (a point in the line slot, a Length
 * on a point, a stale ref) used to disappear without a trace; the dropped
 * verdict bit makes it a build warning the tree and the drive reply can name,
 * and the editor draws it as a red tile from the same record.
 */
export function droppedConstraintRecords(
  out: SolverOutput,
  input: FlatInput,
  layout: EntityLayout[],
  constraintIds: ReadonlyArray<string | null>,
  authoredById: ReadonlyMap<string, { kind: string }>,
): DroppedConstraint[] {
  const dropped: DroppedConstraint[] = []
  for (let i = 0; i < out.constraintFlags.length; i++) {
    if ((out.constraintFlags[i] & CONSTRAINT_FLAG.dropped) === 0) continue
    const cid = constraintIds[i]
    if (cid === null || cid === undefined) continue
    const kind = authoredById.get(cid)?.kind
      ?? CONSTRAINT_KIND_NAME[input.constraints[i]?.kind ?? -1] ?? 'constraint'
    dropped.push({ id: cid, kind, reason: droppedConstraintReason(input, layout, i) })
  }
  return dropped
}

/**
 * The solved curves too small to bound anything, with the reason each one is
 * left out of the area build. A zero circle and an ellipse whose solve flips
 * its axes are two a legal authored document can still produce; at a shared
 * endpoint either one can take a valid neighbour's profile down with it. They
 * stay in `geometry` so the editor still draws what the author has, and only
 * the profile topology skips them.
 *
 * The solver's own `invalid_geometry` rule marks a solved circle or arc at or
 * under radius 0 as an overconstrained solve before this side sees it, so a
 * lone zero circle answers overconstrained. The size predicate here is what
 * names the real cause on the warning channel instead of leaving the verdict
 * with no cause. An unpositioned projection is already left out before this
 * scan; this list holds only the entities the size rule rejected. A construction
 * curve is skipped because it never bounds a profile, so its size is not a
 * profile problem.
 */
function degenerateSolvedEntities(
  layout: EntityLayout[],
  out: SolverOutput,
  unpositioned: ReadonlySet<string>,
): Map<string, string> {
  const reasons = new Map<string, string>()
  for (let i = 0; i < layout.length; i++) {
    const ent = layout[i]
    if (ent.id === ORIGIN_ID || ent.construction || unpositioned.has(ent.id)) continue
    const params = out.paramsSolved.slice(ent.offset, ent.offset + ent.size)
    const reason = entitySizeProblem(ent.kind, params)
    if (reason !== null) reasons.set(ent.id, reason)
  }
  return reasons
}

export function solveSketch(
  feature: Dict,
  globalRepo: Repository,
  _partStore: Record<string, PartSolid>,
  featuresById: Record<string, Dict> = {},
  faceBoundary?: FaceBoundaryLookup,
): SketchResult {
  if (!solverBytes) {
    throw new Error('sketch: Rust solver not initialised (call initSketchSolver first)')
  }

  const featureId = (feature.id as string) ?? ''

  // ─── Lower projected entities before partDocToSketches ───
  const plane = resolveSketchPlane(
    (feature.plane as string | undefined) ?? null,
    globalRepo,
    { sketchId: featureId, featuresById },
  )
  const { loweredFeature, resolvedKinds, projectionMembers, projectionErrors, projectionWarnings, pinnedIds, unpositionedIds, projectionUnpositioned } =
    lowerProjectionConstraints(feature, plane, globalRepo, faceBoundary, featuresById)
  // A projection that never had a position stays pinned in the solve but is kept
  // out of the solved geometry below, and therefore out of the profile topology:
  // baking its default all-zero params would make that degenerate curve both a
  // profile edge and the "last position" every later failed solve claims to keep.
  const unpositioned = new Set(unpositionedIds)

  // ─── Lower the live PartDoc feature to SketchInput ───
  // Express the document origin (0,0,0) in this sketch's local 2D frame so a
  // `@builtin_origin` coincident pins to the actual document origin, not the
  // sketch plane's local (0,0) -- which differ for a sketch on an offset/
  // projected face ("line constrained to origin" bug).
  const originLocal = projectWorldToFrame([0, 0, 0], plane as Frame3D)
  // The project pass hands the lowering its resolve facts explicitly: the kind
  // each held entity resolved to and the face projection's derived members. The
  // operand gate then judges a row on the resolved kind (a circle seen edge-on
  // is a line) and can address a member id without an in-place document write.
  const derivedKinds: Record<string, string> = {}
  const derivedInitial: Record<string, number[]> = {}
  const derivedConstruction = new Set<string>()
  const pf = loweredFeature as unknown as SketchFeature
  // Construction is a property of the face projection, whole wire: every member
  // of a flagged constraint is construction geometry, so the profile builder
  // skips it while the edges stay available to dimension against.
  const constructionProjections = new Set(
    (pf.constraints ?? [])
      .filter((c) => c.kind === 'projection' && c.construction === true)
      .map((c) => c.id),
  )
  for (const [constraintId, report] of Object.entries(projectionMembers)) {
    const construction = constructionProjections.has(constraintId)
    for (const member of report.entities) {
      derivedKinds[member.id] = member.kind
      derivedInitial[member.id] = [...member.params]
      if (construction) derivedConstruction.add(member.id)
    }
  }
  const extract = partDocToSketches([pf], originLocal, pinnedIds, {
    resolvedKinds, derivedKinds, derivedInitial, derivedConstruction,
  })
  if (extract.skipped.length) {
    throw new Error(`${featureDisplayName(pf, featureRows(featuresById))}: ${extract.skipped[0].reason}`)
  }
  if (!extract.sketches.length) {
    throw new Error(`${featureDisplayName(pf, featureRows(featuresById))}: no lowerable sketch found`)
  }

  const { sketch, droppedConstraints } = extract.sketches[0]
  const { input, layout, constraintIds } = lowerSketch(sketch)
  const out = runSolverBytes(solverBytes, input)
  const sketchName = sketchDisplayName(featureId, featureRows(featuresById))
  assertSolverOutputMatchesLayout(out, layout, input.options.skipStatusPass, sketchName)
  assertConstraintVerdictsMatchInput(out, input.constraints.length, input.options.dragMode, sketchName)
  const status = STATUS_NAME[out.overallStatus]
  // The curves the profile builder must not see. Computed before the geometry
  // maps so the area build and the warning row read one answer.
  const degenerate = degenerateSolvedEntities(layout, out, unpositioned)

  // Reconstruct per-entity geometry and status maps, plus rich geometry for
  // topology detection.
  const geometry: Record<string, number[]> = {}
  const features: Record<string, { status: string }> = {}
  // Free entities, in layout order, for the underconstrained warning. The
  // origin is not an authored entity and never belongs in the list.
  const freeIds: string[] = []
  const richGeom: Record<string, Record<string, unknown>> = {}
  // Entity ids the solver reported moved, in layout order. The write-back reads
  // this set to decide which `initial` arrays to keep by reference.
  const entityMoved: string[] = []
  // Solved positions of materialized point entities, so the topology can lean on
  // them instead of re-emitting an inferred crossing at the same spot (slice 4).
  const pointPositions: [number, number][] = []
  for (let i = 0; i < layout.length; i++) {
    const ent = layout[i]
    const params = out.paramsSolved.slice(ent.offset, ent.offset + ent.size)
    if (ent.id === ORIGIN_ID) continue
    // Keep its solved status so the tree does not read it as underconstrained,
    // but give it no geometry: there is nothing to profile. The sketch view still
    // draws it, at the default block unflattenGeometry fills in for a missing id.
    if (unpositioned.has(ent.id)) {
      features[ent.id] = { status: STATUS_NAME[out.entityStatus[i]] }
      continue
    }
    if ((out.entityMoved[i >> 3] >> (i & 7)) & 1) entityMoved.push(ent.id)
    if (Math.abs(params[0]) > 1e-12 || params.length > 1) {
      geometry[ent.id] = [...params]
    }
    features[ent.id] = { status: STATUS_NAME[out.entityStatus[i]] }
    if (STATUS_NAME[out.entityStatus[i]] === 'underconstrained') freeIds.push(ent.id)
    // Construction geometry solves like anything else but must bound no area,
    // so the flag rides along to the area builder, which skips those entities.
    // A degenerate curve is left out entirely: it has no area of its own and at
    // a shared endpoint would split, and possibly unbalance, a valid neighbour.
    if (!degenerate.has(ent.id)) {
      richGeom[ent.id] = { ...enrichSketchEntity(ent.kind, params, ent.flags), ...(ent.construction ? { construction: true } : {}) }
    }
    if (ent.kind === 'point') pointPositions.push([params[0], params[1]])
  }

  // Topology + plane transform: what postRegister registers as _topo_/_pt_ so
  // downstream features can resolve this sketch's profile. A crossing already
  // owned by a materialized point yields to that point's identity.
  //
  // The author's coincident/tangent rows ride along as declared contacts so
  // the builder welds what the solver only approximately met. An
  // overconstrained solve lowers none (its geometry is a compromise and those
  // rows are exactly what failed).
  const declared = declaredContacts(sketch, layout, status)
  const topology = stampAreaBuildability(reconcileMaterializedContacts(
    runTopology(richGeom, featureId, declared),
    pointPositions,
  ))
  const plane_transform = frameToPlaneTransform(plane as Frame3D)

  // Per-constraint verdicts: map the wire-order flags back to the authored ids
  // and attach the render block computed from the SOLVED geometry. A constraint
  // the solve calls redundant is marked `superfluous` (the existing non-driver
  // language the overlays and the cleanup command already read); a conflict
  // culprit is marked `culprit` for the deeper-red paint. Sugar expanded to
  // synthetic ids (ngon/dock) has no authored id on the wire, so its pieces
  // stay unmarked.
  const memberEntities = Object.entries(derivedKinds).map(([id, kind]) => ({
    id,
    kind,
    ...(derivedConstruction.has(id) ? { construction: true } : {}),
  }))
  const baseRenderEntities = [...(pf.entities ?? []), ...memberEntities]
  const renderEntities = Object.keys(resolvedKinds).length
    ? baseRenderEntities.map((e) => ({ ...e, kind: resolvedKinds[e.id] ?? e.kind }))
    : baseRenderEntities
  const solvedSketch = unflattenGeometry(geometry, renderEntities)
  const rendered = deriveConstraints(pf, solvedSketch, { originLocal })
  const wireIndexById = new Map<string, number>()
  constraintIds.forEach((cid, i) => { if (cid !== null) wireIndexById.set(cid, i) })
  // Redundancy is only ever measured on a satisfied solve: the solver's walk
  // is a phase fact of a settled system (see solve.rs), and on an unsatisfied
  // one the same bytes carry whatever the failed solve left there. Gate the
  // read here so the contract is enforced at the one place that consumes it,
  // and let the miss pick the culprits on the unsatisfied side.
  const satisfiedSolve = out.overallStatus !== Status.overconstrained
  const culprits = satisfiedSolve
    ? new Set<number>()
    : culpritConstraintIndices(out.constraintMiss)
  const weakByWire = new Map(out.weakConstraints.map(w => [w.index, w.moveEstimate]))
  const constraintResults: Constraints = {}
  for (const [cid, c] of Object.entries(rendered)) {
    const idx = wireIndexById.get(cid)
    if (idx === undefined) continue
    const redundant = satisfiedSolve && (out.constraintFlags[idx] & CONSTRAINT_FLAG.redundant) !== 0
    const weakAngle = weakByWire.get(idx)
    constraintResults[cid] = {
      ...c,
      residual: out.constraintMiss[idx] ?? 0,
      ...(redundant ? { superfluous: true } : {}),
      ...(culprits.has(idx) ? { culprit: true } : {}),
      ...(weakAngle !== undefined ? { weak: true, weak_angle: weakAngle } : {}),
    }
  }

  // Only the cold solve carries a status pass. The drag path builds its own
  // result without this field, so a soft solve can never invent a warning. A
  // dropped constraint is a warning on any solve status, including a fully
  // constrained sketch that would otherwise read clean.
  const warnings: string[] = status === 'underconstrained'
    ? [underconstrainedWarning(
      out.diagnostics.dof,
      freeIds.map(id => entityDisplayName(pf, id) ?? 'a free entity'),
    )]
    : []
  const authoredById = new Map((pf.constraints ?? []).map(c => [c.id, c]))
  // The weak (second-order) constraints: the solve says the sketch is fully
  // constrained and still names the rows that only hold at an extreme. The
  // sentence says what the user can change; the structured list keeps the ids
  // for the drive reply and the tile mark.
  const weakReports: Array<{ constraintId: string; moveEstimate: number }> = []
  for (const [wire, cid] of constraintIds.entries()) {
    const moveEstimate = weakByWire.get(wire)
    if (moveEstimate === undefined || cid === null || cid === undefined) continue
    const authored = authoredById.get(cid)
    weakReports.push({ constraintId: cid, moveEstimate })
    warnings.push(weakConstraintWarning(weakConstraintNoun(authored?.kind, authored?.value), moveEstimate))
  }
  // Both drop routes in one list: the lowering drops (unresolvable refs, bad
  // shapes) and the solver's survivors filter. The editor draws a tile per record
  // and the cleanup command removes them, so this list is the single answer to
  // "which authored constraints does the solve not use".
  const droppedList: DroppedConstraint[] = [
    ...droppedConstraints,
    ...droppedConstraintRecords(out, input, layout, constraintIds, authoredById),
  ]
  warnings.push(...droppedList.map(d => ignoredConstraintWarning(d.id, d.kind, d.reason, pf)))
  // An unresolved projection used to be silent over MCP (it survives as a pinned
  // entity, so the solve reads clean): name it on the same warning channel.
  warnings.push(...projectionWarnings)
  // A document can still carry a degenerate curve from a load, a projection or
  // a solve that drove a dimension to zero. Name each one and say it is not in
  // the profile, so the sketch verdict reads as the real cause rather than as a
  // bare overconstraint.
  const degenerateList: DegenerateEntity[] = [...degenerate].map(([id, reason]) => ({ id, reason }))
  for (const { id, reason } of degenerateList) {
    warnings.push(degenerateEntityWarning(id, reason))
  }

  return {
    status,
    dof: out.diagnostics.dof,
    angular_miss: out.diagnostics.angularMiss,
    linear_miss: out.diagnostics.linearMiss,
    ...(warnings.length ? { solver_warning: warnings.join(' ') } : {}),
    // The free ids beside the readable names the warning carries: the drive
    // reply forwards them as the feature row's `free` list, the debug views
    // read them directly. Only an underconstrained solve has free entities.
    ...(status === 'underconstrained' && freeIds.length ? { free_entities: freeIds } : {}),
    geometry,
    entity_moved: entityMoved,
    features,
    originLocal,
    topology,
    plane_transform,
    ...(Object.keys(constraintResults).length ? { constraints: constraintResults } : {}),
    ...(Object.keys(resolvedKinds).length ? { resolved_kinds: resolvedKinds } : {}),
    ...(Object.keys(projectionMembers).length ? { projection_members: projectionMembers } : {}),
    ...(projectionErrors.length ? { projection_errors: projectionErrors } : {}),
    ...(projectionUnpositioned.length ? { projection_unpositioned: projectionUnpositioned } : {}),
    ...(degenerateList.length ? { degenerate_entities: degenerateList } : {}),
    ...(droppedList.length ? { dropped_constraints: droppedList } : {}),
    ...(weakReports.length ? { weak_constraints: weakReports } : {}),
    solve_ms: 0,
  }
}

// ─── Shared projection pin helper ───

/**
 * The entity kinds the last solve rendered, keyed by entity id. A projected
 * entity can resolve to a kind different from the stored one (a circle seen
 * edge-on renders as a line), and the solve bakes params of the resolved kind:
 * the render sketch is where that resolution is kept, because the document
 * entity keeps its pick-time kind. Empty for no render geometry.
 */
export function resolvedKindsOfSketch(sketch: Sketch | null | undefined): Record<string, string> {
  if (!sketch) return {}
  const kinds: Record<string, string> = {}
  for (const [id, entity] of Object.entries(sketch)) kinds[id] = getEntityKind(entity)
  return kinds
}

/** Collect the entity ids held by `projection` constraints so the solve, the
 *  redundancy probe and the drag preview pin exactly the same set. Entities
 *  no longer carry a `source`; the constraint's `target` names the held
 *  entity.
 *
 *  `resolvedKinds` is the last solve's render kinds (`resolvedKindsOfSketch`).
 *  The hard solve re-derives a projection's kind before lowering, but the drag
 *  preview and the authoring probe read the stored feature directly, whose
 *  entity still says the pick-time kind while its baked params are the resolved
 *  one (a circle seen edge-on is a 4-param line). Adopting the render kind here
 *  keeps those paths reading the params in the kind they were written as,
 *  instead of binding a `center` ref to the line's start. Part.tsx passes the
 *  map even when empty (no last solve has landed); an absent map means the same
 *  thing, and the document's stored kind and params are then the honest answer.
 */
export function pinProjectionTargets(
  feature: SketchFeature,
  resolvedKinds?: Readonly<Record<string, string>>,
  derivedMembers?: ReadonlyArray<ProjectionMemberEntity>,
): { loweredFeature: SketchFeature; pinnedIds: string[] } {
  const pinned = new Set<string>()
  // A construction face projection's members stay construction on the preview
  // paths too, so a drag cannot temporarily rebuild them as a profile curve.
  const constructionMembers = new Set<string>()
  const constraints = feature.constraints ?? []
  for (const c of constraints) {
    if (c.kind !== 'projection') continue
    const t = typeof c.target === 'string' ? c.target : ''
    const id = t.startsWith('$') ? t.slice(1) : t
    if (id) pinned.add(id)
    // A face projection's members are derived entities, not rows; pinning their
    // ids keeps the drag/probe paths on the same held set the hard solve uses.
    for (const memberId of Object.values(c.members ?? {})) {
      pinned.add(memberId)
      if (c.construction === true) constructionMembers.add(memberId)
    }
  }
  // Legacy v5: entities carrying `source` are held.
  for (const e of feature.entities ?? []) {
    const src = (e as { source?: unknown }).source
    if (src && typeof src === 'string') pinned.add(e.id)
  }
  let entities = feature.entities ?? []
  let initial = feature.initial
  // Face-projection members are not document rows, so the drag preview and the
  // authoring probe would otherwise lower without them and drop every
  // constraint naming one. Add the last solve's rows and params to this copy.
  if (derivedMembers !== undefined && derivedMembers.length > 0) {
    const existing = new Set(entities.map(e => e.id))
    const extra = derivedMembers.filter(member => !existing.has(member.id))
    if (extra.length > 0) {
      entities = [...entities, ...extra.map(member => ({
        id: member.id,
        kind: member.kind,
        ...(constructionMembers.has(member.id) ? { construction: true } : {}),
      }))]
      const nextInitial = { ...(initial ?? {}) }
      for (const member of extra) {
        if (nextInitial[member.id] === undefined) nextInitial[member.id] = [...member.params]
      }
      initial = nextInitial
    }
  }
  if (resolvedKinds) {
    entities = entities.map(e => {
      const kind = resolvedKinds[e.id]
      return kind && kind !== e.kind ? { ...e, kind } : e
    })
  }
  // A foreign stored block (a point cache under a declared line, a fit cache
  // under a declared spline) must not reach the preview as a zero-padded
  // segment the hard solve leaves out of its geometry. Drop it for the kind's
  // default -- the same fallback the solve uses -- and leave a block that is
  // already that default alone.
  if (initial !== undefined && pinned.size > 0) {
    const entityById = new Map(entities.map(e => [e.id, e]))
    let replaced: Record<string, number[]> | null = null
    for (const id of pinned) {
      const block = (replaced ?? initial)[id]
      const entity = entityById.get(id)
      if (block === undefined || entity === undefined) continue
      if (isProjectionPosition(block, entity.kind, entity.handles)) continue
      if (isDefaultProjectionBlock(block, entity.kind, entity.handles)) continue
      replaced ??= { ...initial }
      replaced[id] = defaultProjectionBlock(entity.kind, entity.handles)
    }
    if (replaced !== null) initial = replaced
  }
  const loweredFeature = entities === feature.entities && initial === feature.initial
    ? feature
    : {
        ...feature,
        entities,
        ...(initial !== feature.initial ? { initial } : {}),
      }
  return { loweredFeature, pinnedIds: [...pinned] }
}

// ─── Authoring probe ───

/**
 * True when the draft constraint (the one appended last to `feature` by the
 * authoring path) would add no new rank to the sketch's constraint set.
 *
 * The authoring refusal (`applyConstraint` in editorState) asks this before
 * creating a mutation, so a redundant constraint is refused like most CAD,
 * while documents that already carry one are tolerated and flagged instead.
 * The probe runs the real solver, not a static scan, exactly as
 * `probeCircleDragMode` probes the real drag solver: a static duplicate check
 * would miss the implied cases (a parallel already implied by two horizontals)
 * and could not see chained edits.
 *
 * Runs cold with the status pass skipped, because only the per-constraint
 * walk's answer is read. Returns null when no answer can be determined: no
 * solver, an unlowerable sketch, or an UNSATISFIED draft set (that is a
 * conflict, not redundancy; the solve will report it and the UI will mark the
 * culprits). Projected entities are pinned from their last resolved params, as
 * in `prepareDragContext`; `resolvedKinds` is that solve's render kinds, so a
 * projected entity that changed kind (a circle seen edge-on) is probed in its
 * resolved kind rather than the document's pick-time one.
 */
export function probeRedundantConstraint(
  feature: SketchFeature,
  draftId: string,
  resolvedKinds?: Readonly<Record<string, string>>,
  derivedMembers?: ReadonlyArray<ProjectionMemberEntity>,
): boolean | null {
  if (!solverBytes) return null
  try {
    const { loweredFeature, pinnedIds } = pinProjectionTargets(feature, resolvedKinds, derivedMembers)
    const extract = partDocToSketches([loweredFeature], [0, 0], pinnedIds)
    if (extract.skipped.length || !extract.sketches.length) return null
    const { input, constraintIds } = lowerSketch(extract.sketches[0].sketch, { skipStatusPass: true })
    const out = runSolverBytes(solverBytes, input)
    assertConstraintVerdictsMatchInput(out, input.constraints.length, false, featureDisplayName(feature))
    if (out.overallStatus === Status.overconstrained) return null
    // The draft may lower to several wire constraints (sugar expansion); it
    // counts as redundant only when every piece of it is.
    let sawDraft = false
    for (let i = 0; i < constraintIds.length; i++) {
      const cid = constraintIds[i]
      if (cid === null) continue
      if (cid !== draftId && !cid.startsWith(`${draftId}_`)) continue
      sawDraft = true
      if ((out.constraintFlags[i] & CONSTRAINT_FLAG.redundant) === 0) return false
    }
    return sawDraft ? true : null
  } catch (e) {
    swallowUnlessTrap(e)
    return null
  }
}

// ─── Drag-solve infrastructure ───

/** True once the WASM solver is loaded in THIS JS context. The worker and the
 *  main thread each hold their own module instance; the drag path runs on the
 *  main thread and must check its own instance, never assume the worker's. */
export function isSketchSolverReady(): boolean {
  return solverBytes !== null
}

/** Everything one drag needs, lowered once at pointer-down. The per-frame
 *  solve only rewrites `input.params` (warm-start + cursor) and re-encodes;
 *  the entity/constraint lowering is never repeated during the drag. */
export interface DragContext {
  /** Lowered solver input with `dragMode`/`dragAnchors`/`skipStatusPass`
   *  baked in. Its params are overwritten every frame. */
  input: FlatInput
  layout: EntityLayout[]
  /** Lowered seed params (= feature.initial = the last hard solve, because
   *  applyGeometryToFeature writes solved geometry back into `initial`).
   *  This is the frame-0 warm start. */
  params0: number[]
  /** Flat param indices the cursor position is written to each frame.
   *  For edge/entity drags this is the start of the entity's param block. */
  cursorIndices: [number, number]
  // True when this is an entity-level (whole-entity translation) drag.
  isEdgeDrag: boolean
  // Param offset of the dragged entity in the flat array.
  entityParamOffset: number
  // All [xIndex, yIndex] coordinate pair offsets within the entity's param block.
  entityCoordPairs: [number, number][]
  /** Param index of the dragged entity's size parameter (radius for a circle),
   *  or undefined when the kind has no size param (line, point, spline). Set on
   *  the edge-drag branch only for kinds that expose one; it is what lets the
   *  drag probe fall back from translate to radius when the centre is pinned. */
  sizeIndex?: number
  /** Set for an arc start/end drag. The endpoint is derived (center + radius at
   *  an angle), not a direct param pair, so the cursor XY must be mapped into
   *  the arc's radius and angle params each frame instead of written directly. */
  arcEndpoint?: {
    centerIndices: [number, number]
    radiusIndex: number
    angleIndex: number
  }
  /** Set for an ellipse major/minor axis-endpoint drag. Like `arcEndpoint`, the
   *  handle is derived (from center/a/b/theta) rather than a direct param pair,
   *  so the cursor XY is inverted into the entity's params each frame. */
  ellipseAxis?: {
    key: EllipseAxisKey
    paramOffset: number
  }
  /** Set when the drag moves a multi-selection. Each entry is one translated
   *  member: the param run the solver holds firm and the absolute coordinate
   *  pairs the cursor delta is added to. The list is built once at drag start;
   *  the gesture cannot change it. */
  group?: DragGroupMember[]
}

/** One member of a group drag, resolved against the lowered layout. A whole
 *  entity anchors its whole param block and translates every coordinate pair; a
 *  selected point anchors (and translates) only its own pair. */
export interface DragGroupMember {
  anchor: FlatDragAnchor
  coordPairs: [number, number][]
}

/**
 * Resolve a group drag's members against the lowered layout. A member whose
 * entity is not in the layout is dropped (a stale selection entry must not wedge
 * the gesture). A point member with a direct param pair anchors and translates
 * only that pair; a derived point (an arc end, an ellipse axis end) translates
 * as its whole entity, which is the first version's rule in the preview, the
 * fallback preview and the commit applier alike.
 */
function resolveGroupDragMembers(
  group: DragMember[] | undefined,
  layout: EntityLayout[],
): DragGroupMember[] | undefined {
  if (!group || group.length <= 1) return undefined
  // Resolve each member once. A member whose point is derived (an arc end, an
  // ellipse axis end) has no pair to translate, so it takes its whole entity,
  // exactly as the fallback preview and the commit applier do. Any whole-entity
  // effect for one entity is applied once, however many of its points were
  // selected: two members of one arc must not move it twice.
  const resolved = group.flatMap((member) => {
    const ent = layout.find((l) => l.id === member.entityId)
    if (!ent) return []
    const handles = ent.kind === 'fit_spline' ? fitSplineHandlesFromFlags(ent.flags) : undefined
    const pairs = entityCoordPairs(ent.kind, ent.size, handles)
    if (!pairs) return []
    const direct = member.vertexKey === 'edge'
      ? undefined
      : entityVertexIndices(ent.kind, ent.size, handles)?.[member.vertexKey]
    return [{ ent, pairs, direct }]
  })
  const wholeIds = new Set(
    resolved.filter((r) => r.direct === undefined).map((r) => r.ent.id),
  )
  const members: DragGroupMember[] = []
  const seenWhole = new Set<string>()
  for (const { ent, pairs, direct } of resolved) {
    if (wholeIds.has(ent.id)) {
      if (seenWhole.has(ent.id)) continue
      seenWhole.add(ent.id)
      members.push({
        anchor: { paramOffset: ent.offset, paramCount: ent.size },
        coordPairs: pairs.map(([xi, yi]) => [ent.offset + xi, ent.offset + yi] as [number, number]),
      })
      continue
    }
    const [px, py] = direct!
    const x = ent.offset + px
    const y = ent.offset + py
    members.push({ anchor: { paramOffset: x, paramCount: 2 }, coordPairs: [[x, y]] })
  }
  return members.length > 1 ? members : undefined
}

/**
 * Build the drag context for one drag, straight from the feature definition.
 * Runs on the main thread with no Repository and no prior in-process hard
 * solve: the last hard solve's geometry is already in `feature.initial`.
 *
 * Projected entities (carrying a `source` query) cannot be re-resolved here;
 * their last resolved params are also in `initial`, so the source is stripped
 * and the params reused. A projected entity with no params yet is dropped,
 * mirroring solveSketch's projection_errors path (constraints referencing it
 * are dropped by partDocToSketches).
 *
 * `resolvedKinds` is the last solve's render kinds, passed through to
 * `pinProjectionTargets`: a projection whose source turned edge-on has 4 line
 * params in `initial` while the document entity still stores the pick-time
 * circle kind, and adopting the render kind is what makes the preview read
 * those params as the line they are. `derivedMembers` is the last solve's face
 * projection rows; they are folded into the lowered copy so a constraint naming
 * a member is not dropped as stale during the preview.
 *
 * For vertex drags, `dragVertexKey` is the specific vertex being dragged
 * (e.g. 'start', 'end', 'center'). For edge/entity drags (whole-entity
 * translation), pass `dragVertexKey = null`. A `group` built by
 * `groupDragMembers` takes the translation path whatever the press was, and the
 * vertex key is then unused.
 *
 * Returns null when the feature does not lower, the dragged entity is not in
 * the layout, or the vertex has no direct param mapping (caller shows the
 * static sketch or a simple translation preview).
 */
export function prepareDragContext(
  feature: SketchFeature,
  dragEntityId: string,
  dragVertexKey: string | null,
  originLocal: [number, number] = [0, 0],
  resolvedKinds?: Readonly<Record<string, string>>,
  derivedMembers?: ReadonlyArray<ProjectionMemberEntity>,
  group?: DragMember[],
): DragContext | null {
  try {
    const { loweredFeature, pinnedIds } = pinProjectionTargets(feature, resolvedKinds, derivedMembers)

    // originLocal expresses the document origin (0,0,0) in this sketch's local
    // 2D frame so a `@builtin_origin` coincident pins to the actual document
    // origin during the drag preview -- not the plane's local (0,0), which
    // differ for a sketch on an offset/projected face. The hard solve already
    // does this (solveSketch); without it here the dragged geometry pins to the
    // wrong point and visibly snaps back on release.
    const extract = partDocToSketches([loweredFeature], originLocal, pinnedIds)
    if (extract.skipped.length || !extract.sketches.length) return null

    const { input, layout } = lowerSketch(extract.sketches[0].sketch)
    // This context is a drag: the per-frame seed is the previous frame (a vertex
    // drag deliberately deforms it) or params0 plus the cursor delta. `fixed`
    // and `group` must keep holding the last hard solve's shape, not that seed,
    // or the drag would teach them a deformed reference, so pin the reference
    // to `initial` here once. The hard solve leaves it unset and the solver
    // reads `params` instead.
    input.paramsReference = [...input.params]

    const anchorIndex = layout.findIndex((l) => l.id === dragEntityId)
    if (anchorIndex === -1) return null
    const ent = layout[anchorIndex]

    // A group drag is a translation of the whole selection: every member gets
    // its own anchor run and the cursor delta reaches every member's pairs. The
    // member list was built once at pointer-down and cannot change here.
    const groupMembers = resolveGroupDragMembers(group, layout)
    if (groupMembers) {
      input.options = {
        dragMode: true,
        dragAnchors: groupMembers.map((member) => member.anchor),
        skipStatusPass: true,
      }
      return {
        input,
        layout,
        params0: [...input.params],
        // The per-frame path reads `group`; these stay the pressed element's
        // block so the shape of the context matches a single edge drag.
        cursorIndices: [ent.offset, ent.offset + 1],
        isEdgeDrag: true,
        entityParamOffset: ent.offset,
        entityCoordPairs: [],
        group: groupMembers,
      }
    }

    const isEdge = dragVertexKey === null
    // A fit spline's vertex keys are positional, so its map comes from the
    // lowered block's length and handle flags rather than the static registry.
    const handles = ent.kind === 'fit_spline' ? fitSplineHandlesFromFlags(ent.flags) : undefined
    if (!isEdge) {
      const vi = entityVertexIndices(ent.kind, ent.size, handles)?.[dragVertexKey]
      if (vi) {
        // The doc param layout and the lowered layout share per-kind ordering, so
        // the registry indices apply directly at the entity's offset.
        input.options = {
          dragMode: true,
          dragAnchors: [{ paramOffset: ent.offset, paramCount: ent.size }],
          skipStatusPass: true,
        }
        return {
          input,
          layout,
          params0: [...input.params],
          cursorIndices: [ent.offset + vi[0], ent.offset + vi[1]],
          isEdgeDrag: false,
          entityParamOffset: ent.offset,
          entityCoordPairs: [],
        }
      }
      // Ellipse axis endpoints are derived from center + a/b/theta, so like the
      // arc endpoints below they have no direct param pair in the vertex map.
      // Pin them by inverting the cursor into a/b/theta each frame.
      if (ent.kind === 'ellipse' && isEllipseAxisKey(dragVertexKey)) {
        input.options = {
          dragMode: true,
          dragAnchors: [{ paramOffset: ent.offset, paramCount: ent.size }],
          skipStatusPass: true,
        }
        return {
          input,
          layout,
          params0: [...input.params],
          cursorIndices: [ent.offset + 2, ent.offset + 3],
          isEdgeDrag: false,
          entityParamOffset: ent.offset,
          entityCoordPairs: [],
          ellipseAxis: { key: dragVertexKey, paramOffset: ent.offset },
        }
      }
      // Arc start/end are derived from center + radius + angle, so they have no
      // direct param pair in the vertex map. Pin them via radius/angle instead
      // (params: [cx, cy, radius, angle_start, angle_end]).
      if (ent.kind === 'arc' && (dragVertexKey === 'start' || dragVertexKey === 'end')) {
        const angleIndex = ent.offset + (dragVertexKey === 'start' ? 3 : 4)
        input.options = {
          dragMode: true,
          dragAnchors: [{ paramOffset: ent.offset, paramCount: ent.size }],
          skipStatusPass: true,
        }
        return {
          input,
          layout,
          params0: [...input.params],
          cursorIndices: [ent.offset + 2, angleIndex],
          isEdgeDrag: false,
          entityParamOffset: ent.offset,
          entityCoordPairs: [],
          arcEndpoint: {
            centerIndices: [ent.offset, ent.offset + 1],
            radiusIndex: ent.offset + 2,
            angleIndex,
          },
        }
      }
      return null
    }

    // Edge/entity drag: whole-entity translation. The anchor entity's ALL
    // params get REG_WEIGHT_DRAG (Rust solve.rs) to bias it toward the
    // translated position. Each solve frame applies the cursor delta to every
    // coordinate pair, then lets the solver resolve constraints on other
    // entities.
    const coordPairs = entityCoordPairs(ent.kind, ent.size, handles)
    if (!coordPairs) return null
    input.options = {
      dragMode: true,
      dragAnchors: [{ paramOffset: ent.offset, paramCount: ent.size }],
      skipStatusPass: true,
    }
    return {
      input,
      layout,
      params0: [...input.params],
      cursorIndices: [ent.offset, ent.offset + 1],
      isEdgeDrag: true,
      entityParamOffset: ent.offset,
      entityCoordPairs: coordPairs as [number, number][],
      // A circle exposes a size param (radius) at offset+2; pinning the centre
      // then makes the rim drag fall back to resizing it. Other kinds have no
      // size param, so sizeIndex stays undefined and the edge drag is translate.
      sizeIndex: ent.kind === 'circle' ? ent.offset + 2 : undefined,
    }
  } catch (e) {
    swallowUnlessTrap(e)
    return null
  }
}

/** Rebuild a Sketch (for Geometry3D rendering) and a per-entity geometry map
 *  (the pointer-up commit payload) from flattened solver params + layout.
 *
 *  Exported because the live drag preview is what the viewport renders for the
 *  whole gesture: its style facts are pinned by a viewport-free unit test. */
export function paramsToPreview(
  params: number[],
  layout: EntityLayout[],
): { sketch: Sketch; geometry: Record<string, number[]> } {
  const sketch: Record<string, Entity> = {}
  const geometry: Record<string, number[]> = {}
  for (const ent of layout) {
    if (ent.id === ORIGIN_ID) continue
    const p = params.slice(ent.offset, ent.offset + ent.size)
    geometry[ent.id] = p
    switch (ent.kind) {
      case 'line':
        sketch[ent.id] = { start: [p[0], p[1]], end: [p[2], p[3]] } as Entity
        break
      case 'circle':
        sketch[ent.id] = { center: [p[0], p[1]], radius: p[2] } as Entity
        break
      case 'arc': {
        const cx = p[0], cy = p[1], r = p[2], a0 = p[3], a1 = p[4]
        const a0r = a0 * Math.PI / 180, a1r = a1 * Math.PI / 180
        sketch[ent.id] = {
          center: [cx, cy], radius: r,
          angle_start: a0, angle_end: a1,
          start: [cx + r * Math.cos(a0r), cy + r * Math.sin(a0r)],
          end: [cx + r * Math.cos(a1r), cy + r * Math.sin(a1r)],
        } as Entity
        break
      }
      case 'point':
        sketch[ent.id] = { x: p[0], y: p[1] } as Entity
        break
      case 'ellipse':
        sketch[ent.id] = { center: [p[0], p[1]], a: p[2], b: p[3], theta: p[4] } as Entity
        break
      case 'spline':
        sketch[ent.id] = { p1: [p[0], p[1]], p2: [p[2], p[3]], p3: [p[4], p[5]], p4: [p[6], p[7]] } as Entity
        break
      case 'fit_spline': {
        // The solved params are the fit points then the optional handles, the
        // same order the document stores; `ent.flags` says which are present.
        const handleCount = (ent.flags & 1 ? 1 : 0) + (ent.flags & 2 ? 1 : 0)
        const n = (p.length - 2 * handleCount) / 2
        const points: [number, number][] = []
        for (let i = 0; i < n; i++) points.push([p[2 * i], p[2 * i + 1]])
        let next = 2 * n
        const fit: { points: [number, number][]; handleStart?: [number, number]; handleEnd?: [number, number] } = { points }
        if (ent.flags & 1) {
          fit.handleStart = [p[next], p[next + 1]]
          next += 2
        }
        if (ent.flags & 2) fit.handleEnd = [p[next], p[next + 1]]
        sketch[ent.id] = fit as Entity
        break
      }
    }
    // The preview rebuilds every entity from solved params, so the authored
    // reference flag has to be re-attached: EntityLines reads `construction`
    // off this sketch to draw the dash, and a construction entity must stay
    // dashed for every drag frame, exactly as it is at rest.
    const built = sketch[ent.id]
    if (ent.construction && built) sketch[ent.id] = { ...built, construction: true }
  }
  return { sketch, geometry }
}

export interface DragSolveResult {
  // Reconstructed Sketch for Geometry3D preview rendering.
  sketch: Sketch
  /** Per-entity solved params; carried into the pointer-up commit so the hard
   *  solve seeds from the on-screen state (no basin jump on release). */
  geometry: Record<string, number[]>
  // Solved params (becomes the next frame's warm-start seed).
  params: number[]
  // Solver status string.
  status: string
}

/**
 * Run a single drag-frame WASM solve against a prepared context. Writes the
 * warm-start params + cursor into the context's input and solves; mutates
 * nothing else (not the PartDoc, not the Repository, not the feature).
 *
 * For vertex drags, `cursorWorld` pins the dragged vertex.
 * For edge/entity drags, `edgeDelta` (cursor delta from drag start) translates
 * every coordinate pair of the dragged entity before solving, each frame
 * seeds from the original params0 plus the delta. A group drag (`ctx.group`)
 * translates every member the same way, and every member's param run is
 * anchored.
 *
 * Returns null when the solver is not loaded in this context or the solve
 * throws (caller holds the last good preview).
 */
export function solveSketchDrag(
  ctx: DragContext,
  warmStartParams: number[],
  cursorWorld: [number, number],
  edgeDelta?: [number, number],
  edgeMode?: 'translate' | 'radius',
): DragSolveResult | null {
  if (!solverBytes) return null

  const { input, layout, cursorIndices } = ctx

  if (ctx.isEdgeDrag && edgeDelta) {
    // Edge/entity drag: each frame seeds from params0 (the last hard solve)
    // and translates the moved members by the cursor delta. Starting fresh
    // from params0 every frame avoids warm-start drift; the solver's
    // REG_WEIGHT_DRAG on each anchor run keeps the members near the translated
    // position while hard constraints resolve on all entities. A group drag
    // moves every member (a whole entity: each coordinate pair; a point: that
    // pair only); a single edge drag is the one-member case.
    const n = input.params.length
    for (let i = 0; i < n; i++) {
      input.params[i] = ctx.params0[i]
    }
    if (ctx.group) {
      for (const member of ctx.group) {
        for (const [xi, yi] of member.coordPairs) {
          input.params[xi] += edgeDelta[0]
          input.params[yi] += edgeDelta[1]
        }
      }
    } else {
      const offset = ctx.entityParamOffset
      for (const [xi, yi] of ctx.entityCoordPairs) {
        input.params[offset + xi] += edgeDelta[0]
        input.params[offset + yi] += edgeDelta[1]
      }
    }
  } else if (ctx.isEdgeDrag && edgeMode === 'radius' && ctx.sizeIndex !== undefined) {
    // Radius drag (the circle-rim fallback when the centre is pinned): each
    // frame seeds from params0 and sets the size param to the cursor distance
    // from the seed centre. The centre is immovable (that is why we are here),
    // so params0's centre is the correct pivot; the rim follows the cursor as a
    // radius change. No warm start, so no drift.
    const n = input.params.length
    for (let i = 0; i < n; i++) {
      input.params[i] = ctx.params0[i]
    }
    const cx = ctx.params0[ctx.entityParamOffset]
    const cy = ctx.params0[ctx.entityParamOffset + 1]
    input.params[ctx.sizeIndex] = Math.hypot(cursorWorld[0] - cx, cursorWorld[1] - cy)
  } else {
    // Vertex drag: warm-start from the previous frame, then pin the dragged
    // vertex to the cursor position. The firm REG_WEIGHT_DRAG on the anchor
    // entity's params (Rust solve.rs) keeps the vertex near the cursor while
    // constraints resolve.
    const n = Math.min(input.params.length, warmStartParams.length)
    for (let i = 0; i < n; i++) {
      input.params[i] = warmStartParams[i]
    }
    if (ctx.arcEndpoint) {
      // Map the cursor XY into the arc's radius and angle. The center comes from
      // the warm start (REG_WEIGHT_DRAG biases it to stay put unless constraints
      // move it), so radius = |cursor - center| and angle points at the cursor;
      // the endpoint then lands on the cursor.
      const { centerIndices, radiusIndex, angleIndex } = ctx.arcEndpoint
      const dx = cursorWorld[0] - input.params[centerIndices[0]]
      const dy = cursorWorld[1] - input.params[centerIndices[1]]
      input.params[radiusIndex] = Math.hypot(dx, dy)
      // Keep the angle on the warm-start branch (atan2 wraps at +/-180) so a
      // crossing of the seam does not flip the arc by a full turn.
      const prev = input.params[angleIndex]
      let ang = (Math.atan2(dy, dx) * 180) / Math.PI
      ang += Math.round((prev - ang) / 360) * 360
      input.params[angleIndex] = ang
    } else if (ctx.ellipseAxis) {
      // Invert the cursor into the ellipse's a/b/theta. The center comes from the
      // warm start, as for the arc endpoint above; a null result (cursor on the
      // center) leaves the warm-start params, holding the last good frame.
      const off = ctx.ellipseAxis.paramOffset
      const next = ellipseAxisDrag(
        input.params.slice(off, off + 5), ctx.ellipseAxis.key, cursorWorld, ENTITY_SIZE_FLOOR,
      )
      if (next) {
        input.params[off + 2] = next.a
        input.params[off + 3] = next.b
        input.params[off + 4] = next.theta
      }
    } else {
      input.params[cursorIndices[0]] = cursorWorld[0]
      input.params[cursorIndices[1]] = cursorWorld[1]
    }
  }

  let out
  try {
    out = runSolverBytes(solverBytes, input)
    // Inside the try on purpose. The hard solve throws on a count skew because a
    // wrong sketch is worse than an absent one, but this is the per-frame drag
    // path: it already degrades a failed solve to null so the caller holds the
    // last good preview, and throwing out of a pointer handler is strictly
    // worse. Same check, same detection, the response the path already chose.
    assertSolverOutputMatchesLayout(out, layout, input.options.skipStatusPass)
    assertConstraintVerdictsMatchInput(out, input.constraints.length, input.options.dragMode)
  } catch (e) {
    swallowUnlessTrap(e)
    return null
  }

  const status = STATUS_NAME[out.overallStatus]
  const { sketch, geometry } = paramsToPreview(out.paramsSolved, layout)
  return { sketch, geometry, params: out.paramsSolved, status }
}

/** Fractional response of one solve: how far the anchor entity's centre moved
 *  relative to the probe step. Returns 0 when the solve failed or the entity is
 *  absent, so a pinned centre reads as immobile rather than as a probe error. */
function translateResponse(
  res: DragSolveResult | null,
  anchorId: string,
  cx0: number,
  cy0: number,
  h: number,
): number {
  if (!res) return 0
  const g = res.geometry[anchorId]
  if (!g) return 0
  return Math.hypot(g[0] - cx0, g[1] - cy0) / h
}

/** Fractional response of the radius probe: how far the solved radius moved
 *  relative to the seeded radius step. Returns 0 when the solve failed. */
function radiusResponse(
  res: DragSolveResult | null,
  anchorId: string,
  r0: number,
  rTarget: number,
): number {
  if (!res) return 0
  const g = res.geometry[anchorId]
  if (!g || g.length < 3) return 0
  return Math.abs(g[2] - r0) / (rTarget - r0)
}

/**
 * Probe the real drag solver at drag activation to decide what a circle rim drag
 * should do. Runs the identical solve the rAF loop will run every frame, so the
 * predicted mode matches what the user sees. Three rounds:
 *   1. translate probe along +X, 2. translate probe along +Y, 3. radius probe.
 * A responsive centre (max of the two orthogonal responses) wins translate; a
 * pinned centre but responsive radius wins resize; both pinned wins locked.
 *
 * Must not touch dragSolveRegistry (the hook owns that) and must leave
 * ctx.params0 and ctx.layout untouched (solveSketchDrag re-seeds from params0
 * each call, so the probe never mutates the seed).
 */
export function probeCircleDragMode(ctx: DragContext): CircleDragMode {
  // Only circles expose a size param today; the mechanism is generic over
  // sizeIndex, so other kinds can register later. A non-edge or size-less drag
  // is always translate.
  if (!ctx.isEdgeDrag || ctx.sizeIndex === undefined) return 'translate'

  const anchor = ctx.layout.find((l) => l.offset === ctx.entityParamOffset)
  if (!anchor) return 'translate'
  const anchorId = anchor.id

  const off = ctx.entityParamOffset
  const cx0 = ctx.params0[off]
  const cy0 = ctx.params0[off + 1]
  const r0 = ctx.params0[ctx.sizeIndex]
  const h = PROBE_STEP_REL * Math.max(r0, 1)

  const probeX = solveSketchDrag(ctx, ctx.params0, [cx0 + h, cy0], [h, 0])
  const probeY = solveSketchDrag(ctx, ctx.params0, [cx0, cy0 + h], [0, h])
  const tx = translateResponse(probeX, anchorId, cx0, cy0, h)
  const ty = translateResponse(probeY, anchorId, cx0, cy0, h)

  const rTarget = r0 * (1 + PROBE_STEP_REL)
  const probeR = solveSketchDrag(ctx, ctx.params0, [cx0 + rTarget, cy0], undefined, 'radius')
  const rr = radiusResponse(probeR, anchorId, r0, rTarget)

  // Delegate the numeric verdict to the pure policy module so the thresholds stay
  // testable without WASM. The max of the two orthogonal translate responses wins,
  // so a centre free along only one axis still reads as mobile (the 1-DOF
  // misclassification guard).
  return resolveDragMode({ translateX: tx, translateY: ty, radius: rr })
}
