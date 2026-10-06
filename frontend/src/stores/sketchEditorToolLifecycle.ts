// Tool lifecycle glue: snapshotting the store into a ToolContext and running a
// registered tool's activate/deactivate hooks. Kept beside the store so the
// tool registry wiring is testable on its own, but it owns no state.
import type { ActiveTool } from '@/types/cad'
import { toolRegistry } from '@/registry/toolRegistry'
import type { ToolContext } from '@/registry/toolRegistry'
import { failLoud } from './stateInvariants'
import { sketchCallbacks } from './sketchEditorCallbacks'
import type { SketchEditorState } from './sketchEditorTypes'

// Snapshot the current state into the ToolContext a tool lifecycle hook expects.
// pushMode/popMode close over get() so they always reach the live store.
function buildToolContext(get: () => SketchEditorState): ToolContext {
  const s = get()
  return {
    normalSelection: s.normalSelection,
    hoveredSelectionId: s.hoveredSelectionId,
    isPointerDown: s.isPointerDown,
    activeFeatureId: s.activeFeatureId,
    hoveredVertexId: s.hoveredVertexId,
    hoveredVertexPosition: s.hoveredVertexPosition,
    hoveredSnapKind: s.hoveredSnapKind,
    onMutation: sketchCallbacks.onMutation,
    onMutationBatch: sketchCallbacks.onMutationBatch,
    pushMode: (kind: string) => get().pushMode(kind),
    popMode: (expectedKind?: string) => get().popMode(expectedKind),
  }
}

// Fire a tool's activate hook if the tool is registered. Callers own the guard
// deciding whether the hook should run at all; the tool field itself is written
// by the caller's own set(). An id with no registered tool (a union member that
// was never wired) is a bug, not a no-op, so it fails loud.
export function activateTool(get: () => SketchEditorState, toolId: ActiveTool): void {
  if (!toolId) return
  const tool = toolRegistry.get(toolId)
  if (tool === null) {
    failLoud(`[sketchEditorStore] activateTool('${toolId}'): no registered tool`)
    return
  }
  tool.activate(buildToolContext(get))
}

// Disarms the tool completely before running its hook: the field, plus the
// transient state that only exists while a tool is armed. The hook pops the
// tool's mode entry and popMode revalidates the whole store the moment the
// stack empties, so it must not observe a half-disarmed editor (an activeTool
// whose entry is already gone, or draw/dimension leftovers with no tool).
// Callers that arm a new tool re-apply these resets anyway. An unregistered id
// fails loud: the field is already cleared above, so a dev warn keeps the
// editor consistent while flagging the leak.
export function deactivateTool(
  get: () => SketchEditorState,
  set: (p: Partial<SketchEditorState>) => void,
  toolId: ActiveTool,
): void {
  if (!toolId) return
  set({
    activeTool: null,
    drawPoints: [],
    drawHover: null,
    drawSnapRefs: [],
    dimensionPicks: [],
    dimensionCursorWorld: null,
  })
  const tool = toolRegistry.get(toolId)
  if (tool === null) {
    failLoud(`[sketchEditorStore] deactivateTool('${toolId}'): no registered tool`)
    return
  }
  tool.deactivate(buildToolContext(get))
}
