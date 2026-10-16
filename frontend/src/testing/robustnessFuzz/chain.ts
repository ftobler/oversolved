// The real-kernel chain runner for robustness-fuzz. It replays a generated
// recipe step by step through the same leaf solvers the builder dispatches to
// (features/boolean.ts, filletChamfer.ts, hole.ts, array.ts, transformMirror.ts)
// against a real OccModule, and after every built step asserts the feature
// contract: the step built or refused with a message (a throw is classified the
// way builder.ts classifies it, never allowed to abort the run), the handle
// table holds exactly one live handle per body, every body is one valid solid
// with a finite positive volume, and a cut never adds volume while a join never
// removes it.
//
// A violation is reported, never thrown, so the minimiser can replay partial
// recipes and a refused step stops the chain instead of being an invariant
// failure: the store may be half-modified after a throw, and the builder's
// checkpoint restore is what production replays from there.

import { DisposeScope, withTransientScope } from '@/kernel/occ/disposeScope'
import { CountingScope } from '@/kernel/occ/countingScope'
import { HandleTable, type OccHandle } from '@/kernel/occ/handleTable'
import type { OccModule, OccShape } from '@/kernel/occ/occTypes'
import { makeBoxAt, makeCylinder, edgeToGeom, type Vec3 } from '@/kernel/occ/primitives'
import { volumeOf, countSolids, countSubShapes } from '@/kernel/occ/booleans'
import { transformCopy, makeTranslationTrsf, makeScaleTrsf } from '@/kernel/occ/transforms'
import { extrudeProfileWithLineage, revolveProfileWithLineage, sketchLoopsToFace, revolveFace } from '@/kernel/occ/prismLineage'
import { solidToEdges, readShapeFaceMetadata, bodyFrame } from '@/kernel/occ/tessellation'
import { registerSplitBodies } from '@/kernel/features/bodySplit'
import { solveBoolean } from '@/kernel/features/boolean'
import { solveFillet, solveChamfer, resolveFilletEdges } from '@/kernel/features/filletChamfer'
import { solveHole } from '@/kernel/features/hole'
import { solveArray, solveCircularArray } from '@/kernel/features/array'
import { solveMirror } from '@/kernel/features/transformMirror'
import { solveShell } from '@/kernel/features/shell'
import { solveHelix } from '@/kernel/features/helix'
import { extractOccErrorMessage } from '@/kernel/errors'
import type { Repository } from '@/kernel/query'
import type { Body } from '@/kernel/types3d'
import type { LoopEdge } from '@/kernel/profileLoops'
import type { PlaneLike } from '@/kernel/features/shared/planes'
import { FUZZ_GRID_MM, PRIMARY_BODY, EDGE_PICK_WINDOW, perturbStart, type Recipe, type RecipeStep, type AxisName } from './recipe'

type Dict = Record<string, unknown>

const PLANE_XY: PlaneLike = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 1, 0], normal: [0, 0, 1] }
const PLANE_XZ: PlaneLike = { origin: [0, 0, 0], x_axis: [1, 0, 0], y_axis: [0, 0, 1], normal: [0, 1, 0] }

function axisVec(axis: AxisName): Vec3 {
  return axis === 'x' ? [1, 0, 0] : axis === 'y' ? [0, 1, 0] : [0, 0, 1]
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s]
}

function norm(a: Vec3): Vec3 {
  const len = Math.hypot(a[0], a[1], a[2])
  if (len < 1e-12) throw new Error('degenerate direction vector')
  return [a[0] / len, a[1] / len, a[2] / len]
}

/** A unit vector perpendicular to `n`, deterministic for a given normal. */
function perpendicular(n: Vec3): Vec3 {
  const seed: Vec3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  return norm(cross(n, seed))
}

// ─── a repo for the queries the recipe authors itself ───

/**
 * The runner's Repository stand-in: the leaf solvers resolve their picks
 * through `query()` and read seeded payloads through `elements`, exactly as the
 * real Repository serves them. The recipe registers only synthetic pick
 * queries (its own direction, axis and plane picks) here; body and edge picks
 * resolve against the actual solved geometry, never through this map.
 */
class ChainRepo {
  readonly elements = new Map<string, unknown>()
  private readonly resolvers = new Map<string, () => unknown>()

  register(elementId: string, obj: unknown): void {
    this.elements.set(elementId, obj)
  }

  registerQuery(query: string, resolve: () => unknown): void {
    this.resolvers.set(query, resolve)
  }

  query(query: string): unknown {
    return this.resolvers.get(query)?.() ?? null
  }

  setFeatureOrder(): void {}
  gc(): void {}
}

// ─── profiles and primitives the recipe names ───
//
// Every extrude and revolve profile loop carries a sketch entity id, exactly
// like a production profile loop: the lineage walk (entityForEdges) matches
// edges back to their entities by id, and a body whose profile edges carry
// none mints no construction UUIDs, which makes every later edge pick
// unresolvable. The ids are stable strings, not drawn, so the naming the fuzz
// exercises is a pure function of the seed like the rest of the recipe. The
// sphere build below is the exception: it never goes through a lineage
// producer and is only ever a boolean tool, never a pick target.

