import type { ActivePickField } from '@/stores/sketchEditorStore'

/**
 * Whether B-rep bodies should stay interactive (faces/edges/vertices registered
 * in the ID buffer) given the current edit state.
 *
 * Bodies are normally made inert while a sketch is being edited so the sketch's
 * own surfaces win clicks. The exception is the plane-pick phase: when a sketch
 * is created its plane is picked from solid geometry, so the body faces must
 * remain pickable even though the sketch is the active feature.
 */
export function arePickBodiesInteractive(
  activeSketchFeatureId: string | null | undefined,
  activePickField: ActivePickField | null,
): boolean {
  if (!activeSketchFeatureId) return true
  return activePickField?.field === 'plane'
}
