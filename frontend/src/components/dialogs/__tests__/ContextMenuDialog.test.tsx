import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ContextMenuDialog from '@/components/dialogs/ContextMenuDialog'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

describe('ContextMenuDialog validation', () => {
  beforeEach(() => {
    useSketchEditorStore.setState({ pendingDialog: null })
  })

  function openWith(onConfirm: (v: string) => void) {
    useSketchEditorStore.setState({
      pendingDialog: {
        position: [0, 0],
        label: 'Dimension value',
        defaultValue: '10',
        validate: (v) => (parseFloat(v) > 0 ? null : 'Must be greater than 0'),
        onConfirm,
      },
    })
  }

  it('rejects invalid input: keeps dialog open, shows error, does not confirm', () => {
    const onConfirm = vi.fn()
    openWith(onConfirm)
    render(<ContextMenuDialog />)

    const input = screen.getByDisplayValue('10') as HTMLInputElement
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onConfirm).not.toHaveBeenCalled()
    expect(useSketchEditorStore.getState().pendingDialog).not.toBeNull()
    expect(screen.getByRole('alert')).toHaveTextContent('Must be greater than 0')
  })

  it('accepts valid input: confirms and closes', () => {
    const onConfirm = vi.fn()
    openWith(onConfirm)
    render(<ContextMenuDialog />)

    const input = screen.getByDisplayValue('10') as HTMLInputElement
    fireEvent.change(input, { target: { value: '25' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onConfirm).toHaveBeenCalledWith('25')
    expect(useSketchEditorStore.getState().pendingDialog).toBeNull()
  })

  it('clears the error once the user edits the input', () => {
    openWith(vi.fn())
    render(<ContextMenuDialog />)

    const input = screen.getByDisplayValue('10') as HTMLInputElement
    fireEvent.change(input, { target: { value: '-1' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.queryByRole('alert')).toBeInTheDocument()

    fireEvent.change(input, { target: { value: '3' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('renders the extra action (Flip side) and runs it without validation, then closes', () => {
    const onConfirm = vi.fn()
    const onFlip = vi.fn()
    useSketchEditorStore.setState({
      pendingDialog: {
        position: [0, 0],
        label: 'Dimension value',
        defaultValue: '10',
        validate: () => 'always invalid',  // proves the flip path skips validation
        onConfirm,
        extraAction: { label: 'Flip side', onClick: onFlip },
      },
    })
    render(<ContextMenuDialog />)

    fireEvent.click(screen.getByText('Flip side'))

    expect(onFlip).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(useSketchEditorStore.getState().pendingDialog).toBeNull()
  })

  it('omits the extra action button when none is provided', () => {
    openWith(vi.fn())
    render(<ContextMenuDialog />)
    expect(screen.queryByText('Flip side')).not.toBeInTheDocument()
  })
})
