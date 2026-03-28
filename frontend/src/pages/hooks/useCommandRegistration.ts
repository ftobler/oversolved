// Hook that registers a stable list of named commands on mount and cleans them
// up on unmount. Also attaches/detaches the global keydown → dispatchKey
// listener in the same effect, so both always change together.
//
// Dependency array: we spread the individual handler functions so React only
// re-runs the effect when a handler identity changes (i.e. when the caller
// passes a new function reference). Callers must wrap handlers in useCallback
// to keep them stable. The commands array identity itself is not used as a
// dependency to avoid spurious re-registrations when the array is recreated
// on every render.
//
// The eslint-disable on the dependency array below is intentional: the
// dynamic spread is the correct way to express "re-run when any fn changes"
// without requiring a static dependency list.

import { useEffect } from 'react'
import { registerCommand, unregisterCommand, dispatchKey } from '../../stores/commandRegistry'

export interface CommandEntry {
  name: string
  fn: () => void
}

export function useCommandRegistration(commands: CommandEntry[]): void {
  useEffect(() => {
    for (const { name, fn } of commands) registerCommand(name, fn)
    window.addEventListener('keydown', dispatchKey)
    return () => {
      window.removeEventListener('keydown', dispatchKey)
      for (const { name } of commands) unregisterCommand(name)
    }
  // Depend on individual handler identities. The caller is responsible for
  // wrapping handlers in useCallback so this array is stable across renders.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- dynamic spread is intentional: re-run only when a handler identity changes
  }, commands.map(c => c.fn))
}