/** A rounded rectangle boundary (four lines closed by four corner arcs). */
function roundedRectLoop(dx: number, dy: number, r: number): LoopEdge[] {
  return [
    { id: 'e1', kind: 'line', start: [r, 0], end: [dx - r, 0] },
    { id: 'e2', kind: 'arc', center: [dx - r, r], radius: r, angle_start_deg: 270, angle_end_deg: 360, ccw: true, start: [dx - r, 0], end: [dx, r] },
    { id: 'e3', kind: 'line', start: [dx, r], end: [dx, dy - r] },
    { id: 'e4', kind: 'arc', center: [dx - r, dy - r], radius: r, angle_start_deg: 0, angle_end_deg: 90, ccw: true, start: [dx, dy - r], end: [dx - r, dy] },
    { id: 'e5', kind: 'line', start: [dx - r, dy], end: [r, dy] },
    { id: 'e6', kind: 'arc', center: [r, dy - r], radius: r, angle_start_deg: 90, angle_end_deg: 180, ccw: true, start: [r, dy], end: [0, dy - r] },
    { id: 'e7', kind: 'line', start: [0, dy - r], end: [0, r] },
    { id: 'e8', kind: 'arc', center: [r, r], radius: r, angle_start_deg: 180, angle_end_deg: 270, ccw: true, start: [0, r], end: [r, 0] },
  ]
}

/** A rectangular ring's cross-section in the sketch's uv space. */
function rectLoop(u0: number, u1: number, v0: number, v1: number): LoopEdge[] {
  return [
    { id: 'e1', kind: 'line', start: [u0, v0], end: [u1, v0] },
    { id: 'e2', kind: 'line', start: [u1, v0], end: [u1, v1] },
    { id: 'e3', kind: 'line', start: [u1, v1], end: [u0, v1] },
    { id: 'e4', kind: 'line', start: [u0, v1], end: [u0, v0] },
  ]
}

/**
 * A sphere of radius `radius` centred at `center`, as a full revolve of a
 * semicircular profile about its own diameter. OCC.js exposes no
 * BRepPrimAPI_MakeSphere binding in this build, so this is the primitive.
 * Start/size axis conventions: the profile lies in XZ and revolves about +z.
 * The returned shape is UNTRACKED: the caller owns it.
 */
export function makeSphereAt(oc: OccModule, scope: DisposeScope, center: Vec3, radius: number): OccShape {
  const loop: LoopEdge[] = [
    { kind: 'arc', center: [0, 0], radius, angle_start_deg: 90, angle_end_deg: 270, ccw: true, start: [0, radius], end: [0, -radius] },
    { kind: 'line', start: [0, -radius], end: [0, radius] },
  ]
  const face = scope.track(sketchLoopsToFace(oc, scope, [loop], PLANE_XZ))
  const raw = scope.track(revolveFace(oc, scope, face, [0, 0, 0], [0, 0, 1], 360))
  return transformCopy(oc, scope, raw, makeTranslationTrsf(oc, scope, center[0], center[1], center[2]))
}

// ─── run outcome shapes ───

export interface ChainViolation {
  // The step index the violation was observed at.
  step: number
  message: string
}

export interface StepReport {
  step: number
  kind: RecipeStep['kind']
  status: 'built' | 'refused' | 'skipped'
  // The classified refusal or skip message when status is not 'built'.
  error?: string
  // The CountingScope's per-step disposal traffic; a built step that tracked
  // nothing is a regression of the tracking convention, which the suite
  // asserts (see loweringDisposalReal for the same idiom).
  trackCount: number
  releaseCount: number
  peakLive: number
}

export interface RefusalRecord {
  step: number
  message: string
}

/**
 * One resolved pick the chain made, recorded so the persistence check can
 * re-resolve the same query after an upstream dimension change. `query` is the
 * exact string the UI would store for the pick, `elementKind` the element's
 * geometry class at pick time (edge: line/circle/arc/ellipse/spline; face:
 * the surface type).
 */
export interface PickRecord {
  step: number
  kind: 'edge' | 'face'
  body: string
  query: string
  elementKind: string
}

export interface StalePick {
  step: number
  message: string
}

export interface ChainRun {
  violations: ChainViolation[]
  reports: StepReport[]
  refusals: RefusalRecord[]
  picks: PickRecord[]
  // Picks re-resolved under `overridePicks` that no longer resolve.
  stalePicks: StalePick[]
  // False when a refusal or a stale pick cut the chain short.
  completed: boolean
}

export interface ChainRunOptions {
  // Test seam: inject a violation the moment this step builds, so the minimiser
  // and its write-out can be pinned without waiting for a real kernel bug.
  faultAtId?: string
  // Persistent-naming replay: every pick step resolves THIS query instead of
  // drawing one from the body, so a rebuild under a changed upstream dimension
  // exercises the recorded reference exactly as production would.
  overridePicks?: ReadonlyMap<number, PickRecord>
  // Called with the step about to run. The watchdog child (chainTimeout.ts)
  // reports these over IPC so a SIGKILLed run names the step that hung instead
  // of just timing out.
  onStep?: (step: number, kind: RecipeStep['kind']) => void
}

