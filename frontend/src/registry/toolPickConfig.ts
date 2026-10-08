import type { ActiveTool } from '@/types/cad'
import {
  FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME,
  SKETCH_SURFACE_LAYER_NAME, DIMENSION_LABEL_LAYER_NAME, FEATURE_HANDLE_LAYER_NAME,
  PLANE_LAYER_NAME, PART_EDITOR_PICK_LAYER_NAMES,
} from '@/picking/layerNames'

/**
 * The complete, typed interaction policy for a tool. Every field that a tool
 * could vary about picking/selection/arming lives here so the set is in one
 * place and is reset by construction: the active tool's config fully replaces
 * the previous one, so there is no per-knob "set on activate, forget to reset
 * on deactivate" hazard. Switching tools switches the whole record atomically.
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
  /**
   * Whether committing a gesture leaves the tool armed for the next one. false
   * disarms back to idle select, the historical one-shot behaviour. The flag
   * owns the decision, not the tool: the adapter consults it after a commit.
   */
  staysArmedAfterCommit: boolean
}

// Every filtered preset is the full pick-layer list minus an explicit exclusion
// set, so a layer added to PART_EDITOR_PICK_LAYER_NAMES is pickable under every
// tool until that tool deliberately excludes it. The exclusion lists are the
// policy; keep them exhaustive.
function allExcept(excluded: readonly string[]): ReadonlySet<string> {
  const drop = new Set(excluded)
  return new Set(PART_EDITOR_PICK_LAYER_NAMES.filter(name => !drop.has(name)))
}

// Drawing tools: no dimension labels (clicks must reach draw points), no feature
// handles, no B-rep (a body face under the cursor is never selected mid-stroke;
// body snap arrives via buildBodySnapSketch), no sketch surface.
export const SKETCH_DRAW_EXCLUDED = [
  DIMENSION_LABEL_LAYER_NAME, FEATURE_HANDLE_LAYER_NAME,
  FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME,
  SKETCH_SURFACE_LAYER_NAME,
] as const

// Project tool: adds the B-rep layers back so 3D geometry can be projected;
// still no dimension labels or feature handles. sketchSurface stays excluded
// for byte-parity with the historical preset; whether project should be able to
// pick a sketch surface as a projection target can be revisited.
export const PROJECT_EXCLUDED = [
  DIMENSION_LABEL_LAYER_NAME, FEATURE_HANDLE_LAYER_NAME, SKETCH_SURFACE_LAYER_NAME,
] as const

// Dimension tool: the document planes name no point or curve, so they are no
// dimension target. Left pickable, a click on one resolved as a plane hit and
// toggled the plane into the selection instead of reading as the empty-space
// click that places the dimension; the planes fill most of the view behind a
// sketch, so placement failed wherever the label landed over one.
export const DIMENSION_EXCLUDED = [PLANE_LAYER_NAME] as const

// ─── Presets: the only sites where a new field's default is decided ───
// Select / drag / offset can pick anything (no filter). The dimension tool
// drops the planes and additionally wipes selection on enter.
const FULL_PICK: ToolPickConfig = { allowedLayers: null, clearsSelectionOnEnter: false, staysArmedAfterCommit: false }
const DIMENSION_PICK: ToolPickConfig = {
  allowedLayers: allExcept(DIMENSION_EXCLUDED), clearsSelectionOnEnter: true, staysArmedAfterCommit: true,
}
const SKETCH_DRAW: ToolPickConfig = {
  allowedLayers: allExcept(SKETCH_DRAW_EXCLUDED), clearsSelectionOnEnter: false, staysArmedAfterCommit: true,
}
const PROJECT_PICK: ToolPickConfig = {
  allowedLayers: allExcept(PROJECT_EXCLUDED), clearsSelectionOnEnter: false, staysArmedAfterCommit: true,
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

/**
 * The layers a pick may resolve from for `tool`, given the consumer's own
 * consumed-layer set: the tool's allowedLayers intersected with `consumed`, or
 * `consumed` itself (by identity) when the tool applies no filter. The single
 * place the `consumed ∩ toolAllowed` composition lives, so the dispatcher, the
 * rubber band, the project-commit resolve and the debug readout cannot drift.
 */
export function effectiveAllowedLayers(
  consumed: ReadonlySet<string>,
  tool: ActiveTool,
): ReadonlySet<string> {
  const allowed = getToolAllowedLayers(tool)
  if (!allowed) return consumed
  const out = new Set<string>()
  for (const layer of consumed) if (allowed.has(layer)) out.add(layer)
  return out
}
