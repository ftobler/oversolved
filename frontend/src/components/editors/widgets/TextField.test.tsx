import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TextFieldWidget } from './TextField'
import type { TextFieldDef } from './fieldTypes'

const field: TextFieldDef = { type: 'text', key: 'name', label: 'Name' }

function renderWidget(props: Partial<React.ComponentProps<typeof TextFieldWidget>> = {}) {
  const onMutation = vi.fn()
  const { rerender } = render(
    <TextFieldWidget field={field} value="A" fid="f1" onMutation={onMutation} mutationType="set_test_field" {...props} />,
  )
  const input = screen.getByRole('textbox') as HTMLInputElement
  return { input, onMutation, rerender }
}

describe('TextFieldWidget', () => {
  it('mounts the external value', () => {
    const { input } = renderWidget({ value: 'A' })
    expect(input.value).toBe('A')
  })

  it('resyncs to an external value change while idle (e.g. undo/redo)', () => {
    const { input, rerender } = renderWidget({ value: 'A' })
    rerender(
      <TextFieldWidget field={field} value="B" fid="f1" onMutation={vi.fn()} mutationType="set_test_field" />,
    )
    expect(input.value).toBe('B')
  })

  it('does not clobber an in-progress edit when an external value change arrives mid-edit', () => {
    const { input, rerender } = renderWidget({ value: 'A' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'typing...' } })
    rerender(
      <TextFieldWidget field={field} value="B" fid="f1" onMutation={vi.fn()} mutationType="set_test_field" />,
    )
    expect(input.value).toBe('typing...')
  })

  it('commits the typed value on blur', () => {
    const { input, onMutation } = renderWidget({ value: 'A' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'B' } })
    fireEvent.blur(input)
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_test_field', featureId: 'f1', field: 'name', value: 'B' })
  })

  it('commits on Enter', () => {
    const { input, onMutation } = renderWidget({ value: 'A' })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'B' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.blur(input)
    expect(onMutation).toHaveBeenCalledWith({ type: 'set_test_field', featureId: 'f1', field: 'name', value: 'B' })
  })

  it('reverts to the external value after a blur that fails validate', () => {
    const strict: TextFieldDef = { ...field, validate: (v) => v === 'A' }
    const { input, onMutation } = renderWidget({ value: 'A', field: strict })
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'nope' } })
    fireEvent.blur(input)
    expect(onMutation).not.toHaveBeenCalled()
    expect(input.value).toBe('A')
  })
})
