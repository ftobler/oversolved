// The splash title waits for the self-hosted 700 Roboto face so it does not
// swap fonts mid-load and change its spacing. The hook owns that wait, so every
// exit (already usable, loaded, failed, ceiling, throwing loader, no
// FontFaceSet) is tested without a browser.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StrictMode } from 'react'
import { act, renderHook } from '@testing-library/react'
import {
  FONT_READY_CEILING_MS,
  SPLASH_TITLE_FONT,
  SPLASH_TITLE_TEXT,
  useFontReady,
} from '@/hooks/useFontReady'

type Load = (font: string, text?: string) => Promise<unknown>
type Check = (font: string, text?: string) => boolean

function stubFonts(load: Load, check?: Check): void {
  Object.defineProperty(document, 'fonts', {
    value: { load, check }, configurable: true, writable: true,
  })
}

describe('useFontReady', () => {
  beforeEach(() => {
    Reflect.deleteProperty(document as object, 'fonts')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    Reflect.deleteProperty(document as object, 'fonts')
  })

  it('is ready immediately when document.fonts is absent', () => {
    const { result } = renderHook(() => useFontReady())
    expect(result.current).toBe(true)
  })

  it('is ready immediately when the face is already usable', () => {
    const load = vi.fn<Load>(() => Promise.resolve())
    stubFonts(load, () => true)

    const { result } = renderHook(() => useFontReady())
    expect(result.current).toBe(true)
    expect(load).not.toHaveBeenCalled()
  })

  it('requests the 700 face for the wordmark text and becomes ready when it loads', async () => {
    let resolveLoad: () => void = () => {}
    const load = vi.fn<Load>(() => new Promise<void>(resolve => { resolveLoad = resolve }))
    stubFonts(load)

    const { result } = renderHook(() => useFontReady())
    expect(load).toHaveBeenCalledWith(SPLASH_TITLE_FONT, SPLASH_TITLE_TEXT)
    expect(result.current).toBe(false)

    await act(async () => {
      resolveLoad()
      await Promise.resolve()
    })
    expect(result.current).toBe(true)
  })

  it('shows at the ceiling when the face never loads', () => {
    stubFonts(() => new Promise(() => {}))
    vi.useFakeTimers()

    const { result } = renderHook(() => useFontReady())
    expect(result.current).toBe(false)

    act(() => vi.advanceTimersByTime(FONT_READY_CEILING_MS - 1))
    expect(result.current).toBe(false)

    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBe(true)
  })

  it('also shows when the face fails to load', async () => {
    stubFonts(() => Promise.reject(new Error('offline')))

    const { result } = renderHook(() => useFontReady())
    expect(result.current).toBe(false)

    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current).toBe(true)
  })

  it('shows when load throws synchronously', () => {
    stubFonts(() => { throw new Error('bad shorthand') })
    vi.useFakeTimers()

    const { result } = renderHook(() => useFontReady())
    expect(result.current).toBe(false)

    act(() => vi.advanceTimersByTime(0))
    expect(result.current).toBe(true)
  })

  it('settles once under StrictMode double effects', async () => {
    let resolveLoad: () => void = () => {}
    stubFonts(() => new Promise<void>(resolve => { resolveLoad = resolve }))

    const { result } = renderHook(() => useFontReady(), { wrapper: StrictMode })
    expect(result.current).toBe(false)

    await act(async () => {
      resolveLoad()
      await Promise.resolve()
    })
    expect(result.current).toBe(true)
  })

  it('clears its ceiling timer on unmount', async () => {
    let resolveLoad: () => void = () => {}
    stubFonts(() => new Promise<void>(resolve => { resolveLoad = resolve }))
    vi.useFakeTimers()

    const timersBefore = vi.getTimerCount()
    const { unmount } = renderHook(() => useFontReady())
    // The ceiling is the only timer the hook owns, and unmount must clear it.
    expect(vi.getTimerCount()).toBe(timersBefore + 1)
    unmount()
    expect(vi.getTimerCount()).toBe(timersBefore)

    // A face that resolves after unmount must stay harmless. React 19 has no
    // post-unmount warning, so the timer count above is what this test proves;
    // this exercises the dead callback so a throw would still fail here.
    await act(async () => {
      resolveLoad()
      await Promise.resolve()
    })
  })
})
