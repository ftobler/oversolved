/**
 * Registers a stable list of named commands on mount and cleans them up on unmount.
 * Also attaches the global keydown → dispatchKey listener in the same effect.
 *
 * **Contract:** `commands` must have a stable length across renders.
 * Wrap the array in `useMemo` at the call site. If a handler identity changes
 * (e.g. a callback is recreated after a document load), the effect re-runs and
 * all commands are re-registered with the new handlers.
 *
 * Violating the length-stability contract logs a console.error in development.
 *
 * Dependency array: we spread the individual handler functions so React only
 * re-runs the effect when a handler identity changes (i.e. when the caller
 * passes a new function reference). Callers must wrap handlers in useCallback
 * to keep them stable. The commands array identity itself is not used as a
 * dependency to avoid spurious re-registrations when the array is recreated
 * on every render.
 *
 * The eslint-disable on the dependency array below is intentional: the
 * dynamic spread is the correct way to express "re-run when any fn changes"
 * without requiring a static dependency list.
 */

import { useEffect, useRef } from 'react'
import { registerCommand, unregisterCommand, dispatchKey } from '@/utils/core/commandRegistry'

export interface CommandEntry {
  name: string
  fn: (payload?: unknown) => void
}

export function useCommandRegistration(commands: CommandEntry[]): void {
  const prevLengthRef = useRef<number | null>(null)
  if (import.meta.env.DEV) {
    if (prevLengthRef.current !== null && prevLengthRef.current !== commands.length) {
      console.error(
        `useCommandRegistration: commands.length changed from ${prevLengthRef.current} ` +
        `to ${commands.length}. The commands array must have a stable length. ` +
        `Wrap your commands array in useMemo.`
      )
    }
    prevLengthRef.current = commands.length
  }
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
