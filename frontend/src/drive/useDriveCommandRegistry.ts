// The page's registry builder: in a dev/test build it returns a journaling
// registry wired to the module journal and the live document; in a production
// build it returns the plain registry, so neither the journal nor the bridge
// costs anything there. One hook rather than a conditional at the call site
// keeps the page's hook order unconditional.

import { useMemo } from 'react'
import { CommandRegistry, type CommandContext } from '@/utils/core/commandSpec'
import { DRIVE_ENABLED } from './gate'
import { getCommandJournal } from './journal'
import { JournalingCommandRegistry } from './journalingRegistry'
import { docHashOf } from './docHash'

export interface DriveRegistryDeps {
  // The live document; the journal hashes it around each command and snapshots
  // it when a generation starts.
  getDoc: () => unknown
}

export function useDriveCommandRegistry<Ctx extends CommandContext>(
  context: Ctx,
  deps: DriveRegistryDeps,
): CommandRegistry<Ctx> {
  return useMemo(() => {
    if (!DRIVE_ENABLED) return new CommandRegistry<Ctx>(() => context)
    const journal = getCommandJournal()
    return new JournalingCommandRegistry<Ctx>(() => context, {
      journal,
      getDoc: deps.getDoc,
      hashDoc: () => {
        const doc = deps.getDoc()
        return doc == null ? null : docHashOf(doc)
      },
    })
  }, [context, deps])
}
