import type { ActiveTool } from '@/types/cad'
import {
  FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME,
  PLANE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME,
  ORIGIN_LAYER_NAME,
} from '@/picking/layerNames'

/**
 * The complete, typed interaction policy for a tool. Every field that a tool
 * could vary about picking/selection lives here so the set is in one place and
 * is reset by construction: the active tool's config fully replaces the previous
 * one, so there is no per-knob "set on activate, forget to reset on deactivate"
 * hazard. Switching tools switches the whole record atomically.
 *
 * The forcing functions this design buys (see TOOL_PICK_CONFIG below):
 *   - add a field here  -> every preset / entry fails to compile until it
 *     supplies a value, so a new knob can never be silently skipped;
 *   - add an ActiveTool -> the exhaustive Record fails to compile until the new
 *     tool declares its policy, so a new tool can never fall through to a
 *     hidden default.
 *
 * IMPORTANT: never fill gaps with `{ ...DEFAULT, ...override }`. A spread/Partial
 * default merge silently satisfies a missing field and destroys both guarantees.
 * Defaults must come from explicit, fully-typed presets only.
 */
export interface ToolPickConfig {
  /**
   * ID layers the pointer dispatcher (and rubber-band select) may route a pick
   * from. `null` means "all layers" (no filter). A non-null set is intersected
   * with the consumer's own consumed-layer set.
   */
  allowedLayers: ReadonlySet<string> | null
  /**
   * Whether entering this tool clears the current normal selection. Used so a
   * tool that gathers its own picks (e.g. dimension) is not contaminated by a
   * pre-existing selection.
   */
  clearsSelectionOnEnter: boolean
}

// Sketch-plane pick layers shared by every sketch tool: the sketch's own
// geometry plus the plane and origin used for snapping. Body geometry the user
// can snap to during drawing arrives here too, projected into sketch-snap
// entities (see buildBodySnapSketch), so drawing tools never need the B-rep
// layers directly.
const SKETCH_PICK_LAYERS = [
  PLANE_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME, ORIGIN_LAYER_NAME,
] as const

// The 3D solid layers. Only the project tool resolves these while a sketch is
// being edited; bodies stay in the pick buffer (collision pass is always live)
// but lower-priority than sketch layers, so sketch items win where they overlap.
const BREP_PICK_LAYERS = [FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME] as const

// ─── Presets: the only sites where a new field's default is decided ───
// Select / drag / dimension / offset can pick anything (no filter). The
// dimension tool additionally wipes selection on enter. Drawing tools see a
// sketch-only subset: it excludes dimensionLabel (so labels don't intercept
// strokes) and the B-rep layers (so a body face under the cursor is never
// selected mid-stroke). The project tool adds the B-rep layers back so the user
// can pick 3D geometry to project onto the sketch plane.
const FULL_PICK: ToolPickConfig = { allowedLayers: null, clearsSelectionOnEnter: false }
const DIMENSION_PICK: ToolPickConfig = { allowedLayers: null, clearsSelectionOnEnter: true }
const SKETCH_DRAW: ToolPickConfig = {
  allowedLayers: new Set(SKETCH_PICK_LAYERS), clearsSelectionOnEnter: false,
}
const PROJECT_PICK: ToolPickConfig = {
  allowedLayers: new Set([...BREP_PICK_LAYERS, ...SKETCH_PICK_LAYERS]),
  clearsSelectionOnEnter: false,
}

/**
 * Exhaustive per-tool policy table. Keyed on the full `ActiveTool` union (minus
 * null) so the compiler forces an entry for every present and future tool. The
 * null (no active tool = idle select) case is handled by `getToolPickConfig`.
 */
const TOOL_PICK_CONFIG: Record<NonNullable<ActiveTool>, ToolPickConfig> = {
  drag: FULL_PICK,
  dimension: DIMENSION_PICK,
  project: PROJECT_PICK,
  offset: FULL_PICK,
  line: SKETCH_DRAW,
  rect: SKETCH_DRAW,
  center_rect: SKETCH_DRAW,
  circle: SKETCH_DRAW,
  arc: SKETCH_DRAW,
  ellipse: SKETCH_DRAW,
  spline: SKETCH_DRAW,
  point: SKETCH_DRAW,
  ngon: SKETCH_DRAW,
  mirror: SKETCH_DRAW,
}

// No active tool behaves like the neutral selection cursor: pick anything,
// never wipe selection.
const NULL_TOOL_PICK_CONFIG: ToolPickConfig = FULL_PICK

/** The complete interaction policy for the given tool (null = no active tool). */
export function getToolPickConfig(tool: ActiveTool): ToolPickConfig {
  return tool === null ? NULL_TOOL_PICK_CONFIG : TOOL_PICK_CONFIG[tool]
}

/**
 * Per-tool allow-list of ID layers the pointer dispatcher will route from.
 * `null` means "all layers" (no filter). Thin accessor over `getToolPickConfig`
 * kept for the pick dispatch / rubber-band call sites.
 */
export function getToolAllowedLayers(tool: ActiveTool): ReadonlySet<string> | null {
  return getToolPickConfig(tool).allowedLayers
}
