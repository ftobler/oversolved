import type { ToolContext } from '@/registry/toolRegistry'

/**
 * activate/deactivate pair shared by every tool: push/pop the `tool:<id>` entry
 * on the editor mode stack so the active tool is reflected in mode state. Spread
 * into a Tool object, e.g. `...toolModeHandlers('line')`.
 */
export function toolModeHandlers(id: string): {
  activate: (context: ToolContext) => void
  deactivate: (context: ToolContext) => void
} {
  return {
    activate: (context) => { context.pushMode('tool:' + id) },
    deactivate: (context) => { context.popMode('tool:' + id) },
  }
}
