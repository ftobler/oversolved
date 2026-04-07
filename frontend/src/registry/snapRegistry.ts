// ====
// Snap Registry — declarative configuration for snapping and constraint inference.
//
// This registry defines:
//   1. What snap targets exist (vertex, midpoint, center, grid)
//   2. What each entity vertex can snap to
//   3. What constraint to suggest when snapping
//
// Adding a new snap type or tool:
//   1. Add snap target to SnapKind if needed
//   2. Add entry to SNAP_RULES for the entity+vertex
//   3. Update VertexDots to identify the snap kind
//   4. Everything else is automatic
// ====

export type SnapKind = 'vertex' | 'midpoint' | 'center' | 'path' | 'grid' | 'kinda_horizontal' | 'kinda_vertical'

// Alignment tolerance in degrees for kinda_horizontal and kinda_vertical snap detection
export const ALIGNMENT_TOLERANCE_DEG = 15

export interface SnapRule {
  snapKinds: SnapKind[]
  suggest: string
  autoApply?: boolean
}

export type SnapRules = Record<string, SnapRulesEntity>

export type SnapRulesEntity = Record<string, SnapRule>

export const SNAP_KINDS: readonly SnapKind[] = ['vertex', 'midpoint', 'center', 'path', 'grid', 'kinda_horizontal', 'kinda_vertical']

export const SNAP_RULES: SnapRules = {
  line: {
    start: { snapKinds: ['vertex', 'midpoint', 'center', 'path', 'grid', 'kinda_horizontal', 'kinda_vertical'], suggest: 'coincident' },
    end:   { snapKinds: ['vertex', 'midpoint', 'center', 'path', 'grid', 'kinda_horizontal', 'kinda_vertical'], suggest: 'coincident' },
  },
  circle: {
    center: { snapKinds: ['vertex', 'center', 'grid', 'kinda_horizontal', 'kinda_vertical'], suggest: 'concentric' },
  },
  arc: {
    start:  { snapKinds: ['vertex', 'midpoint', 'center', 'path', 'kinda_horizontal', 'kinda_vertical'], suggest: 'coincident' },
    end:    { snapKinds: ['vertex', 'midpoint', 'center', 'path', 'kinda_horizontal', 'kinda_vertical'], suggest: 'coincident' },
    center: { snapKinds: ['vertex', 'center', 'kinda_horizontal', 'kinda_vertical'], suggest: 'concentric' },
  },
  point: {
    xy: { snapKinds: ['vertex', 'midpoint', 'center', 'path', 'grid', 'kinda_horizontal', 'kinda_vertical'], suggest: 'coincident' },
  },
}

export function getSnapRule(entityKind: string, vertexKey: string): SnapRule | undefined {
  return SNAP_RULES[entityKind]?.[vertexKey]
}

export function canSnapTo(snapRule: SnapRule, snapKind: SnapKind): boolean {
  return snapRule.snapKinds.includes(snapKind)
}

export function suggestConstraint(entityKind: string, vertexKey: string, snapKind: SnapKind): string | null {
  const rule = getSnapRule(entityKind, vertexKey)
  if (!rule || !canSnapTo(rule, snapKind)) return null

  // Handle alignment snap kinds specially
  if (snapKind === 'kinda_horizontal') return 'horizontal'
  if (snapKind === 'kinda_vertical') return 'vertical'

  return rule.suggest
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
  dynamicSelectionPositions: Map<string, [number, number]>,  // vertexId -> position
): AlignmentSnapResult | null {
  if (dynamicSelection.size === 0 || dynamicSelectionPositions.size === 0) return null

  // Find the first vertex in dynamic selection that has a position
  let refVertexId: string | null = null
  let refPoint: [number, number] | null = null

  for (const id of dynamicSelection) {
    if (id.startsWith('vertex:') && dynamicSelectionPositions.has(id)) {
      refVertexId = id
      refPoint = dynamicSelectionPositions.get(id)!
      break
    }
  }

  // Fall back to entity position (center of entity)
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

  // Need meaningful distance to calculate angle
  const dist = Math.hypot(dx, dy)
  if (dist < 0.001) return null

  // Calculate angle in degrees from reference to cursor
  const angleDeg = Math.atan2(dy, dx) * (180 / Math.PI)

  // Normalize to [0, 180)
  const normalizedAngle = ((angleDeg % 180) + 180) % 180

  // Check horizontal alignment (angle near 0 or 180)
  if (normalizedAngle < ALIGNMENT_TOLERANCE_DEG || normalizedAngle > 180 - ALIGNMENT_TOLERANCE_DEG) {
    return { kind: 'kinda_horizontal', point: refPoint, vertexId: refVertexId! }
  }

  // Check vertical alignment (angle near 90 or 270)
  const verticalAngle = Math.abs(normalizedAngle - 90)
  if (verticalAngle < ALIGNMENT_TOLERANCE_DEG || verticalAngle > 180 - ALIGNMENT_TOLERANCE_DEG) {
    return { kind: 'kinda_vertical', point: refPoint, vertexId: refVertexId! }
  }

  return null
}
