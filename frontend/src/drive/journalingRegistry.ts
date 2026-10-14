// The registry subclass that records doc-changing commands into the journal.
// It sits at the one seam every user-driven command passes (toolbar, keymap,
// bridge and script all execute through the same registry instance), so the
// journal sees what the user did without any caller remembering to report it.
// A command that leaves the doc hash unchanged records nothing: that is what
// keeps selection changes, tool switches and UI-only commands out, and what
// keeps solver write-backs out (they are not commands at all).

import { CommandRegistry } from '@/utils/core/commandSpec'
import type { CommandResult, CommandContext } from '@/utils/core/commandSpec'
import type { CommandName } from '@/utils/core/commandNames'
import { snapshotJson, type CommandJournal } from './journal'

export interface JournalingDeps {
  journal: CommandJournal
  // The live document hash, or null when there is no document.
  hashDoc: () => string | null
  // The live document object, for the baseline snapshot.
  getDoc: () => unknown
  clock?: () => number
}

export class JournalingCommandRegistry<Ctx extends CommandContext = CommandContext> extends CommandRegistry<Ctx> {
  private readonly journaling: JournalingDeps

  constructor(contextSource: () => Ctx, deps: JournalingDeps) {
    super(contextSource)
    this.journaling = deps
  }

  override execute(id: CommandName, rawParams?: unknown): CommandResult {
    const before = this.journaling.hashDoc()
    // Snapshot the baseline BEFORE the command runs: when this command starts a
    // generation, the repro's doc must be the document the command read. The
    // copy is taken here because a mutation handler edits the live doc in
    // place; a reference would show the post-command state by record time.
    const beforeDoc = this.journaling.journal.needsBaseline()
      ? snapshotJson(this.journaling.getDoc())
      : undefined
    const result = super.execute(id, rawParams)
    const after = this.journaling.hashDoc()
    if (before !== null && after !== null && before !== after) {
      this.journaling.journal.record({
        commandId: id,
        params: rawParams ?? null,
        docHashBefore: before,
        docHashAfter: after,
        at: this.journaling.clock?.() ?? Date.now(),
      }, beforeDoc)
    }
    return result
  }
}
