import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useClickAfterDragSuppression } from '../useClickAfterDragSuppression'

describe('useClickAfterDragSuppression', () => {
  it('reset clears moved state so consume returns false', () => {
    const { result } = renderHook(() => useClickAfterDragSuppression())
    act(() => { result.current.markMoved() })
    act(() => { result.current.reset() })
    expect(result.current.consumeClick()).toBe(false)
  })

  it('marking moved then consuming returns true (suppressed)', () => {
    const { result } = renderHook(() => useClickAfterDragSuppression())
    act(() => { result.current.markMoved() })
    expect(result.current.consumeClick()).toBe(true)
  })

  it('second consume without marking moved again returns false (not suppressed)', () => {
    const { result } = renderHook(() => useClickAfterDragSuppression())
    act(() => { result.current.markMoved() })
    result.current.consumeClick()  // first consume clears the flag
    expect(result.current.consumeClick()).toBe(false)
  })

  it('not marking moved: consume returns false', () => {
    const { result } = renderHook(() => useClickAfterDragSuppression())
    expect(result.current.consumeClick()).toBe(false)
  })
})
