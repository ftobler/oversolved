// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.
import type { Point, Mutation } from '@/types/cad'

// Unique identifier for each tool - no string-based magic
export type ToolId =
  | 'select'
  | 'dimension'
  | 'line'
  | 'rect'
  | 'center_rect'
  | 'circle'
  | 'arc'
  | 'ellipse'
  | 'spline'
  | 'point'
  | 'ngon'
  | 'project'
  | 'drag'
  | 'mirror'
  | 'offset'

export type ToolCategory = 'drawing' | 'constraint' | 'selection' | 'dimension' | 'drag'

// What the tool system provides to each tool
export interface ToolContext {
  normalSelection: Set<string>
  hoveredSelectionId: string | null
  isPointerDown: boolean
  activeFeatureId: string | null
  hoveredVertexId: string | null
  hoveredVertexPosition: Point | null
  hoveredSnapKind: string | null
  onMutation: ((m: Mutation) => void) | null
  // One undo entry for a whole gesture's mutations (an end-snapped line, a
  // multi-face projection). Tools call this instead of onMutation per sub-mutation.
  onMutationBatch?: ((ms: Mutation[]) => void) | null
  pushMode: (kind: string) => void
  popMode: (expectedKind?: string) => void
}

// Drag initiation state
export interface ToolDragInit {
  type: 'vertex' | 'edge' | 'dim_label'
  vertexId: string
  featureId: string
  entityId: string
  vertexKey?: string
  startWorld: Point
  startClient: [number, number]
}

/**
 * Unified handlers interface, the single contract all tools must implement.
 *
 * Every tool (select, drag, dimension, drawing, constraint) provides these
 * handlers through the ToolRegistry. The view layer (DragPlane, DrawPlane,
 * dispatchSketchClick) calls these handlers. See tools/ for implementations.
 */
export interface ToolHandlers<T extends ToolContext = ToolContext> {
  onPointerDown?(e: PointerEvent, worldPt: Point, context: T): ToolDragInit | null
  onPointerMove?(e: PointerEvent, worldPt: Point, drag: ToolDragInit | null, context: T): void
  onPointerUp?(e: PointerEvent, worldPt: Point, drag: ToolDragInit | null, context: T): void
  onPointerOver?(e: PointerEvent, worldPt: Point, context: T): void
  onPointerOut?(context: T): void
  onClick?(e: PointerEvent, worldPt: Point, context: T): void
}

// Base tool interface
export interface Tool<T extends ToolContext = ToolContext> {
  readonly id: ToolId
  readonly label: string
  readonly category: ToolCategory

  activate(context: T): void
  deactivate(context: T): void

  handlers: ToolHandlers<T>
}

// Drawing tools (line, circle, arc, point, rectangle)
export interface DrawingTool extends Tool {
  readonly category: 'drawing'
  readonly entityKind: string
  readonly paramCount: number
}

// Constraint tools (horizontal, vertical, coincident, etc.)
export interface ConstraintTool extends Tool {
  readonly category: 'constraint'
  readonly constraintKind: string
  readonly requiresSelection: number
}

// Dimension tool
export interface DimensionTool extends Tool {
  readonly category: 'dimension'
}

// Selection tool
export interface SelectionTool extends Tool {
  readonly category: 'selection'
}

// Drag tool
export interface DragTool extends Tool {
  readonly category: 'drag'
}

// Central registry - single source of truth
export class ToolRegistry {
  private tools = new Map<ToolId, Tool>()

  get(id: ToolId): Tool | null {
    return this.tools.get(id) ?? null
  }

  register(tool: Tool): void {
    if (this.tools.has(tool.id)) {
      throw new Error(`Tool with id ${tool.id} already registered`)
    }
    this.tools.set(tool.id, tool)
  }

  // Wipe all registered tools so a stale populate (module re-execution under
  // HMR, a test file re-running initializeTools) never double-registers.
  reset(): void {
    this.tools.clear()
  }

  // Dev-only sanity check that the registry holds the canonical tools. The
  // select tool and constraint tools are deliberately absent: select is the
  // dispatchSketchClick fallback (`state.toggleNormalSelection`), and
  // constraints go through `store.applyConstraint`, not a registered tool.
  validate(): void {
    const tools = Array.from(this.tools.values())
    if (!tools.some(t => t.category === 'drawing')) {
      throw new Error('No drawing tools registered')
    }
    if (!tools.some(t => t.id === 'dimension')) {
      throw new Error('Dimension tool not registered')
    }
    if (!tools.some(t => t.id === 'drag')) {
      throw new Error('Drag tool not registered')
    }
  }
}

// Singleton registry instance
export const toolRegistry = new ToolRegistry()