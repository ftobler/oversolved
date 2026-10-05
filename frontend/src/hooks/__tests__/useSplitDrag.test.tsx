// The shared split-resize mechanism: default band, pointer-drag clamping,
// mouseup disarm, arrow-key stepping, and listener cleanup on unmount. Both
// editors (PartDocumentPanel and AssemblyTree) consume this one hook.
import { describe, it, expect, vi, afterEach } from 'vitest'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { renderHook, act } from '@testing-library/react'
import {
  useSplitDrag,
  MIN_SPLIT_PERCENT,
  MAX_SPLIT_PERCENT,
  DEFAULT_SPLIT_PERCENT,
} from '@/hooks/useSplitDrag'

// A container whose top is 100px down and 400px tall, so a clientY of 200 maps
// to (200-100)/400 = 25%.
function attachContainer(
  ref: { current: HTMLDivElement | null },
  rect: { top: number; height: number } = { top: 100, height: 400 },
) {
  const el = document.createElement('div')
  el.getBoundingClientRect = () => ({ ...rect, left: 0, width: 200, bottom: rect.top + rect.height, right: 200, x: 0, y: rect.top, toJSON: () => ({}) })
  ref.current = el
  return el
}

function moveMouse(clientY: number) {
  act(() => {
    document.dispatchEvent(new MouseEvent('mousemove', { clientY }))
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useSplitDrag', () => {
  it('starts at the default split and exposes the band limits', () => {
    const { result } = renderHook(() => useSplitDrag())
    expect(result.current.splitPercent).toBe(DEFAULT_SPLIT_PERCENT)
    expect(result.current.min).toBe(MIN_SPLIT_PERCENT)
    expect(result.current.max).toBe(MAX_SPLIT_PERCENT)
  })

  it('tracks the pointer height while dragging and stops on mouseup', () => {
    const { result } = renderHook(() => useSplitDrag())
    attachContainer(result.current.containerRef)

    act(() => { result.current.handleMouseDown() })
    moveMouse(200)
    expect(result.current.splitPercent).toBe(25)

    // Disarmed after mouseup: further moves are ignored.
    act(() => { document.dispatchEvent(new MouseEvent('mouseup')) })
    moveMouse(300)
    expect(result.current.splitPercent).toBe(25)
  })

  it('clamps the drag to the band at both ends', () => {
    const { result } = renderHook(() => useSplitDrag())
    attachContainer(result.current.containerRef)

    act(() => { result.current.handleMouseDown() })
    moveMouse(0)
    expect(result.current.splitPercent).toBe(MIN_SPLIT_PERCENT)

    moveMouse(10_000)
    expect(result.current.splitPercent).toBe(MAX_SPLIT_PERCENT)
  })

  it('does not move when no container is attached', () => {
    const { result } = renderHook(() => useSplitDrag())
    act(() => { result.current.handleMouseDown() })
    moveMouse(200)
    expect(result.current.splitPercent).toBe(DEFAULT_SPLIT_PERCENT)
  })

  it('steps with the arrow keys and clamps at the band', () => {
    const { result } = renderHook(() => useSplitDrag())
    const preventDefault = vi.fn()
    const key = (k: string) => act(() => {
      result.current.handleKeyDown({ key: k, preventDefault } as unknown as ReactKeyboardEvent<HTMLDivElement>)
    })

    key('ArrowDown')
    expect(result.current.splitPercent).toBe(DEFAULT_SPLIT_PERCENT + 2)
    key('ArrowUp')
    key('ArrowUp')
    expect(result.current.splitPercent).toBe(DEFAULT_SPLIT_PERCENT - 2)
    key('ArrowLeft')
    expect(result.current.splitPercent).toBe(DEFAULT_SPLIT_PERCENT - 4)
    expect(preventDefault).toHaveBeenCalled()

    // A non-arrow key is ignored and does not preventDefault.
    preventDefault.mockClear()
    key('Enter')
    expect(result.current.splitPercent).toBe(DEFAULT_SPLIT_PERCENT - 4)
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('clamps the keyboard step at the band', () => {
    const { result } = renderHook(() => useSplitDrag())
    const key = (k: string) => act(() => {
      result.current.handleKeyDown({ key: k, preventDefault: vi.fn() } as unknown as ReactKeyboardEvent<HTMLDivElement>)
    })
    for (let i = 0; i < 50; i++) key('ArrowUp')
    expect(result.current.splitPercent).toBe(MIN_SPLIT_PERCENT)
    for (let i = 0; i < 100; i++) key('ArrowDown')
    expect(result.current.splitPercent).toBe(MAX_SPLIT_PERCENT)
  })

  it('removes the document listeners on unmount', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const { unmount } = renderHook(() => useSplitDrag())
    unmount()
    expect(removeSpy).toHaveBeenCalledWith('mousemove', expect.any(Function))
    expect(removeSpy).toHaveBeenCalledWith('mouseup', expect.any(Function))
  })
})
