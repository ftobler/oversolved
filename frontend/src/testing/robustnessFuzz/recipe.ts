// The seeded recipe generator for the geometry fuzz (robustness-fuzz). A
// recipe is a feature chain the runner replays against the real OCC kernel:
// one start body, then up to eight edits drawn from the leaf features the app
// ships (boolean join/cut of a box, cylinder or sphere, fillet, chamfer, hole,
// linear and circular array, mirror). Placements snap to a 2.5 mm grid and
// anchor to the running body's bounding box, so coincident faces, flush tools
// and tangencies are drawn often instead of never.
//
// The generator is a pure function of the seed (the mulberry32 PRNG the session
// fuzz already uses) and never touches OCC: it draws body/edge/face indices,
// and the runner resolves them against the solved geometry at run time. That is
// also what makes the recipe the unit the minimiser drops steps from.

import { makePrng } from '@/utils/core/prng'
import { threadDesignations } from '@/kernel/threadTable'

// The thread designations a fuzz hole's cosmetic thread is picked from. The
// pick is derived from the already-drawn face index (0..3), so the sweep
// exercises the first four entries (M2x0.4 .. M4x0.7), not the whole table: the
// threaded PATH is what this step covers, and the table's rows are pinned by its
// own test plus the M6x1 leaf and oracle cases.
const DESIGNATIONS = threadDesignations()

// Every placement and size is authored in grid steps and emitted in mm, so the
// recipe reads in the same units the document does while the seed still
// generates exact multiplications of the grid.
export const FUZZ_GRID_MM = 2.5

export type StartShapeKind = 'box' | 'arc-profile' | 'revolve' | 'ring'
export type ToolShapeKind = 'box' | 'cylinder' | 'sphere'
export type ToolAnchor = 'center' | 'min' | 'max'
export type AxisName = 'x' | 'y' | 'z'

// The one body every start step mints and every modifier step edits. Booleans
// keep the target's id (resplitBody re-seats the parent), so the chain stays on
// one part and a cut that disconnects it splits off siblings without renaming
// the primary.
export const PRIMARY_PART = 'body_seed'

export interface RecipeStart {
  kind: 'start'
  id: string
  body: string
  shape: StartShapeKind
  // box/arc-profile: [dx, dy, dz] (extruded along +z). revolve: [innerRadius,
  // ringWidth, height] revolved about the world z axis. ring: [outerDiameter,
  // innerDiameter, height], extruded along +z as a nested-loop washer.
  size: [number, number, number]
  // arc-profile corner radius; 0 for the other shapes.
  arcRadius: number
  // revolve sweep in degrees; 0 for the other shapes.
  angleDeg: number
}

export interface RecipeBoolean {
  kind: 'boolean'
  id: string
  operation: 'union' | 'subtract'
  target: string
  tool: ToolShapeKind
  // The producer feature id the tool body is registered under, and the body id
  // it takes in the store. Both are deterministic so a persisted target ref
  // stays stable across a rebuild of the same recipe.
  toolId: string
  toolPart: string
  // box: [dx, dy, dz]; cylinder: [diameter, diameter, height]; sphere: [diameter, 0, 0].
  size: [number, number, number]
  anchor: ToolAnchor
  // Offset from the anchor point, in grid steps.
  offset: [number, number, number]
}

export interface RecipeFillet {
  kind: 'fillet'
  id: string
  target: string
  // Index into the target's display-sorted edge list, at run time taken modulo
  // the first EDGE_PICK_WINDOW edges so the pick stays in the box-like part of
  // the list instead of landing on a fillet's own blend edges.
  edge: number
  radius: number
}

export interface RecipeChamfer {
  kind: 'chamfer'
  id: string
  target: string
  edge: number
  distance: number
}

export interface RecipeHole {
  kind: 'hole'
  id: string
  target: string
  // Index into the target's planar faces; the runner registers a drill site on
  // that face's plane, drilled inward along its outward normal.
  face: number
  diameter: number
  depth: number
  depthMode: 'blind' | 'through_all'
  // The thread-table designation for a cosmetic thread, or null for a plain
  // bore. The thread changes no geometry; it is derived from `face` at draw
  // time so the generator's stream does not move.
  thread: string | null
  // The tapped depth, or null/absent for the whole bore. Derived like `thread`
  // (no randomness consumed); absent in recipes pinned before it existed.
  threadDepth?: number | null
}

