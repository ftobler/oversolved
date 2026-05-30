import { useSketchEditorStore, type ActivePickField } from '@/stores/sketchEditorStore'

/**
 * Whether B-rep bodies should stay interactive (faces/edges/vertices registered
 * in the ID buffer) given the current edit state.
 *
 * Bodies are normally made inert while a sketch is being edited so the sketch's
 * own surfaces win clicks. Exceptions:
 * - Plane-pick phase: sketch plane is picked from solid geometry.
 * - Project tool: user projects 3D body geometry onto the active sketch plane.
 * - Mirror tool: user picks a mirror line from sketch geometry (body stays inert).
 */
export function arePickBodiesInteractive(
  activeSketchFeatureId: string | null | undefined,
  activePickField: ActivePickField | null,
): boolean {
  if (!activeSketchFeatureId) return true
  if (activePickField?.field === 'plane') return true
  const tool = useSketchEditorStore.getState().activeTool
  if (tool === 'project') return true
  return false
}
