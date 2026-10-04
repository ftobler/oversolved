import { useSketchEditorStore } from '@/stores/sketchEditorStore'

export const originAdapter = {
  onHover(entityKey: string): void {
    const s = useSketchEditorStore.getState()
    s.setHoveredSelectionId(entityKey)
    // The document origin's position IN THIS SKETCH'S FRAME. A bare [0,0] is the
    // plane frame's own origin, a different 3D point on any offset or face-based
    // plane, and a draw click snapping to it lands off screen. Same distinction
    // partDocToSketches.ts draws for the constraint form.
    s.setHoveredVertex(entityKey, s.activeOriginLocal, 'vertex')
  },
}