export interface RecipeLinearArray {
  kind: 'linear-array'
  id: string
  target: string
  count: number
  pitch: number
  axis: AxisName
  // Absent in recipes pinned before the instance model: the default draw never
  // draws them, and the derived sweep below only adds them when its option is
  // on. A centered array also copies to the reverse side; skip names 1-based
  // instance indices to leave out.
  centered?: boolean
  skip?: number[]
}

export interface RecipeCircularArray {
  kind: 'circular-array'
  id: string
  target: string
  count: number
  stepDeg: number
  // The rotation axis runs through the body's own centre along this world axis,
  // so the instances sweep back over the body and fuse tangentially rather than
  // orbiting it in free space.
  axis: AxisName
}

export interface RecipeCurveArray {
  kind: 'curve-array'
  id: string
  target: string
  count: number
  // The path is a straight line on the world XY plane from the origin along
  // +X; its length and the spacing mode decide whether every instance fits.
  length: number
  spacing: 'equal' | 'distance'
  distance: number
  orientation: 'tangent' | 'fixed'
}

export interface RecipeInstanceArray {
  kind: 'instance-array'
  id: string
  target: string
  // Target points on the world XY plane; the source's centroid is the
  // reference, so each copy is translated by point - centroid.
  points: [number, number][]
}

export interface RecipeMirror {
  kind: 'mirror'
  id: string
  target: string
  // A world plane through the origin, or a picked planar face of the target.
  plane: AxisName | 'face'
  // Index into the target's planar faces; used only for the face plane.
  face: number
  keepOriginal: boolean
  merge: boolean
}

export interface RecipeFeatureMirror {
  kind: 'feature-mirror'
  id: string
  target: string
  // The body bbox axis the mirror plane is normal to, at the body's own centre
  // along it, so the reflected cut lands back inside the body.
  plane: AxisName
  // Index into the target's planar faces the synthetic cut source sits on.
  face: number
  // The cut's depth, grid-snapped. A blind cut from the face inward removes
  // material whatever the body's thickness.
  depth: number
}

export interface RecipeShell {
  kind: 'shell'
  id: string
  target: string
  // Index into the target's planar faces; the runner opens that face and keeps
  // the rest of the wall, so the shell removes material.
  face: number
  thickness: number
}

export interface RecipeHelix {
  kind: 'helix'
  id: string
  target: string
  // Index into the target's cylinder faces; taken modulo the count at run time.
  face: number
  // Axial rise per turn. Kept at least two grid steps so a swept profile would
  // not immediately self-overlap (the plan's "pitch >= 2x a small profile").
  pitch: number
  turns: number
}

export interface RecipeSplit {
  kind: 'split'
  id: string
  target: string
  // The cutting plane is the world plane normal to this axis, at a fraction of
  // the body's bbox along it (drawn 0.2..0.8 and grid-snapped at run time), so
  // it always crosses the body instead of missing it.
  axis: AxisName
  fraction: number
  keep: 'above' | 'below' | 'both'
}

export interface RecipeMoveFace {
  kind: 'move-face'
  id: string
  target: string
  // Index into the target's display-sorted faces; taken modulo the count at run
  // time. A curved pick may be refused by the direct tweak, which the chain
  // records as a normal stop.
  face: number
  // Signed along the face's outward normal; never 0 (the identity would not
  // exercise the construction).
  distance: number
}

// Deliberately not drawn: `wrap`. Its tool is a ruled loft between two analytic
// surfaces the closed-form oracles in kernel/occ/__tests__/wrapSolidReal.test.ts
// and kernel/features/__tests__/wrapReal.test.ts already pin per surface kind,
// and the chain's start bodies rarely offer a curved face a footprint can stay
// on, so a drawn step would mostly exercise its own refusals while redrawing
// every pinned seed after it.
export type RecipeStep =
  | RecipeStart
  | RecipeBoolean
  | RecipeFillet
  | RecipeChamfer
  | RecipeHole
  | RecipeLinearArray
  | RecipeCircularArray
  | RecipeCurveArray
  | RecipeInstanceArray
  | RecipeMirror
  | RecipeFeatureMirror
  | RecipeShell
  | RecipeHelix
  | RecipeSplit
  | RecipeMoveFace

export interface Recipe {
  seed: number
  steps: RecipeStep[]
}

