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

import { makePrng } from '@/hooks/__tests__/fuzzHarness'
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
export const PRIMARY_BODY = 'body_seed'

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
  toolBody: string
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
}

export interface RecipeLinearArray {
  kind: 'linear-array'
  id: string
  target: string
  count: number
  pitch: number
  axis: AxisName
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

export type RecipeStep =
  | RecipeStart
  | RecipeBoolean
  | RecipeFillet
  | RecipeChamfer
  | RecipeHole
  | RecipeLinearArray
  | RecipeCircularArray
  | RecipeMirror
  | RecipeShell
  | RecipeHelix

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
      kind: 'start', id: 'seed', body: PRIMARY_BODY, shape: 'ring',
      size: [outer, outer - 2 * wall, grid(drawInt(rnd, 4, 9))],
      arcRadius: 0, angleDeg: 0,
    }
  }
  const roll = rnd()
  if (roll < 0.45) {
    return {
      kind: 'start', id: 'seed', body: PRIMARY_BODY, shape: 'box',
      size: [grid(drawInt(rnd, 8, 18)), grid(drawInt(rnd, 8, 18)), grid(drawInt(rnd, 4, 9))],
      arcRadius: 0, angleDeg: 0,
    }
  }
  if (roll < 0.75) {
    return {
      kind: 'start', id: 'seed', body: PRIMARY_BODY, shape: 'arc-profile',
      size: [grid(drawInt(rnd, 10, 18)), grid(drawInt(rnd, 10, 18)), grid(drawInt(rnd, 4, 8))],
      arcRadius: grid(drawInt(rnd, 2, 4)), angleDeg: 0,
    }
  }
  return {
    kind: 'start', id: 'seed', body: PRIMARY_BODY, shape: 'revolve',
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
    kind: 'boolean', id, operation: drawOf(rnd, ['union', 'subtract'] as const), target: PRIMARY_BODY,
    tool, toolId: `tool_${id}`, toolBody: `body_tool_${id}`, size,
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
      return { kind: 'fillet', id, target: PRIMARY_BODY, edge: drawInt(rnd, 0, 11), radius: grid(drawInt(rnd, 1, 2)) }
    case 'chamfer':
      return { kind: 'chamfer', id, target: PRIMARY_BODY, edge: drawInt(rnd, 0, 11), distance: grid(drawInt(rnd, 1, 2)) }
    case 'hole': {
      const face = drawInt(rnd, 0, 3)
      return {
        kind: 'hole', id, target: PRIMARY_BODY, face,
        diameter: grid(drawInt(rnd, 2, 3)), depth: grid(drawInt(rnd, 2, 4)),
        depthMode: rnd() < 0.7 ? 'blind' : 'through_all',
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
        return { kind: 'linear-array', id, target: PRIMARY_BODY, count: drawInt(rnd, 2, 3), pitch: grid(drawInt(rnd, 2, 4)), axis: drawOf(rnd, ['x', 'y', 'z'] as const) }
      }
      return { kind: 'circular-array', id, target: PRIMARY_BODY, count: drawInt(rnd, 3, 4), stepDeg: drawOf(rnd, [90, 120] as const), axis: drawOf(rnd, ['x', 'y', 'z'] as const) }
    }
    case 'mirror':
      return {
        kind: 'mirror', id, target: PRIMARY_BODY,
        plane: drawOf(rnd, ['x', 'y', 'z', 'face'] as const), face: drawInt(rnd, 0, 3),
        keepOriginal: rnd() < 0.7, merge: rnd() < 0.8,
      }
    case 'shell':
      return {
        kind: 'shell', id, target: PRIMARY_BODY, face: drawInt(rnd, 0, 3),
        thickness: grid(drawInt(rnd, 1, 2)),
      }
    case 'helix':
      return {
        kind: 'helix', id, target: PRIMARY_BODY, face: drawInt(rnd, 0, 3),
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
  return { seed, steps }
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
