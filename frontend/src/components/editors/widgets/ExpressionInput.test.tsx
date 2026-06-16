import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ExpressionInput } from './ExpressionInput'

function renderInput(props: Partial<React.ComponentProps<typeof ExpressionInput>> = {}) {
  const onChange = vi.fn()
  render(<ExpressionInput value={10} onChange={onChange} ariaLabel="Field" {...props} />)
  const input = screen.getByRole('textbox', { name: 'Field' }) as HTMLInputElement
  return { input, onChange }
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
