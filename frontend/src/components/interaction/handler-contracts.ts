// handler-contracts.ts
// Handler contract registry for drawing tools.
//
// This registry documents what each tool expects from its event handlers.
// It's metadata-only, like the CONSTRAINTS and ENTITIES registries.
//
// In a future enhancement, this could be used to automatically build
// toolbar buttons and wire up their handlers.

import type { ActiveTool } from '../../stores/sketchEditorStore'
import type { DragInit, ToolHandlerContract } from './interaction-actions'
import type { Point } from '../../types/cad'
import type { FieldPickState } from '../../components/Sidebar'

/* eslint-disable @typescript-eslint/no-unused-vars */
const _stubOnPointerDown = (
  _e: PointerEvent,
  _worldPt: Point,
  _activeTool: ActiveTool,
  _isEditing: boolean,
  _fieldPickState: FieldPickState | null,
): DragInit | null => null

const _stubOnPointerMove = (
  _e: PointerEvent,
  _worldPt: Point,
  _activeTool: ActiveTool,
  _drag: DragInit,
): void => {}

const _stubOnPointerUp = (
  _e: PointerEvent,
  _worldPt: Point,
  _drag: DragInit | null,
  setDrag: (d: DragInit | null) => void,
  setOrbitEnabled: (enabled: boolean) => void,
  _onMutation: ((m: import('../../types/cad').Mutation) => void) | null,
  _activeTool: ActiveTool,
): void => {
  setDrag(null)
  setOrbitEnabled(true)
}

const _stubOnPointerOver = (
  _e: PointerEvent,
  _activeTool: ActiveTool,
  _isDrawingTool: boolean,
  _setHovered: (val: boolean) => void,
  _setHoveredEntity: (id: string | null) => void,
): void => {}

const _stubOnPointerOut = (): void => {}
/* eslint-enable @typescript-eslint/no-unused-vars */

/**
 * Registry of drawing tool handler contracts.
 *
 * Each entry describes what handlers a tool needs.
 *
 * Currently all drawing tools share the same handler contract —
 * they all:
 * - Start dragging on pointer-down (except point tool)
 * - Use click-vs-drag threshold on pointer-up
 * - Highlight on pointer-over
 *
 * In a future enhancement, tools with special behavior (e.g.,
 * arc's 3-point drawing) would have unique contracts.
 */
export const TOOL_HANDLER_CONTRACTS: readonly ToolHandlerContract[] = [
  {
    toolKind: 'point',
    onPointerDown: _stubOnPointerDown,
    onPointerMove: _stubOnPointerMove,
    onPointerUp: _stubOnPointerUp,
    onPointerOver: _stubOnPointerOver,
    onPointerOut: _stubOnPointerOut,
  },
  {
    toolKind: 'line',
    onPointerDown: _stubOnPointerDown,
    onPointerMove: _stubOnPointerMove,
    onPointerUp: _stubOnPointerUp,
    onPointerOver: _stubOnPointerOver,
    onPointerOut: _stubOnPointerOut,
  },
  {
    toolKind: 'circle',
    onPointerDown: _stubOnPointerDown,
    onPointerMove: _stubOnPointerMove,
    onPointerUp: _stubOnPointerUp,
    onPointerOver: _stubOnPointerOver,
    onPointerOut: _stubOnPointerOut,
  },
  {
    toolKind: 'arc',
    onPointerDown: _stubOnPointerDown,
    onPointerMove: _stubOnPointerMove,
    onPointerUp: _stubOnPointerUp,
    onPointerOver: _stubOnPointerOver,
    onPointerOut: _stubOnPointerOut,
  },
  {
    toolKind: 'rect',
    onPointerDown: _stubOnPointerDown,
    onPointerMove: _stubOnPointerMove,
    onPointerUp: _stubOnPointerUp,
    onPointerOver: _stubOnPointerOver,
    onPointerOut: _stubOnPointerOut,
  },
  {
    toolKind: 'center_rect',
    onPointerDown: _stubOnPointerDown,
    onPointerMove: _stubOnPointerMove,
    onPointerUp: _stubOnPointerUp,
    onPointerOver: _stubOnPointerOver,
    onPointerOut: _stubOnPointerOut,
  },
]
