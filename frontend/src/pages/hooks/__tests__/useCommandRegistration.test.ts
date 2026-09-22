import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useCommandRegistration, type CommandEntry } from '../useCommandRegistration'
import { clearAllHandlers, executeCommand } from '@/utils/core/commandRegistry'

// The hook is the only place the page command tables reach the global registry,
// so these tests pin the registration lifecycle, the re-register-on-new-handler
// path, the shared window keydown listener and the development-only length
// guard. executeCommand is the public read side of the registry.

beforeEach(() => {
  clearAllHandlers()
})

afterEach(() => {
  clearAllHandlers()
  vi.restoreAllMocks()
})

describe('useCommandRegistration', () => {
  it('registers every command on mount and unregisters them on unmount', () => {
    const alpha = vi.fn()
    const beta = vi.fn()
    const commands: CommandEntry[] = [{ name: 'alpha', fn: alpha }, { name: 'beta', fn: beta }]

    const { unmount } = renderHook(() => useCommandRegistration(commands))

    act(() => executeCommand('alpha', 1))
    act(() => executeCommand('beta'))
    expect(alpha).toHaveBeenCalledWith(1)
    expect(beta).toHaveBeenCalledTimes(1)

    unmount()

    // After unmount the registry must not answer for either name; the dev-mode
    // warning is the observable side of "no handler".
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    act(() => executeCommand('alpha'))
    expect(alpha).toHaveBeenCalledTimes(1)
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

  it('logs a development error when the commands length changes between renders', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const commands = (n: number): CommandEntry[] =>
      Array.from({ length: n }, (_, i) => ({ name: `c${i}`, fn: vi.fn() }))

    const { rerender } = renderHook(
      ({ n }: { n: number }) => useCommandRegistration(commands(n)),
      { initialProps: { n: 1 } },
    )
    expect(error).not.toHaveBeenCalled()

    rerender({ n: 2 })

    // React may double-invoke the render in development, so assert the message
    // rather than an exact call count.
    expect(error).toHaveBeenCalled()
    expect(error.mock.calls.some(call => String(call[0]).includes('commands.length changed from 1 to 2'))).toBe(true)
  })
})