export interface RecipeOptions {
  // One start step plus up to this many drawn edits (before the per-kind
  // budget in freshBudget() can end the chain earlier).
  maxSteps?: number
  // Force the start body's shape. The default draw never picks a holed profile
  // (box, arc-profile and revolve are all hole-free), so a nested-loop washer
  // never reached this fuzz. Used by the dedicated ring sweep, which is a
  // separate seed family: the default draw consumes no extra randomness, so
  // every existing seed's chain stays byte-identical and the pinned findings
  // keep their seeds.
  startShape?: StartShapeKind
  // Append one split step drawn from a DERIVED PRNG (`seed ^ SPLIT_SALT`),
  // never from the main stream: every existing seed's chain stays
  // byte-identical and the pinned findings keep their seeds, the same rule the
  // ring start follows. Used by the dedicated split sweep.
  splitTail?: boolean
  // Draw centered and skip for the linear arrays from a DERIVED PRNG too
  // (`seed ^ PATTERN_SALT`). This is a new seed family: the default draw never
  // reads those fields and the main stream is untouched, so every existing
  // pinned seed draws the same chain.
  patternInstanceModel?: boolean
  // Append one instance-array step drawn from a DERIVED PRNG
  // (`seed ^ INSTANCE_PATTERN_SALT`), the same rule: a new seed family that
  // leaves every existing chain byte-identical.
  instancePatternTail?: boolean
  // Append one curve-array step drawn from a DERIVED PRNG
  // (`seed ^ CURVE_PATTERN_SALT`), the same rule: a new seed family that leaves
  // every existing chain byte-identical.
  curvePatternTail?: boolean
  // Append one feature-subject mirror step from a DERIVED PRNG
  // (`seed ^ FEATURE_MIRROR_SALT`). The step synthesises the cut source itself,
  // so the main stream stays untouched and every existing seed keeps its chain.
  featureMirrorTail?: boolean
  // Append one move-face step from a DERIVED PRNG (`seed ^ MOVE_FACE_SALT`).
  // Another new seed family: the main stream is untouched, so every existing
  // pinned seed draws the same chain. The direct tweak refuses some picks (a
  // curved split sibling, the cone apex), and the chain records that as a stop.
  moveFaceTail?: boolean
}

// The number of leading display-sorted edges an edge pick is allowed to land
// on. The sort puts straight edges first, so this biases fillets and chamfers
// toward the body's principal edges (where they build) without ever making the
// pick unreachably deterministic.
export const EDGE_PICK_WINDOW = 12

function drawInt(rnd: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rnd() * (hi - lo + 1))
}

function drawOf<T>(rnd: () => number, values: readonly T[]): T {
  return values[Math.floor(rnd() * values.length)]
}

function grid(steps: number): number {
  return steps * FUZZ_GRID_MM
}

function drawStart(rnd: () => number, forced?: StartShapeKind): RecipeStart {
  if (forced === 'ring') {
    // Wall width 2.5..7.5 so the bore always stays open (inner > 0) yet is
    // always a large fraction of the outer, which is the ratio the shipped
    // defect (V_outer - 2 * V_inner, negative once the bore passed the wall)
    // needed to appear.
    const outer = grid(drawInt(rnd, 8, 18))
    const wall = grid(drawInt(rnd, 1, 3))
    return {
      kind: 'start', id: 'seed', body: PRIMARY_PART, shape: 'ring',
      size: [outer, outer - 2 * wall, grid(drawInt(rnd, 4, 9))],
      arcRadius: 0, angleDeg: 0,
    }
  }
  const roll = rnd()
  if (roll < 0.45) {
    return {
      kind: 'start', id: 'seed', body: PRIMARY_PART, shape: 'box',
      size: [grid(drawInt(rnd, 8, 18)), grid(drawInt(rnd, 8, 18)), grid(drawInt(rnd, 4, 9))],
      arcRadius: 0, angleDeg: 0,
    }
  }
  if (roll < 0.75) {
    return {
      kind: 'start', id: 'seed', body: PRIMARY_PART, shape: 'arc-profile',
      size: [grid(drawInt(rnd, 10, 18)), grid(drawInt(rnd, 10, 18)), grid(drawInt(rnd, 4, 8))],
      arcRadius: grid(drawInt(rnd, 2, 4)), angleDeg: 0,
    }
  }
  return {
    kind: 'start', id: 'seed', body: PRIMARY_PART, shape: 'revolve',
    size: [grid(drawInt(rnd, 1, 3)), grid(drawInt(rnd, 2, 4)), grid(drawInt(rnd, 4, 8))],
    arcRadius: 0, angleDeg: drawOf(rnd, [180, 270, 360]),
  }
}

