import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ExpressionInput } from './ExpressionInput'
import { validateNumberFieldValue } from './numberFieldValidate'
import type { NumberFieldDef } from './fieldTypes'

function nfField(over: Partial<NumberFieldDef> = {}): NumberFieldDef {
  return { type: 'number', key: 'k', label: 'L', ...over }
}

function renderInput(props: Partial<React.ComponentProps<typeof ExpressionInput>> = {}) {
  const onChange = vi.fn()
  const { rerender, unmount } = render(<ExpressionInput value={10} onChange={onChange} ariaLabel="Field" {...props} />)
  const input = screen.getByRole('textbox', { name: 'Field' }) as HTMLInputElement
  return { input, onChange, rerender, unmount }
}

describe('ExpressionInput', () => {
  it('mounts a number value as its string representation', () => {
    const { input } = renderInput({ value: 42 })
    expect(input.value).toBe('42')
  })

  it('mounts a string value as-is', () => {
    const { input } = renderInput({ value: '50+25' })
    expect(input.value).toBe('50+25')
  })

  it('shows the raw expression while editing', () => {
    const { input } = renderInput()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '50+25' } })
    expect(input.value).toBe('50+25')
  })

  it('commits a plain number as a number on blur', () => {
    const { input, onChange } = renderInput()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '30' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith(30)
  })

  it('commits an expression as the raw string on blur', () => {
    const { input, onChange } = renderInput()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '50+25' } })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith('50+25')
  })

  it('shows the evaluated result hint for a valid expression', () => {
    const { input } = renderInput()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '50+25' } })
    expect(screen.getByText('= 75')).toBeInTheDocument()
  })

  it('commits on Enter', () => {
    const { input, onChange } = renderInput()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '6*7' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith('6*7')
  })

  it('reverts to the external value on Escape without committing', () => {
    const { input, onChange } = renderInput({ value: 10 })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '999' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.blur(input)
    expect(onChange).not.toHaveBeenCalled()
    expect(input.value).toBe('10')
  })

  it('marks an invalid expression with the error class and does not commit', () => {
    const { input, onChange } = renderInput()
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '2+/' } })
    expect(input.className).toContain('feature-field-input--error')
    fireEvent.blur(input)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('rejects a value failing the validate predicate', () => {
    const { input, onChange } = renderInput({ value: 10, validate: (v) => v > 0 })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '-5' } })
    fireEvent.blur(input)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('resolves a variable from context', () => {
    const { input, onChange } = renderInput({ value: 10, context: { width: 5 } })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'width*2' } })
    expect(screen.getByText('= 10')).toBeInTheDocument()
    fireEvent.blur(input)
    expect(onChange).toHaveBeenCalledWith('width*2')
  })
})

describe('ExpressionInput wheel step', () => {
  it('wheel up over an unfocused field commits value plus one', () => {
    const { input, onChange } = renderInput({ value: 10 })
    fireEvent.wheel(input, { deltaY: -100 })
    expect(onChange).toHaveBeenCalledWith(11)
  })

  it('wheel down over an unfocused field commits value minus one', () => {
    const { input, onChange } = renderInput({ value: 10 })
    fireEvent.wheel(input, { deltaY: 100 })
    expect(onChange).toHaveBeenCalledWith(9)
  })

  it('steps by one regardless of the current magnitude', () => {
    const { input, onChange } = renderInput({ value: 1000 })
    fireEvent.wheel(input, { deltaY: -100 })
    expect(onChange).toHaveBeenCalledWith(1001)
  })

  it('steps by one regardless of decimals', () => {
    const { input, onChange } = renderInput({ value: 2.5 })
    fireEvent.wheel(input, { deltaY: -100 })
    expect(onChange).toHaveBeenCalledWith(3.5)
  })

  it('ignores the wheel delta magnitude', () => {
    const { input, onChange } = renderInput({ value: 10 })
    fireEvent.wheel(input, { deltaY: -1 })
    expect(onChange).toHaveBeenCalledWith(11)
    onChange.mockClear()
    fireEvent.wheel(input, { deltaY: -400 })
    expect(onChange).toHaveBeenCalledWith(11)
  })

  it('ten notches produce ten single steps, not an accelerating one', () => {
    let v = 0
    const { input, onChange, rerender } = renderInput({ value: v })
    for (let i = 0; i < 10; i++) {
      fireEvent.wheel(input, { deltaY: -100 })
      v += 1
      rerender(<ExpressionInput value={v} onChange={onChange} ariaLabel="Field" />)
    }
    expect(onChange.mock.calls.map(c => c[0])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('calls preventDefault so the panel does not scroll', () => {
    const { input } = renderInput({ value: 10 })
    const ev = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })
    input.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
  })

  it('does not preventDefault over an expression field', () => {
    const { input, onChange } = renderInput({ value: 'width*2' })
    const ev = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })
    input.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not preventDefault over an empty field', () => {
    const { input, onChange } = renderInput({ value: 10 })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '' } })
    const ev = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })
    input.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('refuses a step that fails validate and holds at the boundary', () => {
    const { input, onChange } = renderInput({ value: 1, validate: (v) => v > 0 })
    fireEvent.wheel(input, { deltaY: 100 })
    expect(onChange).not.toHaveBeenCalled()
    expect(input.value).toBe('1')
  })

  it('still preventDefaults a refused step at the boundary', () => {
    const { input } = renderInput({ value: 1, validate: (v) => v > 0 })
    const ev = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })
    input.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
  })

  it('refuses a step below a declared min', () => {
    const { input, onChange } = renderInput({ value: 1, validate: (v) => validateNumberFieldValue(nfField({ min: 1 }), v) })
    fireEvent.wheel(input, { deltaY: 100 })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('refuses a fractional result on an int field', () => {
    const { input, onChange } = renderInput({ value: 2.5, validate: (v) => validateNumberFieldValue(nfField({ parse: 'int' }), v) })
    fireEvent.wheel(input, { deltaY: -100 })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not create a draft when stepping an idle field', () => {
    const { input, onChange, rerender } = renderInput({ value: 10 })
    fireEvent.wheel(input, { deltaY: -100 })
    expect(onChange).toHaveBeenCalledWith(11)
    rerender(<ExpressionInput value={99} onChange={onChange} ariaLabel="Field" />)
    expect(input.value).toBe('99')
  })

  it('keeps an open draft in sync when stepping a focused field', () => {
    const { input, onChange } = renderInput({ value: 10 })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '7' } })
    fireEvent.wheel(input, { deltaY: -100 })
    expect(onChange).toHaveBeenCalledWith(8)
    expect(input.value).toBe('8')
  })

  it('does not clobber an in-progress edit arriving from outside', () => {
    const { input, onChange, rerender } = renderInput({ value: 10 })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '7' } })
    fireEvent.wheel(input, { deltaY: -100 })
    expect(onChange).toHaveBeenCalledWith(8)
    rerender(<ExpressionInput value={555} onChange={vi.fn()} ariaLabel="Field" />)
    expect(input.value).toBe('8')
  })

  it('does not step a disabled field', () => {
    const { input, onChange } = renderInput({ value: 10, disabled: true })
    const ev = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })
    input.dispatchEvent(ev)
    expect(onChange).not.toHaveBeenCalled()
    expect(ev.defaultPrevented).toBe(false)
  })

  it('removes its listener on unmount', () => {
    const { input, onChange, unmount } = renderInput({ value: 10 })
    unmount()
    const ev = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })
    input.dispatchEvent(ev)
    expect(onChange).not.toHaveBeenCalled()
  })
})
