import { getLivePipeline } from './IdPipelineContext'
import type { ResolvedHit, ResolveOptions } from './IdResolver'

/**
 * Public seam consumed by selection/hover dispatch code paths.
 *
 * Given a canvas-space cursor position and the active WebGL renderer,
 * ask the live ID pipeline what entity sits under the cursor. Returns
 * null when:
 *   - no pipeline is mounted (e.g. tests, or before <IdPickingDriver>
 *     finishes its first useEffect),
 *   - the cursor falls outside the canvas,
 *   - the cursor sample window is empty.
 *
 * Slice scope: face hits only (the only layer this plan installs).
 * Callers that want a face-only filter can pass
 * `{ allowedLayers: new Set(['face']) }`; the default lets future layers
 * (edges, vertices, sketches) flow through once they exist.
 *
 * Wiring this into B-rep mesh click/hover handlers is intentionally
 * deferred to retire-raycaster-selection.md (#267), where it can be
 * done once across face/edge/vertex/sketch in a single migration. This
 * function is the seam that migration will consume.
 */
export function resolveFacePick(
  renderer: import('three').WebGLRenderer,
  cursorPx: { x: number; y: number },
  opts?: ResolveOptions,
): ResolvedHit | null {
  const pipeline = getLivePipeline()
  if (!pipeline) return null
  return pipeline.resolveSync(renderer, cursorPx, opts)
}
