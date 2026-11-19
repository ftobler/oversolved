import { describe, it, expect } from 'vitest'
import { createHandleGestureOwner } from '../handleGestureOwner'
import { FACE_LAYER_NAME, FEATURE_HANDLE_LAYER_NAME, SKETCH_VERTEX_LAYER_NAME } from '@/picking'

describe('handleGestureOwner', () => {
  it('T1: a handle press owns hover and the click for the whole drag', () => {
    const owner = createHandleGestureOwner()
    owner.press(FEATURE_HANDLE_LAYER_NAME)
    owner.move(1)

    expect(owner.suppressHover()).toBe(true)
    expect(owner.takeClick()).toBe(true)
    expect(owner.takeClick()).toBe(false)
  })

  it('T2: a press on another layer owns nothing', () => {
    const owner = createHandleGestureOwner()
    owner.press(FACE_LAYER_NAME)
    owner.move(1)

    expect(owner.suppressHover()).toBe(false)
    expect(owner.takeClick()).toBe(false)
  })

  it('T3: a stranded release (move with no button held) drops ownership', () => {
    const owner = createHandleGestureOwner()
    owner.press(FEATURE_HANDLE_LAYER_NAME)
    owner.move(1)
    expect(owner.suppressHover()).toBe(true)

    owner.move(0)

    expect(owner.suppressHover()).toBe(false)
    expect(owner.takeClick()).toBe(false)
  })

  it('T3b: a fresh press on a face starts a gesture that owns nothing', () => {
    const owner = createHandleGestureOwner()
    owner.press(FEATURE_HANDLE_LAYER_NAME)
    owner.move(1)
    expect(owner.takeClick()).toBe(true)

    owner.press(FACE_LAYER_NAME)
    owner.move(1)

    expect(owner.suppressHover()).toBe(false)
    expect(owner.takeClick()).toBe(false)
  })

  it('T8: an activated sketch drag owns the click but never freezes hover', () => {
    const owner = createHandleGestureOwner()
    owner.press(SKETCH_VERTEX_LAYER_NAME)
    owner.noteDragArmed(true)
    owner.noteDragActivated()
    owner.move(1)

    expect(owner.suppressHover()).toBe(false)
    expect(owner.takeClick()).toBe(true)
    expect(owner.takeClick()).toBe(false)
  })

  it('an armed drag that never activated leaves the click to the normal pick', () => {
    const owner = createHandleGestureOwner()
    owner.press(SKETCH_VERTEX_LAYER_NAME)
    owner.noteDragArmed(true)
    // A stationary press never activates a drag, so the vertex click must still
    // select it.
    owner.move(1)

    expect(owner.takeClick()).toBe(false)
  })

  it('an unarmed press is not handed another gesture\'s active drag', () => {
    const owner = createHandleGestureOwner()
    owner.press(FACE_LAYER_NAME)
    owner.noteDragArmed(false)
    owner.noteDragActivated()
    owner.move(1)

    expect(owner.takeClick()).toBe(false)
  })

  it('a stranded release also drops an activated sketch drag\'s click ownership', () => {
    const owner = createHandleGestureOwner()
    owner.press(SKETCH_VERTEX_LAYER_NAME)
    owner.noteDragArmed(true)
    owner.noteDragActivated()

    owner.move(0)

    expect(owner.takeClick()).toBe(false)
  })

  it('reports a press on nothing as owning nothing', () => {
    const owner = createHandleGestureOwner()
    owner.press(null)
    owner.move(1)

    expect(owner.suppressHover()).toBe(false)
    expect(owner.takeClick()).toBe(false)
  })
})
