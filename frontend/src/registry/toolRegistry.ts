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
  | 'rectangle'
  | 'center_rectangle'
  | 'project'
  | 'drag'
  | 'constraint'
  | 'mirror'
  | 'offset'

export type ToolCategory = 'navigation' | 'drawing' | 'constraint' | 'selection' | 'dimension' | 'drag'

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
  readonly showInToolbar?: boolean

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

interface ToolHandlerRef {
  toolId: ToolId
  eventType: string
}

// Central registry - single source of truth
export class ToolRegistry {
  private tools = new Map<ToolId, Tool>()
  private registeredHandlers = new Map<string, ToolHandlerRef>()

  get(id: ToolId): Tool | null {
    return this.tools.get(id) ?? null
  }

  register(tool: Tool): void {
    if (this.tools.has(tool.id)) {
      throw new Error(`Tool with id ${tool.id} already registered`)
    }
    this.tools.set(tool.id, tool)
    this.registerToolHandlers(tool)
  }

  private registerToolHandlers(tool: Tool): void {
    const handlers = tool.handlers
    
    if ('onPointerDown' in handlers && handlers.onPointerDown) {
      this.registeredHandlers.set(`${tool.id}:onPointerDown`, {
        toolId: tool.id,
        eventType: 'onPointerDown',
      })
    }
    if ('onPointerMove' in handlers && handlers.onPointerMove != null) {
      this.registeredHandlers.set(`${tool.id}:onPointerMove`, {
        toolId: tool.id,
        eventType: 'onPointerMove',
      })
    }
    if ('onPointerUp' in handlers && handlers.onPointerUp) {
      this.registeredHandlers.set(`${tool.id}:onPointerUp`, {
        toolId: tool.id,
        eventType: 'onPointerUp',
      })
    }
    if ('onPointerOver' in handlers && handlers.onPointerOver != null) {
      this.registeredHandlers.set(`${tool.id}:onPointerOver`, {
        toolId: tool.id,
        eventType: 'onPointerOver',
      })
    }
    if ('onPointerOut' in handlers && handlers.onPointerOut != null) {
      this.registeredHandlers.set(`${tool.id}:onPointerOut`, {
        toolId: tool.id,
        eventType: 'onPointerOut',
      })
    }
    if ('onClick' in handlers && handlers.onClick != null) {
      this.registeredHandlers.set(`${tool.id}:onClick`, {
        toolId: tool.id,
        eventType: 'onClick',
      })
    }
  }

  byCategory(category: ToolCategory): Tool[] {
    return Array.from(this.tools.values()).filter(t => t.category === category)
  }

  getToolbarTools(): Tool[] {
    return Array.from(this.tools.values()).filter(t => t.showInToolbar)
  }

  getRegisteredHandlerCount(): number {
    return this.registeredHandlers.size
  }

  validate(): void {
    const hasSelectionTool = this.tools.has('select')
    const hasDrawingTools = this.byCategory('drawing').length > 0
    const hasDimensionTool = this.tools.has('dimension')
    const hasDragTool = this.tools.has('drag')
    const hasClickHandler = this.registeredHandlers.has('select:onClick')
    
    if (!hasSelectionTool) {
      throw new Error('No selection tool registered')
    }
    if (!hasDrawingTools) {
      throw new Error('No drawing tools registered')
    }
    if (!hasDimensionTool) {
      throw new Error('Dimension tool not registered')
    }
    if (!hasDragTool) {
      throw new Error('Drag tool not registered')
    }
    if (!hasClickHandler) {
      throw new Error('Selection tool must have onClick handler')
    }
  }
}

// Singleton registry instance
export const toolRegistry = new ToolRegistry()