import type { ActiveTool } from '@/types/cad'

/**
 * Per-tool allow-list of ID layers the pointer dispatcher will route from.
 *
 * Slice scope: only `dimensionLabel` is consumed by the dispatcher in
 * 267.2. Tools that should not route dimension label clicks (e.g. the
 * drawing tools that begin a stroke under the cursor) return a set that
 * omits it. `null` means "all layers" (kept for forward compatibility
 * when later slices wire more layers through the dispatcher).
 */
export function getToolAllowedLayers(tool: ActiveTool): ReadonlySet<string> | null {
  switch (tool) {
    case null:
    case 'select':
    case 'dimension':
    case 'drag':
      return null  // allow all layers, including dimensionLabel
    case 'line':
    case 'rect':
    case 'center_rect':
    case 'circle':
    case 'arc':
    case 'point':
    case 'project':
    case 'mirror':
      // Drawing tools: keep clicks on dimension labels from interrupting a
      // stroke. The dispatcher excludes dimensionLabel for these.
      return new Set<string>()
    default:
      return null
  }
}
