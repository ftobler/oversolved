import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import ExportDialog from '@/components/dialogs/ExportDialog'
import { backdropClick } from '@/components/dialogs/__tests__/backdropGesture'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('ExportDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders nothing when closed', () => {
    const { container } = render(
      <ExportDialog isOpen={false} defaultName="part" onDownload={vi.fn()} onCancel={vi.fn()} />
    )
    expect(container).toBeEmptyDOMElement()
  })

  // The dialog used to carry a hand-rolled overlay, header and button pair. It
  // must keep using the shared shell so its chrome cannot drift again.
  it('renders in the shared dialog shell with a topic icon', () => {
    const { container } = render(
      <ExportDialog isOpen defaultName="part" onDownload={vi.fn()} onCancel={vi.fn()} />
    )
    expect(container.querySelector('.dialog-component-overlay')).toBeInTheDocument()
    expect(container.querySelector('.dialog-component-icon')).toHaveTextContent('download')
    expect(screen.getByRole('button', { name: 'Download' })).toHaveClass('btn', 'btn-primary')
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveClass('btn', 'btn-secondary')
  })

  it('passes format, tessellation and filename to onDownload', async () => {
    const onDownload = vi.fn()
    render(<ExportDialog isOpen defaultName="part" onDownload={onDownload} onCancel={vi.fn()} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    })
    expect(onDownload).toHaveBeenCalledWith('step', 0, 'part.step')
  })

  it('swaps the file extension when the format changes', async () => {
    const onDownload = vi.fn()
    render(<ExportDialog isOpen defaultName="part" onDownload={onDownload} onCancel={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('STL'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    })
    expect(onDownload).toHaveBeenCalledWith('stl', 0.5, 'part.stl')
  })

  it('exports YAML without a tessellation detail control', async () => {
    const onDownload = vi.fn()
    render(<ExportDialog isOpen defaultName="part" onDownload={onDownload} onCancel={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('STL'))
    fireEvent.click(screen.getByLabelText('YAML'))
    expect(screen.queryByText('Tessellation Detail')).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    })
    expect(onDownload).toHaveBeenCalledWith('yaml', 0, 'part.yaml')
  })

  it('seeds the file name from the document name when it opens', async () => {
    const props = { onDownload: vi.fn(), onCancel: vi.fn() }
    const { rerender } = render(<ExportDialog isOpen={false} defaultName="export" {...props} />)

    // The dialog outlives a single export, so it is mounted before the document
    // name is known: the name must land on the field when it is opened.
    rerender(<ExportDialog isOpen defaultName="motor mount" {...props} />)
    expect(screen.getByDisplayValue('motor_mount.step')).toBeInTheDocument()
  })

  it('keeps an edited file name while the dialog stays open', async () => {
    const props = { onDownload: vi.fn(), onCancel: vi.fn() }
    const { rerender } = render(<ExportDialog isOpen defaultName="motor mount" {...props} />)

    fireEvent.change(screen.getByDisplayValue('motor_mount.step'), { target: { value: 'custom.step' } })
    rerender(<ExportDialog isOpen defaultName="motor mount" {...props} />)
    expect(screen.getByDisplayValue('custom.step')).toBeInTheDocument()
  })

  it('re-adds the extension when the user deleted it', async () => {
    const onDownload = vi.fn()
    render(<ExportDialog isOpen defaultName="part" onDownload={onDownload} onCancel={vi.fn()} />)

    fireEvent.change(screen.getByDisplayValue('part.step'), { target: { value: 'bracket' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    })

    expect(onDownload).toHaveBeenCalledWith('step', 0, 'bracket.step')
    expect(screen.getByDisplayValue('bracket.step')).toBeInTheDocument()
  })

  it('shows a wait state and freezes the controls while the export runs', async () => {
    const gate = deferred<void>()
    const onDownload = vi.fn(() => gate.promise)
    const onCancel = vi.fn()
    render(<ExportDialog isOpen defaultName="part" onDownload={onDownload} onCancel={onCancel} />)

    fireEvent.click(screen.getByRole('button', { name: 'Download' }))

    const busyButton = await screen.findByRole('button', { name: /Generating/ })
    expect(busyButton).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /close/i })).toBeDisabled()
    expect(screen.getByLabelText('STL')).toBeDisabled()

    await act(async () => {
      gate.resolve()
      await gate.promise
    })

    await waitFor(() => expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled())
  })

  it('ignores repeated download clicks while exporting', async () => {
    const gate = deferred<void>()
    const onDownload = vi.fn(() => gate.promise)
    render(<ExportDialog isOpen defaultName="part" onDownload={onDownload} onCancel={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    await screen.findByRole('button', { name: /Generating/ })
    fireEvent.click(screen.getByRole('button', { name: /Generating/ }))

    expect(onDownload).toHaveBeenCalledTimes(1)

    await act(async () => {
      gate.resolve()
      await gate.promise
    })
  })

  it('does not cancel via the overlay while exporting', async () => {
    const gate = deferred<void>()
    const onCancel = vi.fn()
    const { container } = render(
      <ExportDialog isOpen defaultName="part" onDownload={() => gate.promise} onCancel={onCancel} />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    await screen.findByRole('button', { name: /Generating/ })

    backdropClick(container.querySelector('.dialog-component-overlay') as Element)
    expect(onCancel).not.toHaveBeenCalled()

    await act(async () => {
      gate.resolve()
      await gate.promise
    })

    backdropClick(container.querySelector('.dialog-component-overlay') as Element)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('clears the wait state when the export fails', async () => {
    const gate = deferred<void>()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // The parent surfaces the error toast; the dialog must not stay stuck busy.
    render(<ExportDialog isOpen defaultName="part" onDownload={() => gate.promise} onCancel={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    await screen.findByRole('button', { name: /Generating/ })

    await act(async () => {
      gate.reject(new Error('kernel exploded'))
      await gate.promise.catch(() => {})
    })

    await waitFor(() => expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled())
  })
})
