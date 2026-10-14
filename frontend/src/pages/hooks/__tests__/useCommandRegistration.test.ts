import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { useCommandRegistration, type CommandEntry } from '../useCommandRegistration'
import { clearAllHandlers, executeCommand } from '@/utils/core/commandRegistry'
import { COMMAND_NAMES } from '@/utils/core/commandNames'

// The hook is the only place the page command tables reach the global registry,
// so these tests pin the registration lifecycle, the re-register-on-new-handler
// path, the shared window keydown listener and the development-only length
// guard. executeCommand is the public read side of the registry.
//
// The length guard is gated on `import.meta.env.DEV`, which vitest leaves true,
// so it runs here without any stubbing. Its StrictMode half is pinned through
// renderHookStrict because the app itself renders under StrictMode: the guard
// stores the length it compares against, so where that store happens decides
// whether the double-invoked mount reads as a length change.

beforeEach(() => {
  clearAllHandlers()
})

afterEach(() => {
  clearAllHandlers()
  vi.restoreAllMocks()
})

const commands = (n: number): CommandEntry[] =>
  Array.from({ length: n }, (_, i) => ({ name: COMMAND_NAMES[i], fn: vi.fn() }))

// Other console.error traffic is irrelevant here; the guard is identified by its
// message so an unrelated error cannot make a length assertion pass.
const lengthErrors = (error: { mock: { calls: readonly unknown[][] } }): string[] =>
  error.mock.calls
    .map(call => String(call[0]))
    .filter(text => text.includes('commands.length changed'))

describe('useCommandRegistration', () => {
  it('registers every command on mount and unregisters them on unmount', () => {
    const undo = vi.fn()
    const redo = vi.fn()
    const cmds: CommandEntry[] = [{ name: 'undo', fn: undo }, { name: 'redo', fn: redo }]

    const { unmount } = renderHook(() => useCommandRegistration(cmds))

    act(() => executeCommand('undo', 1))
    act(() => executeCommand('redo'))
    expect(undo).toHaveBeenCalledWith(1)
    expect(redo).toHaveBeenCalledTimes(1)

    unmount()

    // After unmount the registry must not answer for either name; the dev-mode
    // warning is the observable side of "no handler".
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    act(() => executeCommand('undo'))
    expect(undo).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
  })

  it('re-registers a command when its handler identity changes across renders', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = renderHook(
      ({ fn }) => useCommandRegistration([{ name: 'undo', fn }]),
      { initialProps: { fn: first as () => void } },
    )

    rerender({ fn: second })

    act(() => executeCommand('undo'))
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it('routes a mapped window keydown to the registered handler', () => {
    const undo = vi.fn()
    renderHook(() => useCommandRegistration([{ name: 'undo', fn: undo }]))

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true }))
    })

    expect(undo).toHaveBeenCalledTimes(1)
  })

  // addEventListener dedups on (type, callback, capture), so two mounts that
  // attach the SAME module-level function hold ONE DOM entry between them and
  // the first unmount's removeEventListener drops it for the sibling that is
  // still mounted: the keyboard goes dead with no warning. Each registration
  // therefore attaches its own closure, so add and remove pair per instance.
  it('keeps the co-mounted sibling dispatching after the first registration unmounts', () => {
    const first = vi.fn()
    const second = vi.fn()
    const firstMount = renderHook(() => useCommandRegistration([{ name: 'undo', fn: first }]))
    renderHook(() => useCommandRegistration([{ name: 'undo', fn: second }]))

    firstMount.unmount()

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true }))
    })

    // The survivor's own listener is still attached: the shared-entry unmount
    // must not have taken the keyboard with it.
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  // Two co-mounted registrations both forward their keydown to the one dispatcher
  // and both resolve the same last-writer-wins handler. A command run owns the
  // event by preventDefault, so one press must run that handler once; without the
  // once-per-event guard the first call executes the command and the second
  // replays it, which is two changes from one key.
  it('runs a keydown command once with two registrations still mounted', () => {
    const first = vi.fn()
    const second = vi.fn()
    renderHook(() => useCommandRegistration([{ name: 'undo', fn: first }]))
    renderHook(() => useCommandRegistration([{ name: 'undo', fn: second }]))

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true }))
    })

    // `second` is the live handler (last write wins); the sibling's listener must
    // not replay it into a second undo.
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  // The same pairing under StrictMode, where the initial mount/unmount/remount
  // removes and re-adds its own listener within the same commit.
  it('survives the StrictMode co-mount when the first registration unmounts', () => {
    const first = vi.fn()
    const second = vi.fn()
    const firstMount = renderHookStrict(() => useCommandRegistration([{ name: 'undo', fn: first }]))
    renderHookStrict(() => useCommandRegistration([{ name: 'undo', fn: second }]))

    firstMount.unmount()

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true }))
    })

    expect(second).toHaveBeenCalledTimes(1)
  })

  it('logs a development error when the commands length changes between renders', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { rerender } = renderHook(
      ({ n }: { n: number }) => useCommandRegistration(commands(n)),
      { initialProps: { n: 1 } },
    )
    expect(lengthErrors(error)).toEqual([])

    rerender({ n: 2 })

    expect(lengthErrors(error)).toHaveLength(1)
    expect(lengthErrors(error)[0]).toContain('commands.length changed from 1 to 2')
  })

  it('does not report a length change for the StrictMode mount, unmount and remount cycle', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const addEventListener = vi.spyOn(window, 'addEventListener')

    renderHookStrict(() => useCommandRegistration(commands(2)))

    // Pin that the remount really happened, so the assertion below is not
    // vacuous: StrictMode mounts the effects, tears them down and mounts them
    // again, which attaches the keydown listener twice.
    const keydownAdds = addEventListener.mock.calls.filter(([type]) => type === 'keydown')
    expect(keydownAdds.length).toBeGreaterThanOrEqual(2)
    // The re-store is the trap: the second mount compares the length against
    // the one the first mount stored, and both are the same length.
    expect(lengthErrors(error)).toEqual([])
  })

  it('logs a development error under StrictMode when the commands length changes between renders', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { rerender } = renderHookStrict(
      ({ n }: { n: number }) => useCommandRegistration(commands(n)),
      { initialProps: { n: 1 } },
    )
    expect(lengthErrors(error)).toEqual([])

    rerender({ n: 2 })

    // Exactly one report: an update double-invokes the render but not the
    // effect, and the guard is now a single effect that stores on commit.
    expect(lengthErrors(error)).toHaveLength(1)
    expect(lengthErrors(error)[0]).toContain('commands.length changed from 1 to 2')
  })

  it('does not report a length change when a handler identity changes at constant length', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = renderHookStrict(
      ({ fn }: { fn: () => void }) => useCommandRegistration([{ name: 'undo', fn }]),
      { initialProps: { fn: first as () => void } },
    )

    rerender({ fn: second })

    // A new handler is the legitimate re-register path, not a contract break:
    // the registration effect re-runs while the length guard stays quiet.
    expect(lengthErrors(error)).toEqual([])
    act(() => executeCommand('undo'))
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })
})
