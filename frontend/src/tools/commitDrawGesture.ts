// The one commit path for a drawing gesture. A click (through DrawingTool) and
// a stamp-down (the store's finishDraw) build the same mutations; this keeps the
// undo batching, the buffer reset and the tool's arming policy in one place so
// the two entry points cannot drift. Mid-gesture clicks (a line-chain segment)
// apply their mutations here too; only the clearing and disarming wait for the
// completing click.
import type { Mutation } from '@/types/cad'
import type { DrawClickResult } from '@/utils/geometry/drawFinish'
import { devOnly } from '@/stores/stateInvariants'

export interface DrawCommitPorts {
  onMutation: ((m: Mutation) => void) | null | undefined
  onMutationBatch: ((ms: Mutation[]) => void) | null | undefined
  // Always runs on a completed gesture: the next entity starts clean.
  clearDraw: () => void
  // Called only when the tool's arming policy says the tool is one-shot.
  disarm: () => void
  staysArmedAfterCommit: boolean
}

/**
 * Applies a gesture's mutations, and once the gesture is complete clears the
 * buffer and applies the tool's arming policy. Returns true when the gesture
 * completed, so a caller that shares its trigger with another action (the right
 * click that would otherwise open the context menu) can stand the other action
 * down.
 */
export function commitDrawGesture(
  result: DrawClickResult,
  ports: DrawCommitPorts,
  label: string,
): boolean {
  // A chain (the line tool) emits a segment on every click but is not complete
  // until the chain closes, so the mutations land now and only the buffer reset
  // and the disarm wait for the completing click.
  if (result.mutations.length > 1) {
    if (ports.onMutationBatch) ports.onMutationBatch(result.mutations)
    else if (devOnly) console.warn(`${label}: gesture emitted ${result.mutations.length} mutations but there is no onMutationBatch port - dropping the batch.`)
  } else if (result.mutations.length === 1) {
    if (ports.onMutation) ports.onMutation(result.mutations[0])
    else if (devOnly) console.warn(`${label}: gesture emitted a mutation but there is no onMutation port - dropping it.`)
  }
  if (!result.gestureComplete) return false
  ports.clearDraw()
  if (!ports.staysArmedAfterCommit) ports.disarm()
  return true
}
