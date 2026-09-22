import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  dimensionLabelAdapter,
  parseDimensionLabelKey,
} from '../dimensionLabelAdapter'
import {
  registerDimCallbacks,
  resetDimCallbacksForTest,
} from '../dimensionLabelCallbacks'

beforeEach(() => resetDimCallbacksForTest())

describe('parseDimensionLabelKey', () => {
  it('decodes a bare dim:<cid> key', () => {
    expect(parseDimensionLabelKey('dim:c1')).toEqual({ cid: 'c1' })
  })
  it('decodes dim:<cid>:<sub>', () => {
    expect(parseDimensionLabelKey('dim:c1:value-2')).toEqual({ cid: 'c1', sub: 'value-2' })
  })
  it('rejects non-dim keys', () => {
    expect(parseDimensionLabelKey('face@x')).toBeNull()
    expect(parseDimensionLabelKey('dim:')).toBeNull()
  })
})

describe('dimensionLabelAdapter', () => {
  it('routes onClick to the registered callback for the cid', () => {
    const onClick = vi.fn()
    registerDimCallbacks('c1', { onOver: () => {}, onOut: () => {}, onClick, onDoubleClick: () => {}, onPointerDown: () => {} })
    expect(dimensionLabelAdapter.onClick('dim:c1', 10, 20)).toBe(true)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onClick).toHaveBeenCalledWith(10, 20)
  })

  it('routes both subkeys of the same cid to the same callback', () => {
    const onClick = vi.fn()
    registerDimCallbacks('c1', { onOver: () => {}, onOut: () => {}, onClick, onDoubleClick: () => {}, onPointerDown: () => {} })
    dimensionLabelAdapter.onClick('dim:c1:value-1', 0, 0)
    dimensionLabelAdapter.onClick('dim:c1:value-2', 0, 0)
    expect(onClick).toHaveBeenCalledTimes(2)
  })

  it('returns false when no callback is registered', () => {
    expect(dimensionLabelAdapter.onClick('dim:unknown', 0, 0)).toBe(false)
  })

  it('unregister stops further routing', () => {
    const onClick = vi.fn()
    const unregister = registerDimCallbacks('c1', { onOver: () => {}, onOut: () => {}, onClick, onDoubleClick: () => {}, onPointerDown: () => {} })
    unregister()
    expect(dimensionLabelAdapter.onClick('dim:c1', 0, 0)).toBe(false)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('hover routing fires onOver / onOut', () => {
    const onOver = vi.fn()
    const onOut = vi.fn()
    registerDimCallbacks('c1', { onOver, onOut, onClick: () => {}, onDoubleClick: () => {}, onPointerDown: () => {} })
    dimensionLabelAdapter.onOver('dim:c1')
    dimensionLabelAdapter.onOut('dim:c1')
    expect(onOver).toHaveBeenCalledTimes(1)
    expect(onOut).toHaveBeenCalledTimes(1)
  })

  it('routes onDoubleClick to the registered callback for the cid', () => {
    const onDoubleClick = vi.fn()
    registerDimCallbacks('c1', { onOver: () => {}, onOut: () => {}, onClick: () => {}, onDoubleClick, onPointerDown: () => {} })
    expect(dimensionLabelAdapter.onDoubleClick('dim:c1', 5, 6)).toBe(true)
    expect(onDoubleClick).toHaveBeenCalledTimes(1)
    expect(onDoubleClick).toHaveBeenCalledWith(5, 6)
  })

  it('onDoubleClick returns false when no callback is registered', () => {
    expect(dimensionLabelAdapter.onDoubleClick('dim:unknown', 0, 0)).toBe(false)
  })

  // Every route guards the same two ways: a malformed key and a cid with no
  // live handler. A false lets the dispatcher fall through to the next layer
  // instead of consuming the click on a dead label.
  it('every route returns false for a malformed key', () => {
    expect(dimensionLabelAdapter.onOver('face@x')).toBe(false)
    expect(dimensionLabelAdapter.onOut('face@x')).toBe(false)
    expect(dimensionLabelAdapter.onClick('face@x', 0, 0)).toBe(false)
    expect(dimensionLabelAdapter.onDoubleClick('face@x', 0, 0)).toBe(false)
    expect(dimensionLabelAdapter.onPointerDown('face@x', 0, 0)).toBe(false)
  })

  it('every route returns false when the cid has no registered callbacks', () => {
    expect(dimensionLabelAdapter.onOver('dim:missing')).toBe(false)
    expect(dimensionLabelAdapter.onOut('dim:missing')).toBe(false)
    expect(dimensionLabelAdapter.onClick('dim:missing', 0, 0)).toBe(false)
    expect(dimensionLabelAdapter.onDoubleClick('dim:missing', 0, 0)).toBe(false)
    expect(dimensionLabelAdapter.onPointerDown('dim:missing', 0, 0)).toBe(false)
  })

  it('onPointerDown routes to the registered callback and returns true', () => {
    const onPointerDown = vi.fn()
    registerDimCallbacks('c1', { onOver: () => {}, onOut: () => {}, onClick: () => {}, onDoubleClick: () => {}, onPointerDown })
    expect(dimensionLabelAdapter.onPointerDown('dim:c1', 3, 4)).toBe(true)
    expect(onPointerDown).toHaveBeenCalledWith(3, 4)
  })
})
