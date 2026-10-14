/**
 * Installs one editor's command registry for dispatch and registers its spec
 * list on mount; unregisters on unmount. Also attaches the global keydown →
 * dispatchKey listener in the same effect.
 *
 * **Contract:** `specs` must have a stable length across renders. Pass a
 * module-level exported list. If the registry identity changes (the page
 * rebuilt its context, e.g. after a document load), the effect re-runs and all
 * specs are re-registered on the new instance.
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
 */

import { useEffect, useRef } from 'react'
import {
  clearEditorCommandRegistry,
  dispatchKey,
  setEditorCommandRegistry,
  type EditorKind,
} from '@/utils/core/commandRegistry'
import type { CommandContext, CommandRegistry, ErasedCommandSpec } from '@/utils/core/commandSpec'

export function useCommandRegistration<Ctx extends CommandContext>(
  kind: EditorKind,
  registry: CommandRegistry<Ctx>,
  specs: readonly ErasedCommandSpec<Ctx>[],
): void {
  const prevLengthRef = useRef<number | null>(null)
  // No dep array on purpose: the guard has to see every commit, not only the
  // commits the registration effect cares about. `import.meta.env.DEV` is a
  // build-time constant, so the body is dropped from a production bundle.
  useEffect(() => {
    if (import.meta.env.DEV) {
      if (prevLengthRef.current !== null && prevLengthRef.current !== specs.length) {
        console.error(
          `useCommandRegistration: specs.length changed from ${prevLengthRef.current} ` +
          `to ${specs.length}. The specs array must have a stable length. ` +
          `Pass a module-level command table.`
        )
      }
      prevLengthRef.current = specs.length
    }
  })
  // The page's registry answers module-level executeCommand while this editor
  // is mounted. Identity-guarded on cleanup, so a remount cannot clear the
  // slot out from under its own successor.
  useEffect(() => {
    setEditorCommandRegistry(kind, registry)
    return () => { clearEditorCommandRegistry(kind, registry) }
  }, [kind, registry])
  useEffect(() => {
    const unregisters = specs.map(spec => registry.register(spec))
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
  }, [registry, specs])
}
