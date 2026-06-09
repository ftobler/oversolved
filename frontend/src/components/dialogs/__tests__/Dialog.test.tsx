import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import Dialog from '@/components/dialogs/Dialog'

describe('Dialog', () => {
  it('renders when isOpen is true', () => {
    render(
      <Dialog isOpen title="Test Dialog" onClose={vi.fn()}>
        <p>Dialog content</p>
      </Dialog>
    )
    expect(screen.getByText('Test Dialog')).toBeInTheDocument()
    expect(screen.getByText('Dialog content')).toBeInTheDocument()
  })

  it('does not render when isOpen is false', () => {
    render(
      <Dialog isOpen={false} title="Test Dialog" onClose={vi.fn()}>
        <p>Dialog content</p>
      </Dialog>
    )
    expect(screen.queryByText('Test Dialog')).not.toBeInTheDocument()
  })

  it('calls onClose when overlay is clicked', () => {
    const onClose = vi.fn()
    const { container } = render(
      <Dialog isOpen title="Test Dialog" onClose={onClose}>
        <p>Dialog content</p>
      </Dialog>
    )
    const overlay = container.querySelector('.dialog-component-overlay')
    fireEvent.click(overlay!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onConfirm when confirm button is clicked', () => {
    const onConfirm = vi.fn()
    render(
      <Dialog isOpen title="Test Dialog" onClose={vi.fn()} onConfirm={onConfirm} confirmLabel="Save">
        <p>Dialog content</p>
      </Dialog>
    )
    const confirmBtn = screen.getByText('Save')
    fireEvent.click(confirmBtn)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('disables confirm button when confirmDisabled is true', () => {
    render(
      <Dialog isOpen title="Test Dialog" onClose={vi.fn()} onConfirm={vi.fn()} confirmDisabled>
        <p>Dialog content</p>
      </Dialog>
    )
    const confirmBtn = screen.getByText('Confirm')
    expect(confirmBtn).toBeDisabled()
  })

  it('uses custom cancel label', () => {
    render(
      <Dialog isOpen title="Test Dialog" onClose={vi.fn()} onConfirm={vi.fn()} cancelLabel="Close">
        <p>Dialog content</p>
      </Dialog>
    )
    expect(screen.getByText('Close')).toBeInTheDocument()
  })

  it('does not show confirm buttons when onConfirm is not provided', () => {
    render(
      <Dialog isOpen title="Test Dialog" onClose={vi.fn()}>
        <p>Dialog content</p>
      </Dialog>
    )
    expect(screen.queryByText('Confirm')).not.toBeInTheDocument()
    expect(screen.queryByText('Cancel')).not.toBeInTheDocument()
  })
})
