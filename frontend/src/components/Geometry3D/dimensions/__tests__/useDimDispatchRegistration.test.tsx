import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { getDimCallbacks, resetDimCallbacksForTest } from '@/components/Viewport/idDispatch/dimensionLabelCallbacks'
import { useDimDispatchRegistration } from '../useDimDispatchRegistration'

/**
 * The id-buffer dispatcher calls dimension labels by constraint id, through the
 * registry this hook populates. These tests pin the argument translation (the
 * dispatcher hands raw client coords; the component handlers expect a
 * stopPropagation-bearing event) and the ref-freshness contract: re-registering
 * is keyed on cid only, so changed handlers must ride the ref.
 */

function makeTarget() {
  return {
    onOver: vi.fn(),
    onOut: vi.fn(),
    onClick: vi.fn(),
    onDoubleClick: vi.fn(),
    onPointerDown: vi.fn(),
  }
}

beforeEach(() => {
  resetDimCallbacksForTest()
})

describe('useDimDispatchRegistration', () => {
  it('registers under the constraint id and unregisters on unmount', () => {
    const target = makeTarget()
    const { unmount } = renderHook(() => useDimDispatchRegistration('c1', target))

    expect(getDimCallbacks('c1')).toBeDefined()
    unmount()
    expect(getDimCallbacks('c1')).toBeUndefined()
  })

  it('translates dispatcher calls into stopPropagation-bearing events with client coords', () => {
    const target = makeTarget()
    renderHook(() => useDimDispatchRegistration('c1', target))
    const cb = getDimCallbacks('c1')!

    cb.onOver()
    cb.onOut()
    cb.onClick(11, 22)
    cb.onDoubleClick(33, 44)
    cb.onPointerDown(55, 66)

    expect(target.onOver).toHaveBeenCalledWith({ stopPropagation: expect.any(Function) })
    expect(target.onOut).toHaveBeenCalledTimes(1)
    expect(target.onClick).toHaveBeenCalledWith({ stopPropagation: expect.any(Function), clientX: 11, clientY: 22 })
    expect(target.onDoubleClick).toHaveBeenCalledWith({ stopPropagation: expect.any(Function), clientX: 33, clientY: 44 })
    expect(target.onPointerDown).toHaveBeenCalledWith({ stopPropagation: expect.any(Function), clientX: 55, clientY: 66 })
  })

  it('routes to the latest handlers without re-registering a new callback set', () => {
    const first = makeTarget()
    const { rerender } = renderHook(({ target }) => useDimDispatchRegistration('c1', target), {
      initialProps: { target: first },
    })
    const before = getDimCallbacks('c1')

    const second = makeTarget()
    rerender({ target: second })

    // Same registration object (effect deps are cid only) but new handlers fire.
    expect(getDimCallbacks('c1')).toBe(before)
    getDimCallbacks('c1')!.onOut()
    expect(second.onOut).toHaveBeenCalledTimes(1)
    expect(first.onOut).not.toHaveBeenCalled()
  })
})
