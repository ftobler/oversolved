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
 * That check runs in an effect, not in the render body. Comparing the length
 * means storing the previous one, and a ref write during render is impure: a
 * render React never commits (a suspended or abandoned concurrent render, a
 * StrictMode double-invoke that is later thrown away) would still advance the
 * stored length, so the next committed render would compare against a length
 * that was never real and report a change that never happened. From an effect
 * the stored length is always the last committed one. StrictMode's initial
 * mount/unmount/remount re-stores the same length instead of tripping over
 * itself, and the guard is declared ahead of the registration effect so the
 * warning still precedes the re-registration it is warning about.
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
import { registerCommand, dispatchKey } from '@/utils/core/commandRegistry'
import type { CommandName } from '@/utils/core/commandNames'

export interface CommandEntry {
  name: CommandName
  fn: (payload?: unknown) => void
}

export function useCommandRegistration(commands: CommandEntry[]): void {
  const prevLengthRef = useRef<number | null>(null)
  // No dep array on purpose: the guard has to see every commit, not only the
  // commits the registration effect cares about. `import.meta.env.DEV` is a
  // build-time constant, so the body is dropped from a production bundle.
  useEffect(() => {
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
  })
  useEffect(() => {
    const unregisters = commands.map(({ name, fn }) => registerCommand(name, fn))
    // A per-mount closure, never the module-level dispatchKey itself:
    // addEventListener dedups on (type, callback, capture), so two mounted
    // registrations sharing the one function hold a SINGLE DOM entry between
    // them, and the first unmount's removeEventListener drops it for the sibling
    // that is still mounted. The keyboard then goes dead with no warning, and
    // a co-mounted editor pair is exactly the shape that gets there. A fresh
    // function per effect run makes add and remove pair per instance, so one
    // unmount can only ever remove its own listener.
    const onKeyDown = (e: KeyboardEvent) => { dispatchKey(e) }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      for (const unregister of unregisters) unregister()
    }
  // Depend on individual handler identities. The caller is responsible for
  // wrapping handlers in useCallback so this array is stable across renders.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- dynamic spread is intentional: re-run only when a handler identity changes
  }, commands.map(c => c.fn))
}
