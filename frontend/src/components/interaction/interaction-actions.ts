// interaction-actions.ts
// Type definitions for interaction handlers.
// These interfaces describe what each handler needs to do.
// No implementations here — implementations live in the components that use them.

import type { Point } from '../../types/cad'
import type { ActiveTool } from '../../stores/sketchEditorStore'

/**
 * Drag initiation state — captured when user presses on an entity/vertex.
 * Used to distinguish clicks from drags via pixel-distance threshold.
 */
export interface DragInit {
  type: 'vertex' | 'edge' | 'dim_label'
  vertexId: string      // composite ID like "vertex:S1:L1:start"
  featureId: string     // feature ID containing this entity/vertex
  entityId: string      // entity ID in sketch (e.g., "L1")
  vertexKey?: string    // for vertex drags: "start" | "end" | "center" | "xy"
  startWorld: Point     // world coordinates at pointer-down
  startClient: [number, number] // screen pixel coordinates at pointer-down
}

/**
 * Interaction handlers interface.
 * Describes the signature of click/drag event handlers.
 */
export interface InteractionHandlers {
  onPointerDown: (e: PointerEvent, worldPt: Point) => void
  onPointerMove: (e: PointerEvent, worldPt: Point) => void
  onClick: (e: PointerEvent) => void
  onPointerOut: () => void
}

/**
 * Tool-level handlers for dragging.
 * These handle pointer events for the entire entity/vertex group.
 */
export interface ToolDragHandlers {
  onPointerDown: (e: PointerEvent, worldPt: Point) => DragInit | null
  onPointerMove?: (e: PointerEvent, worldPt: Point, drag: DragInit) => void
  onPointerUp?: (e: PointerEvent, worldPt: Point, drag: DragInit) => void
}

/**
 * Handler contract for a drawing tool.
 * Documents what each tool needs to handle pointer events.
 * Used for metadata/documentation, similar to CONSTRAINTS registry.
 */
export interface ToolHandlerContract {
  toolKind: ActiveTool
  /** Called when pointer presses on entity group. Returns null if not this tool's drag. */
  onPointerDown: (
    e: PointerEvent,
    worldPt: Point,
    activeTool: ActiveTool,
    isEditing: boolean,
  ) => DragInit | null
  /** Called while dragging (optional for some tools) */
  onPointerMove?: (
    e: PointerEvent,
    worldPt: Point,
    activeTool: ActiveTool,
    drag: DragInit,
  ) => void
  /** Called when pointer releases. Handles click-vs-drag threshold. */
  onPointerUp: (
    e: PointerEvent,
    worldPt: Point,
    drag: DragInit | null,
    setDrag: (d: DragInit | null) => void,
    setOrbitEnabled: (enabled: boolean) => void,
    onMutation: ((m: import('../../types/cad').Mutation) => void) | null,
    activeTool: ActiveTool,
  ) => void
  /** Called when pointer leaves the entity group */
  onPointerOver: (
    e: PointerEvent,
    activeTool: ActiveTool,
    isDrawingTool: boolean,
    setHovered: (val: boolean) => void,
    setHoveredEntity: (id: string | null) => void,
  ) => void
  onPointerOut: () => void
}
