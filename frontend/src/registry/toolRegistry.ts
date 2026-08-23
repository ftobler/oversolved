// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.
import type { Point, Mutation } from '@/types/cad'

// Unique identifier for each tool - no string-based magic. Select is absent on
// purpose: idle select is activeTool === null (the dispatchSketchClick
// fallback), not a registered tool. mirror/offset are forward-compat
// placeholders (no tool mode registered yet).
export type ToolId =
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

// Every activatable id that must resolve to a registered tool. mirror and
// offset stay in ActiveTool/ToolId as forward-compat placeholders with no tool
// mode (mirror shows a not-implemented toast, offset is a selection action), so
// they are deliberately absent here.
export const ACTIVATABLE_TOOL_IDS = [
  'dimension', 'line', 'rect', 'center_rect', 'circle', 'arc', 'ellipse',
  'spline', 'point', 'ngon', 'project', 'drag',
] as const satisfies readonly ToolId[]

// The id union covered by ACTIVATABLE_TOOL_IDS.
type ActivatableId = (typeof ACTIVATABLE_TOOL_IDS)[number]

// Compile-time exhaustiveness guard: ActivatableId must be exactly the
// non-placeholder ToolId members. Adding a ToolId to the union without adding it
// to ACTIVATABLE_TOOL_IDS (or vice versa) makes the two unions differ and this
// const stops type-checking, so the two lists can never drift. The tuple
// wrapping stops conditional distribution over the union, which would otherwise
// collapse the check to `boolean`. Exported so `noUnusedLocals` accepts it, but
// it is a type-level assertion, not runtime API.
type _AssertSameSet<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
export const ACTIVATABLE_TOOL_IDS_COVERAGE: _AssertSameSet<ActivatableId, Exclude<ToolId, 'mirror' | 'offset'>> = true

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
 * Every tool (drawing, dimension, drag) provides these handlers through the
 * ToolRegistry. The view layer (DragPlane, DrawPlane, dispatchSketchClick)
 * calls these handlers. See tools/ for implementations.
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

  // Ids of every registered tool, in registration order. The registry
  // cross-check test pins the registered set against the union via this.
  registeredIds(): ToolId[] {
    return Array.from(this.tools.keys())
  }

  // Ids of the registered drawing tools. Derived from the registry so the
  // draw-state invariants and the Drawing.tsx draw-plane classification can
  // never drift from what initializeTools actually registered.
  drawingIds(): Set<ToolId> {
    return new Set(
      Array.from(this.tools.values())
        .filter(t => t.category === 'drawing')
        .map(t => t.id),
    )
  }

  // Sanity check that the registry holds the canonical tools. The constraint
  // tools are deliberately absent (constraints go through `store.applyConstraint`,
  // not a registered tool) and select is the dispatchSketchClick fallback
  // (activeTool === null). Every other activatable id must be registered, or a
  // toolbar button arms a silent no-op (the historical ellipse bug).
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
    for (const id of ACTIVATABLE_TOOL_IDS) {
      if (!this.tools.has(id)) {
        throw new Error(`Tool ${id} not registered`)
      }
    }
  }
}

// Singleton registry instance
export const toolRegistry = new ToolRegistry()

// Drawing-tool id set, derived from the registry so the draw-state invariants
// and the draw-plane classification share one source of truth. Re-derived per
// call because the registry populates at initializeTools(), after module
// evaluation.
export function drawingToolIds(): Set<ToolId> {
  return new Set(Array.from(toolRegistry.drawingIds()))
}

// Whether `id` names a registered drawing tool. The single derivation for the
// draw-plane vs backplane classification in Drawing.tsx and the draw-state
// invariants.
export function isDrawingTool(id: string): boolean {
  return toolRegistry.drawingIds().has(id as ToolId)
}
