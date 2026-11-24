import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import RenameDialog from '@/components/dialogs/RenameDialog'

function open(props?: Partial<React.ComponentProps<typeof RenameDialog>>) {
  const onRename = vi.fn()
  const onCancel = vi.fn()
  const utils = render(
    <RenameDialog isOpen currentName="Sketch A" onRename={onRename} onCancel={onCancel} {...props} />
  )
  return { onRename, onCancel, ...utils }
}

describe('RenameDialog', () => {
  it('seeds the field with the current name and selects it', () => {
    open()
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.value).toBe('Sketch A')
    expect(input).toHaveFocus()
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe('Sketch A'.length)
  })

  it('confirms the edited name', () => {
    const { onRename } = open()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Base Profile' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(onRename).toHaveBeenCalledWith('Base Profile')
  })

  it('confirms on Enter, which the shell leaves to the caller', () => {
    const { onRename } = open()
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'Base Profile' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRename).toHaveBeenCalledWith('Base Profile')
  })

  it('trims the name before handing it over', () => {
    const { onRename } = open()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Padded  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(onRename).toHaveBeenCalledWith('Padded')
  })

  // window.prompt dropped a blank answer silently; the dialog says so up front.
  it('refuses a blank name by both routes', () => {
    const { onRename } = open()
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRename).not.toHaveBeenCalled()
  })

  it('cancels on Escape without renaming', () => {
    const { onRename, onCancel } = open()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onRename).not.toHaveBeenCalled()
  })

  it('shows the validation hint, disables OK and holds Enter until the name passes', () => {
    const validate = (name: string) => name.includes('-') ? 'no dashes' : null
    const { onRename } = open({ validate })
    const input = screen.getByRole('textbox')

    fireEvent.change(input, { target: { value: 'my-var' } })
    expect(screen.getByText('no dashes')).toBeInTheDocument()
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onRename).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: 'my_var' } })
    expect(screen.queryByText('no dashes')).toBeNull()
    expect(input).toHaveAttribute('aria-invalid', 'false')
    expect(screen.getByRole('button', { name: 'Rename' })).not.toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(onRename).toHaveBeenCalledWith('my_var')
  })

  it('does not hint on the prefilled name before the first edit', () => {
    const validate = vi.fn(() => null)
    const { onRename } = open({ validate })
    expect(validate).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Rename' })).not.toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(onRename).toHaveBeenCalledWith('Sketch A')
  })

  // A legacy document can carry a label the rule refuses. OK is enabled because
  // the prefill is not judged, so the first confirm must reveal the hint rather
  // than dispatch a rename whose only feedback is the toast behind the modal.
  it('reveals the hint instead of confirming an invalid prefilled name', () => {
    const { onRename } = open({ validate: name => name === 'Sketch A' ? 'bad legacy name' : null })
    const input = screen.getByRole('textbox')
    expect(screen.queryByText('bad legacy name')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(screen.getByText('bad legacy name')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled()
    expect(onRename).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: 'Good' } })
    expect(screen.queryByText('bad legacy name')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(onRename).toHaveBeenCalledWith('Good')
  })

  it('runs the validator on the trimmed name', () => {
    const validate = (name: string) => name === 'my-var' ? 'no dashes' : null
    open({ validate })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  my-var  ' } })
    expect(screen.getByText('no dashes')).toBeInTheDocument()
  })

  // Without a validator the other callers (clone, part, mate, DXF layer) keep
  // their exact behaviour, hyphens included.
  it('confirms a hyphenated name without a validator', () => {
    const { onRename } = open()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'my-var' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(onRename).toHaveBeenCalledWith('my-var')
  })

  it('normalizes typed text in the field and commits the normalized name', () => {
    const { onRename } = open({ normalize: s => s.replace(/ /g, '_') })
    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'my var', selectionStart: 7, selectionEnd: 7 } })
    expect(input.value).toBe('my_var')
    expect(input.selectionStart).toBe(6)
    expect(input.selectionEnd).toBe(6)
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(onRename).toHaveBeenCalledWith('my_var')
  })

  it('holds the caret at the typed position, including inside the name', () => {
    open({ currentName: 'abc', normalize: s => s.replace(/ /g, '_') })
    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'ab c', selectionStart: 3, selectionEnd: 3 } })
    expect(input.value).toBe('ab_c')
    expect(input.selectionStart).toBe(3)
    expect(input.selectionEnd).toBe(3)
  })

  // A fold that lands on the current value bails out of React's state update, so
  // the layout effect cannot clear the captured caret. The following keystroke
  // must still land where the user typed, not one character behind.
  it('keeps the caret correct after folding a space over an existing underscore', () => {
    open({ currentName: 'ab_cd', normalize: s => s.replace(/ /g, '_') })
    const input = screen.getByRole('textbox') as HTMLInputElement
    // Replace the `_` with a space: raw 'ab cd' folds back to the current 'ab_cd'.
    fireEvent.change(input, { target: { value: 'ab cd', selectionStart: 3, selectionEnd: 3 } })
    expect(input.value).toBe('ab_cd')
    // Type a character at that caret: 'ab cxd' folds to 'ab_cxd', caret at 4.
    fireEvent.change(input, { target: { value: 'ab cxd', selectionStart: 4, selectionEnd: 4 } })
    expect(input.value).toBe('ab_cxd')
    expect(input.selectionStart).toBe(4)
    expect(input.selectionEnd).toBe(4)
  })

  it('does not reuse a stale caret when the next edit has no space to fold', () => {
    open({ currentName: 'ab_cd', normalize: s => s.replace(/ /g, '_') })
    const input = screen.getByRole('textbox') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'ab cd', selectionStart: 3, selectionEnd: 3 } })
    // Backspace over the space: raw 'abcd' already equals the wanted name, so
    // the caret from the previous (no-op) fold must not be applied.
    fireEvent.change(input, { target: { value: 'abcd', selectionStart: 2, selectionEnd: 2 } })
    expect(input.value).toBe('abcd')
    expect(input.selectionStart).toBe(2)
    expect(input.selectionEnd).toBe(2)
  })

  it('leaves spaces alone when no normalize is supplied', () => {
    const { onRename } = open()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'my var' } })
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('my var')
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    expect(onRename).toHaveBeenCalledWith('my var')
  })

  it('runs the validator on the normalized text', () => {
    const validate = vi.fn(() => null)
    open({ normalize: s => s.replace(/ /g, '_'), validate })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'my-var' } })
    expect(validate).toHaveBeenCalledWith('my-var')
  })

  // The dialog stays mounted across renames, so a later target must reach the field.
  it('re-seeds on reopen but never while open', () => {
    const { rerender, onRename, onCancel } = open()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'typed' } })

    const props = { onRename, onCancel }
    rerender(<RenameDialog isOpen currentName="Body1" {...props} />)
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('typed')

    rerender(<RenameDialog isOpen={false} currentName="Body1" {...props} />)
    rerender(<RenameDialog isOpen currentName="Body1" {...props} />)
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('Body1')
  })
})
