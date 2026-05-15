export {
  CONSTRAINTS,
  CONSTRAINT_BY_KIND,
  RENDER_KIND_TO_ICON,
  TOOLBAR_CONSTRAINTS,
  CONSTRAINT_SHORTCUTS,
  DIMENSION_RULES,
  resolveSingleEntityDimension,
  resolveTwoTargetDimension,
} from '@/registry/constraintRegistry'
export type { ConstraintDef, DimensionRule } from '@/registry/constraintRegistry'

export {
  ENTITIES,
  ENTITY_BY_KIND,
  ENTITY_BY_ACTIVE_TOOL,
  ENTITY_SHORTCUTS,
  VERTEX_INDICES,
  ALL_COORD_INDICES,
  TOOLBAR_ENTITIES,
  getDefaultParams,
} from '@/registry/entityRegistry'
export type { EntityDef, VertexDef } from '@/registry/entityRegistry'

export {
  SNAP_RULES,
  SNAP_KINDS,
  canSnapTo,
  suggestConstraint,
  detectAlignmentSnap,
  ALIGNMENT_TOLERANCE_DEG,
} from '@/registry/snapRegistry'
export type { SnapKind, DraggedElementType, AlignmentSnapResult } from '@/registry/snapRegistry'

export {
  toolRegistry,
} from '@/registry/toolRegistry'
export type {
  ToolId,
  ToolCategory,
  ToolContext,
  ToolDragInit,
  ToolHandlers,
  Tool,
  DrawingTool,
  ConstraintTool,
  DimensionTool,
  SelectionTool,
  DragTool,
  ToolRegistry,
} from '@/registry/toolRegistry'