function drawTool(rnd: () => number): { tool: ToolShapeKind; size: [number, number, number] } {
  const tool = drawOf(rnd, ['box', 'cylinder', 'sphere'] as const)
  if (tool === 'box') {
    return { tool, size: [grid(drawInt(rnd, 4, 8)), grid(drawInt(rnd, 4, 8)), grid(drawInt(rnd, 3, 6))] }
  }
  if (tool === 'cylinder') {
    const d = grid(drawInt(rnd, 3, 6))
    return { tool, size: [d, d, grid(drawInt(rnd, 3, 6))] }
  }
  const d = grid(drawInt(rnd, 3, 6))
  return { tool, size: [d, 0, 0] }
}

function drawBoolean(rnd: () => number, id: string): RecipeBoolean {
  const { tool, size } = drawTool(rnd)
  return {
    kind: 'boolean', id, operation: drawOf(rnd, ['union', 'subtract'] as const), target: PRIMARY_PART,
    tool, toolId: `tool_${id}`, toolPart: `body_tool_${id}`, size,
    anchor: drawOf(rnd, ['center', 'min', 'min', 'max', 'max'] as const),
    offset: [drawInt(rnd, -2, 2), drawInt(rnd, -2, 2), drawInt(rnd, -2, 1)],
  }
}

// How many of each step kind a recipe may stack. The bound is a cost control,
// not a modelling rule: every extra boolean/array/fillet rebuilds a body whose
// face count the previous step just multiplied, and an unbounded draw put
// multi-second chains into the sweep. Exhausted, the chain simply ends early.
interface StepBudget {
  boolean: number
  fillet: number
  chamfer: number
  hole: number
  array: number
  mirror: number
  shell: number
  helix: number
}

function freshBudget(): StepBudget {
  return { boolean: 2, fillet: 2, chamfer: 2, hole: 2, array: 1, mirror: 1, shell: 1, helix: 1 }
}

function drawStep(rnd: () => number, id: string, budget: StepBudget): RecipeStep | null {
  const roll = rnd()
  const spend = (kind: keyof StepBudget): boolean => {
    if (budget[kind] <= 0) return false
    budget[kind]--
    return true
  }
  let kind: keyof StepBudget
  if (roll < 0.33) kind = 'boolean'
  else if (roll < 0.50) kind = 'fillet'
  else if (roll < 0.61) kind = 'chamfer'
  else if (roll < 0.74) kind = 'hole'
  else if (roll < 0.84) kind = 'array'
  else if (roll < 0.90) kind = 'mirror'
  // Shell has the lowest weight: a small thickness keeps most picks buildable,
  // and a kernel refusal is an allowed failure, not a soundness break.
  else if (roll < 0.95) kind = 'shell'
  // The helix is a reference curve, not a body edit: it changes no body, so it
  // is a cheap extra coverage step with the same lowest weight.
  else kind = 'helix'
  if (!spend(kind)) return null
  switch (kind) {
    case 'boolean': return drawBoolean(rnd, id)
    case 'fillet':
      return { kind: 'fillet', id, target: PRIMARY_PART, edge: drawInt(rnd, 0, 11), radius: grid(drawInt(rnd, 1, 2)) }
    case 'chamfer':
      return { kind: 'chamfer', id, target: PRIMARY_PART, edge: drawInt(rnd, 0, 11), distance: grid(drawInt(rnd, 1, 2)) }
    case 'hole': {
      const face = drawInt(rnd, 0, 3)
      // Drawn in the original order (diameter, depth, mode): reordering the
      // draws would move every pinned seed's chain.
      const diameter = grid(drawInt(rnd, 2, 3))
      const depth = grid(drawInt(rnd, 2, 4))
      const depthMode = rnd() < 0.7 ? 'blind' : 'through_all'
      return {
        kind: 'hole', id, target: PRIMARY_PART, face, diameter, depth, depthMode,
        // A tapped run shorter than the bore on odd faces, an overrun the leaf
        // must clamp on face 2, the whole bore otherwise. Derived from the
        // drawn values for the same no-extra-randomness reason as `thread`.
        threadDepth: face % 2 === 1 ? depth / 2 : face === 2 ? depth * 2 : null,
        // The cosmetic thread is derived from the already-drawn face index, so
        // the generator consumes no extra randomness: every seed's chain stays
        // byte-identical to the pre-thread generator and the pinned findings
        // keep their seeds. That index is drawn 0..3, so only the table's first
        // four designations appear here (see DESIGNATIONS above); plain bores
        // are covered by the leaf and oracle tests.
        thread: DESIGNATIONS[face % DESIGNATIONS.length],
      }
    }
    case 'array': {
      if (rnd() < 0.7) {
        return { kind: 'linear-array', id, target: PRIMARY_PART, count: drawInt(rnd, 2, 3), pitch: grid(drawInt(rnd, 2, 4)), axis: drawOf(rnd, ['x', 'y', 'z'] as const) }
      }
      return { kind: 'circular-array', id, target: PRIMARY_PART, count: drawInt(rnd, 3, 4), stepDeg: drawOf(rnd, [90, 120] as const), axis: drawOf(rnd, ['x', 'y', 'z'] as const) }
    }
    case 'mirror':
      return {
        kind: 'mirror', id, target: PRIMARY_PART,
        plane: drawOf(rnd, ['x', 'y', 'z', 'face'] as const), face: drawInt(rnd, 0, 3),
        keepOriginal: rnd() < 0.7, merge: rnd() < 0.8,
      }
    case 'shell':
      return {
        kind: 'shell', id, target: PRIMARY_PART, face: drawInt(rnd, 0, 3),
        thickness: grid(drawInt(rnd, 1, 2)),
      }
    case 'helix':
      return {
        kind: 'helix', id, target: PRIMARY_PART, face: drawInt(rnd, 0, 3),
        pitch: grid(drawInt(rnd, 2, 4)), turns: drawInt(rnd, 2, 4),
      }
  }
}

