import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import MessageDialog from '@/components/dialogs/MessageDialog'

describe('MessageDialog', () => {
  it('renders in the shared dialog shell', () => {
    const { container } = render(
      <MessageDialog isOpen title="Heads up" message="Something happened" onClose={vi.fn()} />
    )
    expect(container.querySelector('.dialog-component.message-dialog')).toBeInTheDocument()
    expect(screen.getByText('Heads up')).toBeInTheDocument()
    expect(screen.getByText('Something happened')).toBeInTheDocument()
  })

  it('does not render when closed', () => {
    const { container } = render(
      <MessageDialog isOpen={false} title="Heads up" message="Hi" onClose={vi.fn()} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  // The tint is the one thing the shell refuses to do for itself, so it is the
  // thing most likely to be lost in a refactor.
  it.each([
    ['info', 'info'],
    ['success', 'check_circle'],
    ['error', 'error'],
  ] as const)('gives the %s variant its own icon and tint class', (variant, ligature) => {
    const { container } = render(
      <MessageDialog isOpen title="T" message="m" variant={variant} onClose={vi.fn()} />
    )
    expect(container.querySelector(`.message-dialog-${variant}`)).toBeInTheDocument()
    expect(container.querySelector('.dialog-component-icon')).toHaveTextContent(ligature)
  })

  it('is a lone OK that closes when there is nothing to confirm', () => {
    const onClose = vi.fn()
    render(<MessageDialog isOpen title="T" message="m" onClose={onClose} />)

    expect(screen.queryByText('Cancel')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('offers confirm and cancel when a confirm handler is given', () => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    render(
      <MessageDialog isOpen title="T" message="m" onConfirm={onConfirm} confirmLabel="Delete" onClose={onClose} />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('drops the cancel button in confirm-only mode', () => {
    render(
      <MessageDialog isOpen title="T" message="m" onConfirm={vi.fn()} showCancel={false} onClose={vi.fn()} />
    )
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument()
    expect(screen.queryByText('Cancel')).not.toBeInTheDocument()
  })

  it('focuses the action so Enter and Space land on it', () => {
    render(<MessageDialog isOpen title="T" message="m" onClose={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'OK' })).toHaveFocus()
  })

  it('confirms on Enter, and closes on Enter when there is no confirm', () => {
    const onConfirm = vi.fn()
    const { unmount } = render(
      <MessageDialog isOpen title="T" message="m" onConfirm={onConfirm} onClose={vi.fn()} />
    )
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onConfirm).toHaveBeenCalledTimes(1)
    unmount()

    const onClose = vi.fn()
    render(<MessageDialog isOpen title="T" message="m" onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // Escape must never count as acknowledgement: DisclaimerDialog distinguishes
  // the two, and only OK sets its cookie.
  it('closes on Escape without confirming', () => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    render(<MessageDialog isOpen title="T" message="m" onConfirm={onConfirm} onClose={onClose} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  // A resolution already handed to the store cannot be recalled, so a busy
  // message box has to go as dead as the shell it is built on: every button,
  // and the Enter it binds for itself.
  it('disables every action while busy', () => {
    render(
      <MessageDialog
        isOpen
        title="T"
        message="m"
        onConfirm={vi.fn()}
        confirmLabel="Reload"
        extraAction={{ label: 'Save over', onClick: vi.fn() }}
        onClose={vi.fn()}
        busy
      />
    )
    expect(screen.getByRole('button', { name: 'Reload' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Save over' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  })

  it('ignores Enter and Escape while busy', () => {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    render(
      <MessageDialog isOpen title="T" message="m" onConfirm={onConfirm} onClose={onClose} busy />
    )

    fireEvent.keyDown(window, { key: 'Enter' })
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onConfirm).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('keeps a caller class alongside the variant class', () => {
    const { container } = render(
      <MessageDialog isOpen title="T" message="m" className="disclaimer-dialog" onClose={vi.fn()} />
    )
    const box = container.querySelector('.dialog-component')
    expect(box).toHaveClass('message-dialog', 'message-dialog-info', 'disclaimer-dialog')
  })
})