// A recorded pick that no longer resolves (or resolves to another element
// class) on the current body. Distinct from a feature refusal: the step itself
// is fine, its stored reference is stale.
class StalePickError extends Error {}

// The step's drawn input is outside the kernel's contract (a zero-measure
// tangency), so the runner does not feed it to a fuse. The store is left
// unchanged and the chain continues; the skip is reported, never silent.
class SkipStepError extends Error {}

interface LiveChain {
  table: HandleTable
  bodyStore: Record<string, Body>
  run: ChainRun
}

// ─── the runner ───

function shapedBodyCount(bodyStore: Record<string, Body>): number {
  return Object.values(bodyStore).filter((body) => body.shape !== null).length
}

function readVolumes(oc: OccModule, scope: DisposeScope, table: HandleTable, bodyStore: Record<string, Body>): Map<string, number> {
  const out = new Map<string, number>()
  for (const [id, body] of Object.entries(bodyStore)) {
    if (body.shape === null) continue
    out.set(id, volumeOf(oc, scope, table.get<OccShape>(body.shape)))
  }
  return out
}

function bodyMetaOpts(body: Body): Dict {
  return {
    createdBy: body.created_by,
    bodyId: body.id,
    faceAncestry: body.face_ancestry ?? null,
    faceUuids: body.face_uuids ?? null,
    edgeAncestry: body.edge_ancestry ?? null,
    // Without the edge UUIDs the display queries come back tie-tagged and
    // uuid-less, and the leaf resolver (built from the production query stream
    // that always carries them) cannot match any of them; solveLocally and the
    // shared harness pass the same pair.
    edgeUuids: body.edge_uuids ?? null,
    profileQueries: body.profile_queries,
    modifiedBy: body.modified_by,
  }
}

/** The store's invariant sweep after one built step, as the plan's checks. */
function checkStore(oc: OccModule, scope: DisposeScope, table: HandleTable, bodyStore: Record<string, Body>, step: number, violations: ChainViolation[]): void {
  const push = (message: string): void => { violations.push({ step, message }) }
  for (const [id, body] of Object.entries(bodyStore)) {
    if (body.shape === null) {
      push(`body ${id} has no shape`)
      continue
    }
    const shape = table.get<OccShape>(body.shape)
    try {
      const analyzer = scope.track(new oc.BRepCheck_Analyzer(shape, true))
      if (!analyzer.IsValid_2()) push(`body ${id} is not a valid solid (BRepCheck_Analyzer)`)
    } catch (e) {
      push(`BRepCheck_Analyzer threw for body ${id}: ${extractOccErrorMessage(oc, e)}`)
    }
    try {
      const solids = countSolids(oc, scope, shape)
      if (solids !== 1) push(`body ${id} holds ${solids} solids; one Body must be one solid`)
    } catch (e) {
      push(`solid count threw for body ${id}: ${extractOccErrorMessage(oc, e)}`)
    }
    try {
      const volume = volumeOf(oc, scope, shape)
      if (!Number.isFinite(volume)) push(`body ${id} has a non-finite volume`)
      else if (volume <= 0) push(`body ${id} has volume ${volume}`)
    } catch (e) {
      push(`volume read threw for body ${id}: ${extractOccErrorMessage(oc, e)}`)
    }
  }

  const shaped = shapedBodyCount(bodyStore)
  if (shaped === 0) push('the step consumed every body in the store')
  const live = table.liveCount()
  if (live !== shaped) push(`handle table holds ${live} handles for ${shaped} bodies`)
  for (const info of table.liveHandles()) {
    if (info.refcount !== 1) push(`handle ${info.handle} has refcount ${info.refcount}; a shape carried more than one claim`)
  }
}

/**
 * The plan's monotonicity checks: a join never removes material from the body
 * it edits, a cut never adds any. Measured on the volumes of the bodies the
 * operation reports as its result, against the target's volume before the
 * step. Not a store total: the tool body is a separate store entry that
 * overlaps the target, so summing the store counts their intersection twice,
 * and a resplit can re-seat the target's id on a different sibling, so a
 * per-id reading is wrong for splits too.
 */
function checkMonotonic(step: RecipeStep, targetBefore: number | undefined, editedVolumes: number[], stepIndex: number, violations: ChainViolation[]): void {
  const joinLike =
    (step.kind === 'boolean' && step.operation === 'union')
    || step.kind === 'linear-array'
    || step.kind === 'circular-array'
    || (step.kind === 'mirror' && step.keepOriginal && step.merge)
  // Shell is drawn inward only, so like a cut it never adds material.
  const cutLike = (step.kind === 'boolean' && step.operation === 'subtract') || step.kind === 'hole' || step.kind === 'shell'
  if (!joinLike && !cutLike) return
  if (targetBefore === undefined) {
    violations.push({ step: stepIndex, message: `the ${step.kind} step ran with no target volume to compare against` })
    return
  }
  const after = editedVolumes.reduce((sum, volume) => sum + volume, 0)
  const tol = 1e-6 * Math.max(1, Math.abs(targetBefore))
  if (joinLike && after < targetBefore - tol) {
    violations.push({ step: stepIndex, message: `join removed volume from its target: ${targetBefore} -> ${after}` })
  }
  if (cutLike && after > targetBefore + tol) {
    violations.push({ step: stepIndex, message: `cut added volume to its target: ${targetBefore} -> ${after}` })
  }
}

