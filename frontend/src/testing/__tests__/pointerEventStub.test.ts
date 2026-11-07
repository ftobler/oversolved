// @vitest-environment jsdom
/**
 * Guards the shared jsdom PointerEvent stub the Viewport tests install.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { installPointerEventStub } from '@/testing/pointerEventStub'

// jsdom ships no PointerEvent, which is exactly what the stub's guard keys on.
// The alias lets the tests write the constructor back to undefined between cases.
type PointerEventWindow = { PointerEvent: typeof PointerEvent | undefined }
const win = window as unknown as PointerEventWindow

type StubFields = { isPrimary?: boolean; pointerId?: number; pointerType?: string }

describe('installPointerEventStub', () => {
  afterEach(() => {
    win.PointerEvent = undefined  // each case starts from the jsdom-absent state
  })

  it('installs a constructor when jsdom has none', () => {
    installPointerEventStub('')
    expect(typeof win.PointerEvent).toBe('function')
  })

  it('keeps an existing implementation instead of shadowing it', () => {
    const existing = class ExistingPointerEvent {} as unknown as typeof PointerEvent
    win.PointerEvent = existing
    installPointerEventStub('mouse')
    expect(win.PointerEvent).toBe(existing)
  })

  it('extends MouseEvent so button and coordinates survive', () => {
    installPointerEventStub('')
    const e = new window.PointerEvent('pointerdown', { button: 2, clientX: 40, clientY: 12 })
    expect(e).toBeInstanceOf(MouseEvent)
    expect(e.button).toBe(2)
    expect(e.clientX).toBe(40)
  })

  it('defaults to the inert pointer: not primary, id 0, the caller pointer type', () => {
    installPointerEventStub('')
    const e = new window.PointerEvent('pointerdown') as unknown as StubFields
    expect(e.isPrimary).toBe(false)
    expect(e.pointerId).toBe(0)
    expect(e.pointerType).toBe('')

    win.PointerEvent = undefined
    installPointerEventStub('mouse')
    const mouse = new window.PointerEvent('pointerdown') as unknown as StubFields
    expect(mouse.pointerType).toBe('mouse')
  })

  it('lets an explicit init win over the defaults', () => {
    installPointerEventStub('')
    const e = new window.PointerEvent('pointerdown', {
      isPrimary: true,
      pointerId: 7,
      pointerType: 'touch',
    }) as unknown as StubFields
    expect(e.isPrimary).toBe(true)
    expect(e.pointerId).toBe(7)
    expect(e.pointerType).toBe('touch')
  })

  it('defines the pointer fields enumerable so property reads see them', () => {
    installPointerEventStub('mouse')
    const e = new window.PointerEvent('pointerdown') as unknown as StubFields
    expect({ ...e }.pointerType).toBe('mouse')
  })
})
