// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// Invariant validation for sketch editor store state.
// Uses the 3-tier guard pattern: throw in test, warn in dev, silent in prod.

const devOnly = import.meta.env.DEV
const testMode = import.meta.env.MODE === 'test'

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

export type DrawingToolKind = 'line' | 'rect' | 'center_rect' | 'circle' | 'arc' | 'ellipse' | 'spline' | 'point' | 'project'

export const DRAWING_TOOLS = new Set<DrawingToolKind>(['line', 'rect', 'center_rect', 'circle', 'arc', 'ellipse', 'spline', 'point', 'project'])

export interface SketchEditorInvariantState {
  activeTool: string | null
  dimensionPicks: unknown[]
  activePickField: { featureId: string; field: string } | null
  drawPoints: unknown[]
  drawHover: unknown
  pendingDialog: unknown
}

export function validateSketchEditorState(state: SketchEditorInvariantState): void {
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
}
