import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { useCommandRegistration } from '../useCommandRegistration'
import { clearAllHandlers, executeCommand } from '@/utils/core/commandRegistry'
import { CommandRegistry, noParams, type CommandSpec, type CommandContext } from '@/utils/core/commandSpec'
import { okResult } from '@/session/result'
import { COMMAND_NAMES, type CommandName } from '@/utils/core/commandNames'
import { initializeTools } from '@/tools'

// The hook is the only place the page spec tables reach a registry, so these
// tests pin the registration lifecycle, the re-register-on-new-registry path,
// the shared window keydown listener and the development-only length guard.
//
// The length guard is gated on `import.meta.env.DEV`, which vitest leaves true,
// so it runs here without any stubbing. Its StrictMode half is pinned through
// renderHookStrict because the app itself renders under StrictMode: the guard
// stores the length it compares against, so where that store lands decides
// whether the double-invoked mount reads as a length change.

beforeAll(() => { initializeTools() })

beforeEach(() => {
  clearAllHandlers()
})

afterEach(() => {
  clearAllHandlers()
  vi.restoreAllMocks()
})

interface FixtureContext extends CommandContext {
  editor: 'part'
  log: string[]
}

function context(): FixtureContext {
  return { editor: 'part', log: [] }
}

function spec(id: CommandName, ctx: FixtureContext, run?: () => void): CommandSpec<FixtureContext, null> {
  return {
    id,
    label: id,
    params: noParams(),
    enabled: () => true,
    undoable: false,
    run: () => {
      ctx.log.push(id)
      run?.()
      return okResult()
    },
  }
}

function specs(n: number, ctx: FixtureContext): CommandSpec<FixtureContext, null>[] {
  return Array.from({ length: n }, (_, i) => spec(COMMAND_NAMES[i], ctx))
}

// Other console.error traffic is irrelevant here; the guard is identified by its
// message so an unrelated error cannot make a length assertion pass.
const lengthErrors = (error: { mock: { calls: readonly unknown[][] } }): string[] =>
  error.mock.calls
    .map(call => String(call[0]))
    .filter(text => text.includes('specs.length changed'))