/** Draw the recipe for one seed: a start step plus up to `maxSteps` edits. */
export function generateRecipe(seed: number, options: RecipeOptions = {}): Recipe {
  const rnd = makePrng(seed)
  // Mostly short chains with the occasional long one: a chain's cost grows
  // with how many times the previous step's face count was rebuilt, so the
  // sweep budget wants the mean low, while `up to eight` still has to occur.
  const stepCount = Math.min(options.maxSteps ?? 8, drawInt(rnd, 1, 5) + (rnd() < 0.15 ? drawInt(rnd, 1, 3) : 0))
  const steps: RecipeStep[] = [drawStart(rnd, options.startShape)]
  const budget = freshBudget()
  for (let i = 0; i < stepCount; i++) {
    const step = drawStep(rnd, `s${i + 1}`, budget)
    if (step === null) break
    steps.push(step)
  }
  if (options.patternInstanceModel) applyPatternInstanceModel(steps, seed)
  if (options.splitTail) steps.push(drawSplitTail(seed))
  if (options.curvePatternTail) steps.push(drawCurvePatternTail(seed))
  if (options.instancePatternTail) steps.push(drawInstancePatternTail(seed))
  if (options.featureMirrorTail) steps.push(drawFeatureMirrorTail(seed))
  if (options.moveFaceTail) steps.push(drawMoveFaceTail(seed))
  return { seed, steps }
}

/**
 * The one curve-array step a `curvePatternTail` recipe appends, from its own
 * derived stream: the path is a straight line on the world XY plane, and the
 * draw keeps the length short enough that distance spacing sometimes runs past
 * the path end, which is the partial-result path this kind owns.
 */
export const CURVE_PATTERN_SALT = 0x7ab31d05

function drawCurvePatternTail(seed: number): RecipeCurveArray {
  const rnd = makePrng((seed ^ CURVE_PATTERN_SALT) >>> 0)
  return {
    kind: 'curve-array',
    id: 'curve_tail',
    target: PRIMARY_PART,
    count: drawInt(rnd, 2, 4),
    length: grid(drawInt(rnd, 4, 8)),
    spacing: drawOf(rnd, ['equal', 'distance'] as const),
    distance: grid(drawInt(rnd, 2, 4)),
    orientation: drawOf(rnd, ['tangent', 'fixed'] as const),
  }
}

/** The derived stream the instance-pattern tail reads. */
export const INSTANCE_PATTERN_SALT = 0x6b1f4c23

/**
 * The one instance-array step an `instancePatternTail` recipe appends. The
 * targets are two to four grid points on the world XY plane; the body
 * subject's centroid is the reference, so each copy is a pure translation.
 */
