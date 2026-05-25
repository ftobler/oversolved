// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.
// ─── Snap Registry — declarative configuration for snapping and constraint inference. ───
//
// Core concepts:
//   - Active element: the element being dragged (broad categories: vertex or entity)
//   - Hover target: the snap target being hovered over (determined by what's under cursor)
//
// Snap kinds (what can be snapped to):
//   - vertex: snapping to a point handle (line start/end, circle center, point xy)
//   - midpoint: midpoint of a path (virtual point, inserted on apply)
//   - path: snapping to an entity body/curve
//   - kinda_horizontal: cursor aligned horizontally with a reference point
//   - kinda_vertical: cursor aligned vertically with a reference point

export type SnapKind = 'vertex' | 'midpoint' | 'path' | 'kinda_horizontal' | 'kinda_vertical'

// Type of element being dragged
export type DraggedElementType = 'vertex' | 'entity'

// Alignment tolerance for kinda_horizontal and kinda_vertical snap detection.
// Both conditions must be satisfied: angle within DEG and normal distance within DIST.
// ALIGNMENT_TOLERANCE_DIST is in screen pixels; callers must scale by p2w(camera) before comparing to world coords.
export const ALIGNMENT_TOLERANCE_DEG = 10
export const ALIGNMENT_TOLERANCE_DIST = 20  // screen pixels

// What snap kinds each dragged element type can snap to
export const SNAP_RULES: Record<DraggedElementType, SnapKind[]> = {
  vertex: ['vertex', 'midpoint', 'path', 'kinda_horizontal', 'kinda_vertical'],
  entity: ['path', 'kinda_horizontal', 'kinda_vertical'],
}

export const SNAP_KINDS: readonly SnapKind[] = ['vertex', 'midpoint', 'path', 'kinda_horizontal', 'kinda_vertical']

export function canSnapTo(draggedType: DraggedElementType, snapKind: SnapKind): boolean {
  return SNAP_RULES[draggedType].includes(snapKind)
}

export function suggestConstraint(draggedType: DraggedElementType, snapKind: SnapKind): string | null {
  if (!canSnapTo(draggedType, snapKind)) return null

  // Handle alignment snap kinds specially
  if (snapKind === 'kinda_horizontal') return 'horizontal'
  if (snapKind === 'kinda_vertical') return 'vertical'

  // Path snap always uses coincident (point-on-entity)
  if (snapKind === 'path') return 'coincident'

  // Vertex and midpoint snap use coincident
  return 'coincident'
}