function requireBody(bodyStore: Record<string, Body>, id: string): Body {
  const body = bodyStore[id]
  if (body === undefined || body.shape === null) throw new Error(`body '${id}' is not in the store`)
  return body
}

/** Register the recipe's start body, with the construction names its producer minted. */
function applyStart(oc: OccModule, scope: DisposeScope, table: HandleTable, bodyStore: Record<string, Body>, step: Extract<RecipeStep, { kind: 'start' }>): void {
  const template = { id: PRIMARY_BODY, createdBy: step.id, sketchId: 'sk_seed', profileQueries: [] as string[] }
  if (step.shape === 'box') {
    const solid = scope.track(makeBoxAt(oc, scope, [0, 0, 0], step.size[0], step.size[1], step.size[2]))
    registerSplitBodies(oc, scope, table, bodyStore, solid, template)
    return
  }
  if (step.shape === 'arc-profile') {
    const loops = [roundedRectLoop(step.size[0], step.size[1], step.arcRadius)]
    const lineage = extrudeProfileWithLineage(oc, scope, loops, PLANE_XY, [0, 0, 1], step.size[2], 'sk_seed', step.id)
    scope.track(lineage.solid)
    registerSplitBodies(oc, scope, table, bodyStore, lineage.solid, { ...template, ...lineage })
    return
  }
  const loops = [rectLoop(step.size[0], step.size[0] + step.size[1], 0, step.size[2])]
  const lineage = revolveProfileWithLineage(oc, scope, loops, PLANE_XZ, [0, 0, 0], [0, 0, 1], step.angleDeg, 'sk_seed', step.id)
  scope.track(lineage.solid)
  registerSplitBodies(oc, scope, table, bodyStore, lineage.solid, { ...template, ...lineage })
}

function toolBboxSize(step: Extract<RecipeStep, { kind: 'boolean' }>): Vec3 {
  if (step.tool === 'box') return step.size
  if (step.tool === 'cylinder') return [step.size[0], step.size[0], step.size[2]]
  return [step.size[0], step.size[0], step.size[0]]
}

/**
 * The world corner the tool is built from: the tool's bbox anchored to the
 * target's bbox (`min`/`max`) or centred on it, then nudged by the drawn grid
 * offset. Anchoring to the bbox is what makes flush, coincident faces common;
 * the offset is what makes the tool cross an edge, a corner or a face.
 */
function toolCorner(step: Extract<RecipeStep, { kind: 'boolean' }>, center: Vec3, half: Vec3): Vec3 {
  const size = toolBboxSize(step)
  const anchor: Vec3 = step.anchor === 'center'
    ? [center[0] - size[0] / 2, center[1] - size[1] / 2, center[2] - size[2] / 2]
    : step.anchor === 'min'
      ? [center[0] - half[0], center[1] - half[1], center[2] - half[2]]
      : [center[0] + half[0] - size[0], center[1] + half[1] - size[1], center[2] + half[2] - size[2]]
  return add(anchor, scale(step.offset as Vec3, FUZZ_GRID_MM))
}

// How far the near-contact probe dilates the union tool, in mm. One micron:
// two grid-snapped placements are either exactly touching or at least a
// rounding error apart, and OCC's own intersection confusion band is orders
// below this.
const CONTACT_EPS_MM = 1e-3

type UnionContact = 'overlap' | 'face' | 'tangent' | 'disjoint' | 'unknown'

/**
 * Classify a union tool's contact with the target before feeding it to the
 * fuse. OCC's fuse WELDS solids that touch in a zero-measure set (an edge, a
 * vertex, or a contact inside the intersection's tolerance band) and can hand
 * back a non-manifold, BRepCheck-invalid solid while the kernel reports ok:
 * the fuse path has no overlap probe by design (features/boolean.ts), and a
 * face-flush contact is valid. So: a positive-volume overlap and a face-flush
 * contact go to the real fuse; a contact that only appears once the tool is
 * dilated by a micron is 'tangent' and is skipped; a still-empty intersection
 * is a genuinely disjoint tool and fuses into a two-solid compound as usual. A
 * probe that cannot run is 'unknown': the fuse proceeds and surfaces its own
 * outcome rather than the harness hiding it.
 */
