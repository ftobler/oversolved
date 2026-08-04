// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// Invariant validation for sketch editor store state.
// Uses the 3-tier guard pattern: throw in test, warn in dev, silent in prod.

import type { SelectionDomain } from '@/types/cad'

export const devOnly = import.meta.env?.DEV ?? false
export const testMode = import.meta.env?.MODE === 'test'

/**
 * Emit a fail-loud signal when an invariant is violated.
 * Throws in test mode, warns in dev, silent in production.
 */
export function failLoud(message: string): void {
  if (testMode) {
    throw new Error(message)
  }
  if (devOnly) {
    console.warn(message)
  }
}

type DrawingToolKind = 'line' | 'rect' | 'center_rect' | 'circle' | 'arc' | 'ellipse' | 'spline' | 'point' | 'ngon' | 'project'

export const DRAWING_TOOLS = new Set<DrawingToolKind>(['line', 'rect', 'center_rect', 'circle', 'arc', 'ellipse', 'spline', 'point', 'ngon', 'project'])

// ─── Selection State Invariants ───

export interface SelectionInvariantState {
  normalSelection: Set<string>
  // Live pick refinement: query -> the pickKeys of the primitives selected under
  // it. Every claimed query must still be in normalSelection; an orphan claim
  // would resurrect as a ghost highlight when its query is re-selected.
  selectedPicks: Map<string, Set<string>>
  chipOwnedSelection: Set<string>
  selectionDomain: SelectionDomain
}

const KNOWN_SELECTION_PREFIXES = [
  'entity:', 'vertex:', 'face:', 'edge:', 'constraint:', 'dock:', 'isect:',
  '@builtin_', '@body_', '@',
]

function isValidSelectionId(id: string): boolean {
  if (id === '') return false
  for (const p of KNOWN_SELECTION_PREFIXES) {
    if (id.startsWith(p)) return true
  }
  if (id.startsWith('?')) return true
  return false
}

export function deriveSelectionDomain(ids: ReadonlySet<string>): SelectionDomain {
  if (ids.size === 0) return 'sketch_2d'
  let hasSketch = false
  let has3d = false
  let hasPlane = false
  for (const id of ids) {
    if (id.startsWith('entity:') || id.startsWith('vertex:') || id.startsWith('face:') || id.startsWith('constraint:') || id.startsWith('dock:') || id.startsWith('isect:')) {
      hasSketch = true
    } else if (id.startsWith('?') || (id.startsWith('@') && id.includes('/'))) {
      has3d = true
    } else if (id.startsWith('@')) {
      hasPlane = true
    }
  }
  if (hasSketch && !has3d && !hasPlane) return 'sketch_2d'
  if (has3d && !hasSketch && !hasPlane) return 'body_3d'
  if (hasPlane && !hasSketch && !has3d) return 'plane_3d'
  return 'mixed'
}

export function validateSelectionState(state: SelectionInvariantState): void {
  const { normalSelection, selectedPicks, chipOwnedSelection, selectionDomain } = state

  // A chip-owned id outside normalSelection is how a re-click toggle-off is
  // signalled, but it is only ever legal in the gap before usePickField's effect
  // consumes it (that hook fails loud if no consumer can). Anything that reaches
  // a validation gate in this state has stranded the signal.
  for (const v of chipOwnedSelection) {
    if (!normalSelection.has(v)) {
      failLoud(
        `[invariant] chipOwnedSelection has orphan '${v}' not in normalSelection`,
      )
    }
  }

  for (const [q, claims] of selectedPicks.entries()) {
    if (!normalSelection.has(q)) {
      failLoud(
        `[invariant] selectedPicks has orphan claim for query '${q}' not in normalSelection`,
      )
    }
    if (claims.size === 0) {
      failLoud(
        `[invariant] selectedPicks has empty claim set for query '${q}'`,
      )
    }
  }

  const expected = deriveSelectionDomain(normalSelection)
  if (selectionDomain !== expected) {
    failLoud(
      `[invariant] selectionDomain is '${selectionDomain}' but normalSelection yields '${expected}'`,
    )
  }

  for (const id of normalSelection) {
    if (!isValidSelectionId(id)) {
      failLoud(
        `[invariant] normalSelection contains unrecognized entry '${id}'`,
      )
    }
  }
}