describe('useCommandRegistration', () => {
  it('registers every spec on mount and unregisters them on unmount', () => {
    const ctx = context()
    const registry = new CommandRegistry<FixtureContext>(() => ctx)
    const undo = vi.fn()
    const list = [spec('undo', ctx, undo), spec('redo', ctx)]

    const { unmount } = renderHook(() => useCommandRegistration('part', registry, list))

    act(() => { registry.execute('undo') })
    act(() => { registry.execute('redo') })
    expect(undo).toHaveBeenCalledTimes(1)
    expect(ctx.log).toEqual(['undo', 'redo'])

    unmount()

    expect(registry.execute('undo')).toEqual({ ok: false, code: 'unknown-command', message: 'unknown command "undo"' })
  })

  it('re-registers the specs when the registry identity changes across renders', () => {
    const first = context()
    const second = context()
    const firstRegistry = new CommandRegistry<FixtureContext>(() => first)
    const secondRegistry = new CommandRegistry<FixtureContext>(() => second)

    const { rerender } = renderHook(
      ({ registry, s }: { registry: CommandRegistry<FixtureContext>; s: CommandSpec<FixtureContext, null> }) =>
        useCommandRegistration('part', registry, [s]),
      { initialProps: { registry: firstRegistry, s: spec('undo', first) } },
    )

    rerender({ registry: secondRegistry, s: spec('undo', second) })

    expect(secondRegistry.execute('undo').ok).toBe(true)
    expect(second.log).toEqual(['undo'])
    expect(first.log).toEqual([])
  })

  it('routes a mapped window keydown to the registered spec', () => {
    const ctx = context()
    const registry = new CommandRegistry<FixtureContext>(() => ctx)
    renderHook(() => useCommandRegistration('part', registry, [spec('undo', ctx)]))

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true }))
    })

    expect(ctx.log).toEqual(['undo'])
  })

  // addEventListener dedups on (type, callback, capture), so two mounts that
  // attach the SAME module-level function hold ONE DOM entry between them and
  // the first unmount's removeEventListener drops it for the sibling that is
  // still mounted: the keyboard goes dead with no warning. Each registration
  // therefore attaches its own closure, so add and remove pair per instance.
  it('keeps the co-mounted sibling dispatching after the first registration unmounts', () => {
    const first = context()
    const second = context()
    const firstRegistry = new CommandRegistry<FixtureContext>(() => first)
    const secondRegistry = new CommandRegistry<FixtureContext>(() => second)
    const firstMount = renderHook(() => useCommandRegistration('part', firstRegistry, [spec('undo', first)]))
    renderHook(() => useCommandRegistration('part', secondRegistry, [spec('undo', second)]))

    firstMount.unmount()

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true }))
    })

    // The survivor's own listener is still attached and its registry is still
    // the installed slot: the shared-entry unmount must not have taken the
    // keyboard with it.
    expect(second.log).toEqual(['undo'])
    expect(first.log).toEqual([])
  })

  // Two co-mounted registrations both forward their keydown to the one
  // dispatcher. A command run owns the event by preventDefault, so one press
  // must run that handler once; without the once-per-event guard the first call
  // executes the command and the second replays it, which is two changes from
  // one key.
  it('runs a keydown command once with two registrations still mounted', () => {
    const first = context()
    const second = context()
    const firstRegistry = new CommandRegistry<FixtureContext>(() => first)
    const secondRegistry = new CommandRegistry<FixtureContext>(() => second)
    renderHook(() => useCommandRegistration('part', firstRegistry, [spec('undo', first)]))
    renderHook(() => useCommandRegistration('part', secondRegistry, [spec('undo', second)]))

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true }))
    })

    // `second` is the installed registry (last write wins); the sibling's
    // listener must not replay it into a second undo.
    expect(second.log).toEqual(['undo'])
    expect(first.log).toEqual([])
  })

  // The same pairing under StrictMode, where the initial mount/unmount/remount
  // removes and re-adds its own listener within the same commit.
  it('survives the StrictMode co-mount when the first registration unmounts', () => {
    const first = context()
    const second = context()
    const firstRegistry = new CommandRegistry<FixtureContext>(() => first)
    const secondRegistry = new CommandRegistry<FixtureContext>(() => second)
    const firstMount = renderHookStrict(() => useCommandRegistration('part', firstRegistry, [spec('undo', first)]))
    renderHookStrict(() => useCommandRegistration('part', secondRegistry, [spec('undo', second)]))

    firstMount.unmount()

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true }))
    })

    expect(second.log).toEqual(['undo'])
  })

  it('logs a development error when the specs length changes between renders', () => {
    const ctx = context()
    const registry = new CommandRegistry<FixtureContext>(() => ctx)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { rerender } = renderHook(
      ({ n }: { n: number }) => useCommandRegistration('part', registry, specs(n, ctx)),
      { initialProps: { n: 1 } },
    )
    expect(lengthErrors(error)).toEqual([])

    rerender({ n: 2 })

    expect(lengthErrors(error)).toHaveLength(1)
    expect(lengthErrors(error)[0]).toContain('specs.length changed from 1 to 2')
  })

  it('does not report a length change for the StrictMode mount, unmount and remount cycle', () => {
    const ctx = context()
    const registry = new CommandRegistry<FixtureContext>(() => ctx)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const addEventListener = vi.spyOn(window, 'addEventListener')

    renderHookStrict(() => useCommandRegistration('part', registry, specs(2, ctx)))

    // Pin that the remount really happened, so the assertion below is not
    // vacuous: StrictMode mounts the effects, tears them down and mounts them
    // again, which attaches the keydown listener twice.
    const keydownAdds = addEventListener.mock.calls.filter(([type]) => type === 'keydown')
    expect(keydownAdds.length).toBeGreaterThanOrEqual(2)
    // The re-store is the trap: the second mount compares the length against
    // the one the first mount stored, and both are the same length.
    expect(lengthErrors(error)).toEqual([])
  })

  it('logs a development error under StrictMode when the specs length changes between renders', () => {
    const ctx = context()
    const registry = new CommandRegistry<FixtureContext>(() => ctx)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { rerender } = renderHookStrict(
      ({ n }: { n: number }) => useCommandRegistration('part', registry, specs(n, ctx)),
      { initialProps: { n: 1 } },
    )
    expect(lengthErrors(error)).toEqual([])

    rerender({ n: 2 })

    // Exactly one report: an update double-invokes the render but not the
    // effect, and the guard is now a single effect that stores on commit.
    expect(lengthErrors(error)).toHaveLength(1)
    expect(lengthErrors(error)[0]).toContain('specs.length changed from 1 to 2')
  })

  it('does not report a length change when a spec identity changes at constant length', () => {
    const ctx = context()
    const registry = new CommandRegistry<FixtureContext>(() => ctx)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = spec('undo', ctx)
    const second = spec('undo', ctx)
    const { rerender } = renderHookStrict(
      ({ s }: { s: CommandSpec<FixtureContext, null> }) => useCommandRegistration('part', registry, [s]),
      { initialProps: { s: first } },
    )

    rerender({ s: second })

    // A new spec is the legitimate re-register path, not a contract break: the
    // registration effect re-runs while the length guard stays quiet.
    expect(lengthErrors(error)).toEqual([])
    act(() => { executeCommand('undo') })
    expect(ctx.log).toEqual(['undo'])
  })
})
