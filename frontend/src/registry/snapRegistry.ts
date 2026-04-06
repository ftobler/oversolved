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

export type SnapKind = 'vertex' | 'midpoint' | 'center' | 'path' | 'grid'

export interface SnapRule {
  snapKinds: SnapKind[]
  suggest: string
  autoApply?: boolean
}

export type SnapRules = Record<string, SnapRulesEntity>

export type SnapRulesEntity = Record<string, SnapRule>

export const SNAP_KINDS: readonly SnapKind[] = ['vertex', 'midpoint', 'center', 'path', 'grid']

export const SNAP_RULES: SnapRules = {
  line: {
    start: { snapKinds: ['vertex', 'midpoint', 'center', 'path', 'grid'], suggest: 'coincident' },
    end:   { snapKinds: ['vertex', 'midpoint', 'center', 'path', 'grid'], suggest: 'coincident' },
  },
  circle: {
    center: { snapKinds: ['vertex', 'center', 'grid'], suggest: 'concentric' },
  },
  arc: {
    start:  { snapKinds: ['vertex', 'midpoint', 'center', 'path'], suggest: 'coincident' },
    end:    { snapKinds: ['vertex', 'midpoint', 'center', 'path'], suggest: 'coincident' },
    center: { snapKinds: ['vertex', 'center'], suggest: 'concentric' },
  },
  point: {
    xy: { snapKinds: ['vertex', 'midpoint', 'center', 'path', 'grid'], suggest: 'coincident' },
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
  return rule.suggest
}