export function classifyUnionContact(oc: OccModule, scope: DisposeScope, target: OccShape, tool: OccShape): UnionContact {
  const E = oc.TopAbs_ShapeEnum
  const common = (a: OccShape, b: OccShape): OccShape | null => {
    const algo = scope.track(new oc.BRepAlgoAPI_Common_1())
    const args = scope.track(new oc.TopTools_ListOfShape_1())
    args.Append_1(a)
    const tools = scope.track(new oc.TopTools_ListOfShape_1())
    tools.Append_1(b)
    algo.SetArguments(args)
    algo.SetTools(tools)
    algo.SetToFillHistory(false)
    algo.Build()
    if (!algo.IsDone()) return null
    return scope.track(algo.Shape())
  }
  try {
    const overlap = common(target, tool)
    if (overlap === null) return 'unknown'
    if (countSolids(oc, scope, overlap) > 0) return 'overlap'
    if (countSubShapes(oc, scope, overlap, E.TopAbs_FACE) > 0) return 'face'
    // No overlap, no shared face: check whether the tool is within the epsilon
    // band of the target by probing a micron-dilated copy.
    const { center, half } = bodyFrame(oc, scope, tool)
    const minHalf = Math.min(...half.filter((h) => h > 1e-9))
    if (!Number.isFinite(minHalf) || minHalf <= 0) return 'unknown'
    const enlarged = scope.track(transformCopy(oc, scope, tool, makeScaleTrsf(oc, scope, center, 1 + CONTACT_EPS_MM / minHalf)))
    const near = common(target, enlarged)
    if (near === null) return 'unknown'
    return countSolids(oc, scope, near) > 0 ? 'tangent' : 'disjoint'
  } catch {
    return 'unknown'
  }
}

/** Build and register one boolean tool body from the recipe's placement. */
function applyTool(oc: OccModule, scope: DisposeScope, table: HandleTable, bodyStore: Record<string, Body>, step: Extract<RecipeStep, { kind: 'boolean' }>): string {
  const target = requireBody(bodyStore, step.target)
  const targetShape = table.get<OccShape>(target.shape as OccHandle)
  const { center, half } = bodyFrame(oc, scope, targetShape)
  const corner = toolCorner(step, center, half)
  const size = toolBboxSize(step)
  let solid: OccShape
  if (step.tool === 'box') {
    solid = makeBoxAt(oc, scope, corner, size[0], size[1], size[2])
  } else if (step.tool === 'cylinder') {
    const r = step.size[0] / 2
    solid = makeCylinder(oc, scope, [corner[0] + r, corner[1] + r, corner[2]], [0, 0, 1], r, step.size[2])
  } else {
    const r = step.size[0] / 2
    solid = makeSphereAt(oc, scope, [corner[0] + r, corner[1] + r, corner[2] + r], r)
  }
  scope.track(solid)
  registerSplitBodies(oc, scope, table, bodyStore, solid, { id: step.toolBody, createdBy: step.toolId, profileQueries: [] })
  return step.toolBody
}

/**
 * Resolve one edge pick off the body's display-sorted edge list.
 *
 * On an unnamed body (the synthetic box start carries no lineage) colliding
 * display queries get a positional tie tag (emitWithTiesTagged) that the
 * leaf's edge index does not mint, so a drawn pick can be one the leaf cannot
 * resolve; the step then refuses and the sweep's refusal cap keeps the class
 * visible without failing on it. Production's own unnamed bodies (imports)
 * meet the same seam through the pick repository, not this runner.
 */
function pickEdge(oc: OccModule, table: HandleTable, body: Body, edgeIndex: number): { query: string; kind: string } {
  const result = solidToEdges(oc, table, body.shape as OccHandle, bodyMetaOpts(body))
  if (result.edges.length === 0) throw new Error(`body '${body.id}' has no edges to pick`)
  const window = Math.min(result.edges.length, EDGE_PICK_WINDOW)
  const at = edgeIndex % window
  const query = result.edge_queries[at]
  if (!query) throw new Error(`edge ${at} of body '${body.id}' has no query`)
  return { query, kind: result.edges[at].kind }
}

/**
 * Resolve a persisted edge pick against the live body, the same
 * resolveFilletEdges path the fillet leaf uses. Throws StalePickError when the
 * query matches nothing or now names another curve class.
 */
function resolveRecordedEdge(oc: OccModule, scope: DisposeScope, table: HandleTable, body: Body, pick: PickRecord): { query: string; kind: string } {
  const edges = resolveFilletEdges(oc, scope, table, body, [pick.query], null)
  if (edges.length === 0) throw new StalePickError(`edge query ${pick.query} no longer resolves`)
  for (const edge of edges) {
    const kind = edgeToGeom(oc, scope, edge).ed.kind
    if (kind !== pick.elementKind) {
      throw new StalePickError(`edge query ${pick.query} resolved to a ${kind}, picked as ${pick.elementKind}`)
    }
  }
  return { query: pick.query, kind: pick.elementKind }
}

/**
 * Resolve a persisted face pick against the live body with the same tier the
 * production repository resolves first: the construction UUID alone. The rest
 * of the stored query (`@createdBy@body@cls_*`) is weaker-tier context the
 * repository only consults once the UUID is dead, so matching the full token
 * here would flag a reference red that production still resolves (the fuzz
 * found exactly that: a face kept its UUID across an upstream dimension change
 * but its classifier set lost a token). A live UUID that now names another
 * surface class is the type-change failure the check wants, and a dead UUID is
 * a red pick. Unnamed faces carry no UUID and have no persistent reference, so
 * the drawn pick stands in.
 */
