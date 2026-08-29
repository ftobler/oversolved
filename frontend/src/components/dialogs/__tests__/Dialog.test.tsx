import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import Dialog from '@/components/dialogs/Dialog'
import { backdropClick } from '@/components/dialogs/__tests__/backdropGesture'

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
    backdropClick(overlay!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('stays open when a drag that started inside is released on the overlay', () => {
    // The reported bug: selecting text in a field and letting go past the
    // dialog edge fires `click` on the overlay, which used to discard the form.
    const onClose = vi.fn()
    const { container } = render(
      <Dialog isOpen title="Test Dialog" onClose={onClose}>
        <input aria-label="Title" defaultValue="half typed" />
      </Dialog>
    )
    const overlay = container.querySelector('.dialog-component-overlay')!

    fireEvent.pointerDown(screen.getByLabelText('Title'))
    fireEvent.pointerUp(overlay)
    fireEvent.click(overlay)

    expect(onClose).not.toHaveBeenCalled()
  })

  it('stays open when a drag that started on the overlay is released inside', () => {
    const onClose = vi.fn()
    const { container } = render(
      <Dialog isOpen title="Test Dialog" onClose={onClose}>
        <p>Dialog content</p>
      </Dialog>
    )
    const overlay = container.querySelector('.dialog-component-overlay')!

    fireEvent.pointerDown(overlay)
    fireEvent.pointerUp(screen.getByText('Dialog content'))
    fireEvent.click(overlay)

    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not carry a refused gesture over into the next backdrop click', () => {
    const onClose = vi.fn()
    const { container } = render(
      <Dialog isOpen title="Test Dialog" onClose={onClose}>
        <p>Dialog content</p>
      </Dialog>
    )
    const overlay = container.querySelector('.dialog-component-overlay')!

    fireEvent.pointerDown(screen.getByText('Dialog content'))
    fireEvent.pointerUp(overlay)
    fireEvent.click(overlay)
    expect(onClose).not.toHaveBeenCalled()

    backdropClick(overlay)
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

  it('seals every exit while busy', () => {
    const onClose = vi.fn()
    const { container } = render(
      <Dialog isOpen title="Test Dialog" onClose={onClose} onConfirm={vi.fn()} busy>
        <p>Dialog content</p>
      </Dialog>
    )

    backdropClick(container.querySelector('.dialog-component-overlay')!)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(onClose).not.toHaveBeenCalled()

    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /close/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled()
  })

  it('closes on Escape, but not while busy', () => {
    const onClose = vi.fn()
    const { rerender } = render(
      <Dialog isOpen title="Test Dialog" onClose={onClose} busy>
        <p>Dialog content</p>
      </Dialog>
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()

    rerender(
      <Dialog isOpen title="Test Dialog" onClose={onClose}>
        <p>Dialog content</p>
      </Dialog>
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // Enter belongs to the callers: a dialog owning a textarea would submit on a
  // newline if the shell bound it.
  it('leaves Enter alone', () => {
    const onConfirm = vi.fn()
    render(
      <Dialog isOpen title="Test Dialog" onClose={vi.fn()} onConfirm={onConfirm}>
        <p>Dialog content</p>
      </Dialog>
    )
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('drops the cancel button when showCancel is false', () => {
    render(
      <Dialog isOpen title="Test Dialog" onClose={vi.fn()} onConfirm={vi.fn()} showCancel={false}>
        <p>Dialog content</p>
      </Dialog>
    )
    expect(screen.getByText('Confirm')).toBeInTheDocument()
    expect(screen.queryByText('Cancel')).not.toBeInTheDocument()
  })

  it('focuses the confirm button only when asked', () => {
    const { unmount } = render(
      <Dialog isOpen title="Test Dialog" onClose={vi.fn()} onConfirm={vi.fn()}>
        <p>Dialog content</p>
      </Dialog>
    )
    expect(screen.getByText('Confirm')).not.toHaveFocus()
    unmount()

    render(
      <Dialog isOpen title="Test Dialog" onClose={vi.fn()} onConfirm={vi.fn()} autoFocusConfirm>
        <p>Dialog content</p>
      </Dialog>
    )
    expect(screen.getByText('Confirm')).toHaveFocus()
  })

  it('appends a caller class to the content box', () => {
    const { container } = render(
      <Dialog isOpen title="Test Dialog" onClose={vi.fn()} className="wide-dialog">
        <p>Dialog content</p>
      </Dialog>
    )
    expect(container.querySelector('.dialog-component')).toHaveClass('wide-dialog')
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

  // The third choice, for dialogs whose decision is not binary (leaving with
  // unsaved edits: save, discard, or stay).
  it('renders an extra action beside confirm and cancel', () => {
    const extra = vi.fn()
    render(
      <Dialog isOpen title="Test Dialog" onClose={vi.fn()} onConfirm={vi.fn()}
              extraAction={{ label: 'Third', onClick: extra }}>
        <p>Dialog content</p>
      </Dialog>
    )
    fireEvent.click(screen.getByText('Third'))
    expect(extra).toHaveBeenCalled()
    expect(screen.getByText('Confirm')).toBeInTheDocument()
    expect(screen.getByText('Cancel')).toBeInTheDocument()
  })

  it('omits the extra action when none is given', () => {
    render(
      <Dialog isOpen title="Test Dialog" onClose={vi.fn()} onConfirm={vi.fn()}>
        <p>Dialog content</p>
      </Dialog>
    )
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument()
    expect(document.querySelectorAll('.dialog-component-buttons button')).toHaveLength(2)
  })
})