export function repairSelectionState(state: SelectionInvariantState): Partial<SelectionInvariantState> | null {
  const { normalSelection, selectedPicks, chipOwnedSelection, selectionDomain } = state
  const patches: Partial<SelectionInvariantState> = {}

  // Drop unrecognized ids first. Every repair below keys off the surviving
  // selection, and deriving them from the pre-filter set would emit a patch that
  // still fails validation -- the repair must be a fixpoint.
  let live: ReadonlySet<string> = normalSelection
  if (devOnly || testMode) {
    const filtered = new Set<string>()
    for (const id of normalSelection) {
      if (isValidSelectionId(id)) {
        filtered.add(id)
      }
    }
    if (filtered.size !== normalSelection.size) {
      patches.normalSelection = filtered
      live = filtered
    }
  }

  const repairedChip = new Set(chipOwnedSelection)
  for (const v of chipOwnedSelection) {
    if (!live.has(v)) {
      repairedChip.delete(v)
    }
  }
  if (repairedChip.size !== chipOwnedSelection.size) {
    patches.chipOwnedSelection = repairedChip
  }

  const repairedPicks = new Map(selectedPicks)
  for (const [q, claims] of selectedPicks.entries()) {
    if (!live.has(q) || claims.size === 0) {
      repairedPicks.delete(q)
    }
  }
  if (repairedPicks.size !== selectedPicks.size) {
    patches.selectedPicks = repairedPicks
  }

  const expectedDomain = deriveSelectionDomain(live)
  if (selectionDomain !== expectedDomain) {
    patches.selectionDomain = expectedDomain
  }

  return Object.keys(patches).length > 0 ? patches : null
}

export interface SketchEditorInvariantState extends SelectionInvariantState {
  activeTool: string | null
  dimensionPicks: unknown[]
  activePickField: { featureId: string; field: string } | null
  drawPoints: unknown[]
  drawHover: unknown
  pendingDialog: unknown
  modeStack: readonly string[]
}

export function validateSketchEditorState(state: SketchEditorInvariantState): void {
  // Selection invariants
  validateSelectionState(state)

  // Tool invariants
  if (state.dimensionPicks.length > 0 && state.activeTool !== 'dimension') {
    failLoud(
      `[invariant] dimensionPicks has ${state.dimensionPicks.length} entries `
      + `but activeTool is '${state.activeTool}', expected 'dimension'`,
    )
  }

  if (state.activePickField !== null && state.activeTool !== null) {
    failLoud(
      `[invariant] activePickField set ('${state.activePickField.featureId}:${state.activePickField.field}') `
      + `but activeTool is '${state.activeTool}', expected null`,
    )
  }

  const isDrawingTool = state.activeTool ? (DRAWING_TOOLS as Set<string>).has(state.activeTool) : false

  if (state.drawPoints.length > 0 && !isDrawingTool) {
    failLoud(
      `[invariant] drawPoints has ${state.drawPoints.length} entries `
      + `but activeTool is '${state.activeTool}', not a drawing tool`,
    )
  }

  if (state.drawHover !== null && !isDrawingTool) {
    failLoud(
      `[invariant] drawHover is set but activeTool is '${state.activeTool}', not a drawing tool`,
    )
  }

  // Mode stack coupling. The top entry names the mode the tool/pick fields
  // describe, so whoever is armed owns the top and a disarmed editor owns
  // nothing. Without this an unpaired activation leaks its entry, which
  // permanently disables popMode's stack-empty validation hook.
  const top = state.modeStack.length > 0 ? state.modeStack[state.modeStack.length - 1] : null

  if (state.activeTool !== null && top !== `tool:${state.activeTool}`) {
    failLoud(
      `[invariant] activeTool is '${state.activeTool}' but modeStack top is '${top}', `
      + `expected 'tool:${state.activeTool}'`,
    )
  }

  if (state.activePickField !== null && top !== 'pick') {
    failLoud(
      `[invariant] activePickField set ('${state.activePickField.featureId}:${state.activePickField.field}') `
      + `but modeStack top is '${top}', expected 'pick'`,
    )
  }

  if (state.activeTool === null && state.activePickField === null && state.modeStack.length > 0) {
    failLoud(
      `[invariant] modeStack is [${state.modeStack.join(', ')}] but no tool or pick field is active`,
    )
  }
}