function resolveRecordedFace(oc: OccModule, scope: DisposeScope, shape: OccShape, body: Body, faceIndex: number, pick: PickRecord): AnyFace {
  const token = /@u\|([^@&|:]+)/.exec(pick.query)
  const faces = facesOf(oc, scope, shape, body)
  if (token === null) return pickFace(faces, faceIndex)
  const uuid = token[1]
  const at = faces.findIndex((face) => face.query.includes(`@u|${uuid}`))
  if (at < 0) {
    throw new StalePickError(
      `face query ${pick.query} no longer resolves among the body's ${faces.length} faces ` +
      `(${faces.filter((f) => f.surfaceType === 'flatface').length} planar)`,
    )
  }
  if (faces[at].surfaceType !== pick.elementKind) {
    throw new StalePickError(`face query ${pick.query} resolved to a ${faces[at].surfaceType}, picked as ${pick.elementKind}`)
  }
  return faces[at]
}

interface AnyFace {
  centroid: Vec3
  normal: Vec3
  query: string
  surfaceType: string
}

/** The body's faces in display order, the pool face picks are drawn from and resolved against. */
function facesOf(oc: OccModule, scope: DisposeScope, shape: OccShape, body: Body): AnyFace[] {
  const meta = readShapeFaceMetadata(oc, scope, shape, bodyMetaOpts(body))
  return meta.face_data.map((datum, index) => ({
    centroid: datum.centroid as Vec3,
    normal: datum.normal as Vec3,
    query: meta.face_queries[index],
    surfaceType: datum.surface_type,
  }))
}

/** A drawn face pick lands on a planar face, where holes and mirror planes live. */
function pickFace(faces: AnyFace[], faceIndex: number): AnyFace {
  const planar = faces.filter((face) => face.surfaceType === 'flatface')
  if (planar.length === 0) throw new Error('the body has no planar face to pick')
  return planar[faceIndex % Math.min(planar.length, 4)]
}

// The bodies an operation reports as its result, for the monotonic check.
interface StepOutcome {
  editedIds?: string[]
}

