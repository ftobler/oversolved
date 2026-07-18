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
