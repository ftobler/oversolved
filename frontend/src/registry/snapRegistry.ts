// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.
// ─── Snap Registry — declarative configuration for snapping and constraint inference. ───
//
// Core concepts:
//   - Active element: the element being dragged (broad categories: vertex or entity)
//   - Hover target: the snap target being hovered over (determined by what's under cursor)
//   - Dynamic targets: snap targets from the dynamic selection (multiple)
//
// Snap kinds (what can be snapped to):
//   - vertex: snapping to a point handle (line start/end, circle center, point xy)
//   - midpoint: midpoint of a path (virtual point, inserted on apply)
//   - path: snapping to an entity body/curve
//   - kinda_horizontal: cursor aligned horizontally with a dynamic target
//   - kinda_vertical: cursor aligned vertically with a dynamic target

export type SnapKind = 'vertex' | 'midpoint' | 'path' | 'kinda_horizontal' | 'kinda_vertical'

// Type of element being dragged
export type DraggedElementType = 'vertex' | 'entity'

// Alignment tolerance in degrees for kinda_horizontal and kinda_vertical snap detection
export const ALIGNMENT_TOLERANCE_DEG = 15

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

export interface AlignmentSnapResult {
  kind: 'kinda_horizontal' | 'kinda_vertical'
  point: [number, number]
  vertexId: string
}

/** Detect if cursor is roughly horizontally or vertically aligned with the dynamic selection point.
 *  Uses ALIGNMENT_TOLERANCE_DEG to determine the snap zone. */
export function detectAlignmentSnap(
  dynamicSelection: Set<string>,
  cursorPos: [number, number],
  dynamicSelectionPositions: Map<string, [number, number]>,
): AlignmentSnapResult | null {
  if (dynamicSelection.size === 0 || dynamicSelectionPositions.size === 0) return null

  let refVertexId: string | null = null
  let refPoint: [number, number] | null = null

  for (const id of dynamicSelection) {
    if (id.startsWith('vertex:') && dynamicSelectionPositions.has(id)) {
      refVertexId = id
      refPoint = dynamicSelectionPositions.get(id)!
      break
    }
  }

  if (!refPoint) {
    for (const id of dynamicSelection) {
      if (id.startsWith('entity:') && dynamicSelectionPositions.has(id)) {
        refVertexId = id
        refPoint = dynamicSelectionPositions.get(id)!
        break
      }
    }
  }

  if (!refPoint) return null

  const dx = cursorPos[0] - refPoint[0]
  const dy = cursorPos[1] - refPoint[1]

  const dist = Math.hypot(dx, dy)
  if (dist < 0.001) return null

  const angleDeg = Math.atan2(dy, dx) * (180 / Math.PI)
  const normalizedAngle = ((angleDeg % 180) + 180) % 180

  if (normalizedAngle < ALIGNMENT_TOLERANCE_DEG || normalizedAngle > 180 - ALIGNMENT_TOLERANCE_DEG) {
    return { kind: 'kinda_horizontal', point: refPoint, vertexId: refVertexId! }
  }

  const verticalAngle = Math.abs(normalizedAngle - 90)
  if (verticalAngle < ALIGNMENT_TOLERANCE_DEG || verticalAngle > 180 - ALIGNMENT_TOLERANCE_DEG) {
    return { kind: 'kinda_vertical', point: refPoint, vertexId: refVertexId! }
  }

  return null
}