/** One step against the live store. Throws on any feature refusal. */
function applyStep(
  oc: OccModule,
  scope: DisposeScope,
  table: HandleTable,
  bodyStore: Record<string, Body>,
  repo: ChainRepo,
  step: RecipeStep,
  stepIndex: number,
  picks: PickRecord[],
  overridePicks: ReadonlyMap<number, PickRecord> | undefined,
): StepOutcome {
  const repoForLeaves = repo as unknown as Repository
  const expected = overridePicks?.get(stepIndex)
  if (step.kind === 'start') {
    applyStart(oc, scope, table, bodyStore, step)
    return {}
  }
  if (step.kind === 'boolean') {
    const toolBody = applyTool(oc, scope, table, bodyStore, step)
    if (step.operation === 'union') {
      const target = requireBody(bodyStore, step.target)
      const tool = requireBody(bodyStore, toolBody)
      const contact = classifyUnionContact(oc, scope, table.get<OccShape>(target.shape as OccHandle), table.get<OccShape>(tool.shape as OccHandle))
      if (contact === 'tangent') {
        // Drop the tool we just minted; the store is exactly as before.
        table.releaseFor(tool.shape as OccHandle, step.toolId)
        delete bodyStore[toolBody]
        throw new SkipStepError('union tool only touches the target in a zero-measure set; skipped (an OCC weld of that tangency is non-manifold)')
      }
    }
    const result = solveBoolean(oc, scope, table, {
      id: step.id,
      boolean: { operation: step.operation, target: step.target, tools: [toolBody] },
    }, repoForLeaves, bodyStore)
    return { editedIds: result.body_ids }
  }
  if (step.kind === 'fillet' || step.kind === 'chamfer') {
    const body = requireBody(bodyStore, step.target)
    const { query, kind } = expected !== undefined && expected.kind === 'edge'
      ? resolveRecordedEdge(oc, scope, table, body, expected)
      : pickEdge(oc, table, body, step.edge)
    picks.push({ step: stepIndex, kind: 'edge', body: step.target, query, elementKind: kind })
    if (step.kind === 'fillet') {
      solveFillet(oc, scope, table, {
        id: step.id,
        fillet: { source_body: step.target, edges: [query], radius: step.radius },
      }, repoForLeaves, bodyStore)
    } else {
      solveChamfer(oc, scope, table, {
        id: step.id,
        chamfer: { source_body: step.target, edges: [query], distance: step.distance, kind: 'distance' },
      }, repoForLeaves, bodyStore)
    }
    return {}
  }
  if (step.kind === 'hole') {
    const body = requireBody(bodyStore, step.target)
    const face = expected !== undefined && expected.kind === 'face'
      ? resolveRecordedFace(oc, scope, table.get<OccShape>(body.shape as OccHandle), body, step.face, expected)
      : pickFace(facesOf(oc, scope, table.get<OccShape>(body.shape as OccHandle), body), step.face)
    if (face.query) picks.push({ step: stepIndex, kind: 'face', body: step.target, query: face.query, elementKind: face.surfaceType })
    const xAxis = perpendicular(face.normal)
    const yAxis = cross(face.normal, xAxis)
    const sketchId = `sk_${step.id}`
    repo.register('_pt_' + sketchId, { origin: face.centroid, x_axis: xAxis, y_axis: yAxis, normal: face.normal })
    repo.register(`${sketchId}/p1/xy`, { external_xy: [0, 0] })
    const result = solveHole(oc, scope, table, {
      id: step.id,
      hole: {
        sketch: '@' + sketchId,
        diameter: step.diameter,
        depth_mode: step.depthMode,
        depth: step.depth,
        // The face's own normal points out of the body; drilling inward needs
        // the reversed axis or the blind cutter starts outside and removes nothing.
        direction: 'reverse',
        target: step.target,
      },
    }, repoForLeaves, bodyStore, { [sketchId]: { entities: [{ id: 'p1', kind: 'point' }] } })
    return { editedIds: result.body_ids }
  }
  if (step.kind === 'linear-array') {
    const query = `@fuzz/axis/${step.id}`
    repo.registerQuery(query, () => ({ start: [0, 0, 0], end: axisVec(step.axis) }))
    const result = solveArray(oc, scope, table, {
      id: step.id,
      array: {
        source_body: step.target, mode: 'linear', count_x: step.count, pitch_x: step.pitch,
        include_source: true, operation: 'add', direction_x_query: query,
      },
    }, repoForLeaves, bodyStore)
    return { editedIds: result.body_ids }
  }
  if (step.kind === 'circular-array') {
    const body = requireBody(bodyStore, step.target)
    const { center } = bodyFrame(oc, scope, table.get<OccShape>(body.shape as OccHandle))
    const dir = axisVec(step.axis)
    const query = `@fuzz/axis/${step.id}`
    repo.registerQuery(query, () => ({ start: center, end: add(center, dir) }))
    const result = solveCircularArray(oc, scope, table, {
      id: step.id,
      circular_array: {
        source_body: step.target, count: step.count, step_angle: step.stepDeg,
        include_source: true, operation: 'add', axis: query,
      },
    }, repoForLeaves, bodyStore)
    return { editedIds: result.body_ids }
  }
  if (step.kind === 'shell') {
    const body = requireBody(bodyStore, step.target)
    const face = expected !== undefined && expected.kind === 'face'
      ? resolveRecordedFace(oc, scope, table.get<OccShape>(body.shape as OccHandle), body, step.face, expected)
      : pickFace(facesOf(oc, scope, table.get<OccShape>(body.shape as OccHandle), body), step.face)
    if (face.query) picks.push({ step: stepIndex, kind: 'face', body: step.target, query: face.query, elementKind: face.surfaceType })
    const result = solveShell(oc, scope, table, {
      id: step.id,
      shell: { faces: [face.query], thickness: step.thickness, direction: 'inward' },
    }, repoForLeaves, bodyStore)
    return { editedIds: result.body_ids }
  }
  if (step.kind === 'helix') {
    // A reference curve on a picked cylinder face of the running body: it
    // changes no body, only registers the `_curve_<id>` descriptor and its
    // axis/endpoints. The reference resolves through the same repo the leaves
    // use, so a degenerate body (no cylinder face) refuses by name.
    const body = requireBody(bodyStore, step.target)
    const faces = facesOf(oc, scope, table.get<OccShape>(body.shape as OccHandle), body)
    const cylinders = faces.filter((f) => f.surfaceType === 'cylinderface')
    if (cylinders.length === 0) throw new Error('the body has no cylinder face to carry a helix')
    const face = cylinders[step.face % cylinders.length]
    const query = `@fuzz/helix/${step.id}`
    repo.registerQuery(query, () => ({
      type: 'cylinderface', body_id: body.id, face_index: faces.indexOf(face),
      axis: face.normal, centroid: face.centroid,
    }))
    solveHelix(oc, scope, table, {
      id: step.id,
      helix: {
        reference: query, radius_mode: 'derived', mode: 'pitch_turns',
        pitch: step.pitch, turns: step.turns, hand: 'right', direction: 'normal',
        start_angle: 0, offset: 0,
      },
    }, repoForLeaves, bodyStore)
    return {}
  }
  // mirror
  const body = requireBody(bodyStore, step.target)
  let planeQuery: string
  if (step.plane === 'face') {
    const face = expected !== undefined && expected.kind === 'face'
      ? resolveRecordedFace(oc, scope, table.get<OccShape>(body.shape as OccHandle), body, step.face, expected)
      : pickFace(facesOf(oc, scope, table.get<OccShape>(body.shape as OccHandle), body), step.face)
    if (face.query) picks.push({ step: stepIndex, kind: 'face', body: step.target, query: face.query, elementKind: face.surfaceType })
    planeQuery = `@fuzz/plane/${step.id}`
    repo.registerQuery(planeQuery, () => ({ type: 'flatface', origin: face.centroid, normal: face.normal }))
  } else {
    planeQuery = `@fuzz/plane/${step.id}`
    repo.registerQuery(planeQuery, () => ({ type: 'flatface', origin: [0, 0, 0], normal: axisVec(step.plane as AxisName) }))
  }
  const result = solveMirror(oc, scope, table, {
    id: step.id,
    mirror: { body: step.target, plane: planeQuery, keep_original: step.keepOriginal, merge: step.merge },
  }, repoForLeaves, bodyStore)
  return { editedIds: result.body_ids }
}