function drawInstancePatternTail(seed: number): RecipeInstanceArray {
  const rnd = makePrng((seed ^ INSTANCE_PATTERN_SALT) >>> 0)
  const count = drawInt(rnd, 2, 4)
  const points: [number, number][] = []
  for (let i = 0; i < count; i++) {
    points.push([grid(drawInt(rnd, -4, 4)), grid(drawInt(rnd, -4, 4))])
  }
  return { kind: 'instance-array', id: 'instance_tail', target: PRIMARY_PART, points }
}

/** The derived stream the instance-model sweep reads. */
export const PATTERN_SALT = 0x3c9e5a17

/**
 * Turn a linear array into a centered and/or skipped one, drawn from a stream
 * derived from the seed. The main stream is untouched, so the option never
 * redraws an existing seed's chain: the same rule the ring start and the split
 * tail follow. A skipped index is always one the count generates, and the skip
 * list never covers every copy, so the step still builds geometry.
 */
function applyPatternInstanceModel(steps: RecipeStep[], seed: number): void {
  const rnd = makePrng((seed ^ PATTERN_SALT) >>> 0)
  for (const step of steps) {
    if (step.kind !== 'linear-array') continue
    const centered = rnd() < 0.5
    step.centered = centered
    const generated = centered ? 2 * (step.count - 1) : step.count - 1
    if (rnd() < 0.35 && generated > 1) {
      // Positive indices only: the same list is valid whether or not centered
      // is on, and it never names the original.
      const index = drawInt(rnd, 1, step.count - 1)
      step.skip = [index]
    }
  }
}

/**
 * The one split step a `splitTail` recipe appends. Its stream is derived from
 * the seed, so turning the option on never redraws the main chain: the same
 * argument the ring start makes, and the reason every pinned seed keeps its
 * seed.
 */
export const SPLIT_SALT = 0x5f3a71c9

/**
 * The one feature-subject mirror step a `featureMirrorTail` recipe appends. Its
 * own stream is derived from the seed, so the main chain is untouched. The step
 * is self-contained: it cuts a small slot with a synthetic extrude and then
 * mirrors that feature, which is the path under test.
 */
export const FEATURE_MIRROR_SALT = 0x2c8d4b61

/**
 * The one move-face step a `moveFaceTail` recipe appends. Derived from the seed
 * like the other tails, so the main chain (and every pinned seed) is untouched.
 * A box's four side and two cap faces are all planar, so the tail reaches a
 * build; a curved body may refuse, which the chain records as a stop.
 */
export const MOVE_FACE_SALT = 0x6b1e94d3

function drawMoveFaceTail(seed: number): RecipeMoveFace {
  const rnd = makePrng((seed ^ MOVE_FACE_SALT) >>> 0)
  return {
    kind: 'move-face',
    id: 'move_face_tail',
    target: PRIMARY_PART,
    face: drawInt(rnd, 0, 3),
    distance: drawOf(rnd, [-2, -1, 1, 2] as const) * FUZZ_GRID_MM,
  }
}

function drawFeatureMirrorTail(seed: number): RecipeFeatureMirror {
  const rnd = makePrng((seed ^ FEATURE_MIRROR_SALT) >>> 0)
  return {
    kind: 'feature-mirror',
    id: 'feature_mirror_tail',
    target: PRIMARY_PART,
    plane: drawOf(rnd, ['x', 'y', 'z'] as const),
    face: drawInt(rnd, 0, 3),
    depth: grid(drawInt(rnd, 2, 4)),
  }
}

function drawSplitTail(seed: number): RecipeSplit {
  const rnd = makePrng((seed ^ SPLIT_SALT) >>> 0)
  return {
    kind: 'split',
    id: 'split_tail',
    target: PRIMARY_PART,
    axis: drawOf(rnd, ['x', 'y', 'z'] as const),
    fraction: drawInt(rnd, 2, 8) / 10,
    keep: drawOf(rnd, ['above', 'below', 'both'] as const),
  }
}

// ─── perturbation ───

/**
 * Grow the start body by one grid step along its first size axis, everything
 * else identical. This is the upstream dimension change the persistent-naming
 * check rebuilds the chain under: the recipe references (edge and face
 * queries) must still resolve on the perturbed run, or a downstream pick went
 * red because a dimension moved.
 */
export function perturbStart(recipe: Recipe): Recipe {
  const steps = recipe.steps.map((step) => {
    if (step.kind !== 'start') return { ...step }
    const size: [number, number, number] = [...step.size]
    if (step.shape === 'revolve') size[1] += FUZZ_GRID_MM
    else size[0] += FUZZ_GRID_MM
    return { ...step, size }
  })
  return { seed: recipe.seed, steps }
}
