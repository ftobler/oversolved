// The assembly undo funnel's pure core, shared by the editor hook and the
// headless session: the no-op guard, the fold-vs-push decision and the one
// history push. The hook keeps its session pin (a React-side ref) and calls
// this for the decision; the headless session has no open editor, so every
// edit arrives with `sessionOpen: false` and lands as a push (D11).

import type { AssemblyDoc } from '@/types/cad'
import type { History } from '@/session/History'
import type { AssemblyUndoLabel } from '@/utils/core/assemblyUndoLabels'
import { assemblyDocEquals } from '@/utils/assemblyMutations'

export type AssemblyMutationDecision = 'noop' | 'push' | 'fold'

// The undo decision the old page funnels spelled out inline: a value no-op
// leaves no step, an open editor folds the next edit into its coalescing
// session, and anything else pushes immediately. Pure so the decision can be
// unit tested without mounting the page.
export function decideAssemblyMutation(args: {
  pre: AssemblyDoc | null
  next: AssemblyDoc | null
  sessionOpen: boolean
}): AssemblyMutationDecision {
  if (!args.pre || !args.next) return 'noop'
  if (args.next === args.pre || assemblyDocEquals(args.pre, args.next)) return 'noop'
  return args.sessionOpen ? 'fold' : 'push'
}

export interface AssemblyEditOutcome {
  decision: AssemblyMutationDecision
  // The doc that becomes live. The pre-edit doc on a no-op, `next` otherwise.
  doc: AssemblyDoc | null
  // True when this call pushed the entry. A fold leaves the push to the
  // caller's session pin, so the hook can commit it on close.
  pushed: boolean
}

/**
 * Apply one edit to the history and report the doc the caller should publish.
 * The push clones through the History's own cloneDoc, exactly as the hook's
 * pushUndo did.
 */
export function applyAssemblyEdit(
  history: History<AssemblyDoc>,
  current: AssemblyDoc | null,
  label: AssemblyUndoLabel,
  next: AssemblyDoc | null,
  sessionOpen: boolean,
): AssemblyEditOutcome {
  const decision = decideAssemblyMutation({ pre: current, next, sessionOpen })
  if (decision === 'noop' || !current || !next) {
    return { decision: 'noop', doc: current, pushed: false }
  }
  if (decision === 'push') history.push(label, current)
  return { decision, doc: next, pushed: decision === 'push' }
}