/** Execute a recipe, holding all live resources; the caller disposes `table`. */
function executeChain(oc: OccModule, recipe: Recipe, options: ChainRunOptions): LiveChain {
  const table = new HandleTable()
  const bodyStore: Record<string, Body> = {}
  const repo = new ChainRepo()
  const run: ChainRun = { violations: [], reports: [], refusals: [], picks: [], stalePicks: [], completed: true }

  try {
    for (let i = 0; i < recipe.steps.length; i++) {
      const step = recipe.steps[i]
      options.onStep?.(i, step.kind)
      const before = withTransientScope((s) => readVolumes(oc, s, table, bodyStore))
      const scope = new CountingScope()
      let report: StepReport
      try {
        const outcome = applyStep(oc, scope, table, bodyStore, repo, step, i, run.picks, options.overridePicks)
        report = {
          step: i, kind: step.kind, status: 'built',
          trackCount: scope.trackCount, releaseCount: scope.releaseCount, peakLive: scope.peakLive,
        }
        if (options.faultAtId === step.id) {
          run.violations.push({ step: i, message: `injected fault at ${step.id}` })
        }
        checkStore(oc, scope, table, bodyStore, i, run.violations)
        const editedVolumes = (outcome.editedIds ?? []).map((id) => {
          const edited = bodyStore[id]
          return edited === undefined || edited.shape === null ? 0 : volumeOf(oc, scope, table.get<OccShape>(edited.shape))
        })
        checkMonotonic(step, step.kind === 'start' ? undefined : before.get(step.target), editedVolumes, i, run.violations)
      } catch (e) {
        const message = extractOccErrorMessage(oc, e)
        if (e instanceof StalePickError) {
          run.stalePicks.push({ step: i, message })
          report = {
            step: i, kind: step.kind, status: 'refused', error: message,
            trackCount: scope.trackCount, releaseCount: scope.releaseCount, peakLive: scope.peakLive,
          }
          run.completed = false
        } else if (e instanceof SkipStepError) {
          report = {
            step: i, kind: step.kind, status: 'skipped', error: message,
            trackCount: scope.trackCount, releaseCount: scope.releaseCount, peakLive: scope.peakLive,
          }
        } else {
          run.refusals.push({ step: i, message: message || '(empty error message)' })
          if (!message) run.violations.push({ step: i, message: 'a refusal carried no message' })
          report = {
            step: i, kind: step.kind, status: 'refused', error: message,
            trackCount: scope.trackCount, releaseCount: scope.releaseCount, peakLive: scope.peakLive,
          }
          run.completed = false
        }
      } finally {
        scope.dispose()
      }
      run.reports.push(report)
      if (!run.completed) break
    }
  } catch (e) {
    // executeChain must not throw: anything that gets here is a harness bug or
    // an assertion helper crash, and is reported rather than lost.
    run.violations.push({ step: run.reports.length, message: `the runner itself threw: ${extractOccErrorMessage(oc, e)}` })
    run.completed = false
  }
  return { table, bodyStore, run }
}

/** Replay a recipe and return its violations, refusals and reports. */
export function runChain(oc: OccModule, recipe: Recipe, options: ChainRunOptions = {}): ChainRun {
  const live = executeChain(oc, recipe, options)
  try {
    return live.run
  } finally {
    live.table.disposeAll()
  }
}

// ─── persistent naming ───

/**
 * Replay the same recipe under a perturbed upstream dimension, but let every
 * modifier step resolve the pick recorded on the unperturbed run instead of a
 * freshly drawn one. A recorded pick that no longer resolves, or that now names
 * another element class, is the persistent-naming failure the plan wants
 * caught: the dimension moved and the stored reference went red.
 *
 * `reportUnreached` additionally reports picks the perturbed chain never
 * reached because an earlier step refused. The caller sets it for base runs
 * that completed, where a reference that cannot even be tested is not a green
 * reference; on a base run that already refused, the refusal is the reported
 * finding and only resolution failures at reached steps are new information.
 */
export function runPersistenceCheck(
  oc: OccModule,
  recipe: Recipe,
  picks: readonly PickRecord[],
  options: { reportUnreached?: boolean } = {},
): StalePick[] {
  if (picks.length === 0) return []
  const overrides = new Map<number, PickRecord>()
  for (const pick of picks) overrides.set(pick.step, pick)
  const live = executeChain(oc, perturbStart(recipe), { overridePicks: overrides })
  try {
    const stale = [...live.run.stalePicks]
    const reportUnreached = options.reportUnreached ?? false
    const reached = new Set(live.run.reports.filter((report) => report.status !== 'refused').map((report) => report.step))
    for (const pick of picks) {
      // A step that already reported its stale pick above needs no second
      // entry: the resolution failure is the finding, and the refusal is its
      // consequence, not a separate one.
      if (reportUnreached && !reached.has(pick.step) && !stale.some((s) => s.step === pick.step)) {
        stale.push({ step: pick.step, message: `the perturbed chain did not reach the pick step (${live.run.refusals[0]?.message ?? 'refused earlier'})` })
      }
    }
    return stale
  } finally {
    live.table.disposeAll()
  }
}
