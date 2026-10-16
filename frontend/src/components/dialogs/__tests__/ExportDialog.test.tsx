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

const EVERYTHING = { mode: 'everything', selectedIds: [] } as const

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

  it('passes the format, the normal preset and the filename to onDownload', async () => {
    const onDownload = vi.fn()
    render(<ExportDialog isOpen defaultName="part" onDownload={onDownload} onCancel={vi.fn()} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    })
    expect(onDownload).toHaveBeenCalledWith({
      format: 'step', tessellation: 'normal', fileName: 'part.step', selection: EVERYTHING,
    })
  })

  it('swaps the file extension and keeps the normal preset when the format changes', async () => {
    const onDownload = vi.fn()
    render(<ExportDialog isOpen defaultName="part" onDownload={onDownload} onCancel={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('STL'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    })
    expect(onDownload).toHaveBeenCalledWith({
      format: 'stl', tessellation: 'normal', fileName: 'part.stl', selection: EVERYTHING,
    })
  })

  // The three presets replace the old free slider: no fourth value is reachable.
  it('offers exactly fine, normal and coarse for STL and forwards the pick', async () => {
    const onDownload = vi.fn()
    render(<ExportDialog isOpen defaultName="part" onDownload={onDownload} onCancel={vi.fn()} />)

    expect(screen.queryByLabelText('Fine')).toBeNull()  // STEP carries no mesh
    fireEvent.click(screen.getByLabelText('STL'))
    expect(screen.getByLabelText('Fine')).toBeInTheDocument()
    expect(screen.getByLabelText('Normal')).toBeInTheDocument()
    expect(screen.getByLabelText('Coarse')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Coarse'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    })
    expect(onDownload).toHaveBeenCalledWith({
      format: 'stl', tessellation: 'coarse', fileName: 'part.stl', selection: EVERYTHING,
    })
  })

  it('exports YAML without a tessellation control', async () => {
    const onDownload = vi.fn()
    render(<ExportDialog isOpen defaultName="part" onDownload={onDownload} onCancel={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('STL'))
    fireEvent.click(screen.getByLabelText('YAML'))
    expect(screen.queryByLabelText('Fine')).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    })
    expect(onDownload).toHaveBeenCalledWith({
      format: 'yaml', tessellation: 'normal', fileName: 'part.yaml', selection: EVERYTHING,
    })
  })

  it('offers only the given formats and starts on the first of them', async () => {
    const onDownload = vi.fn()
    render(<ExportDialog isOpen defaultName="gearbox" formats={['yaml']} onDownload={onDownload} onCancel={vi.fn()} />)

    expect(screen.queryByLabelText('STEP')).toBeNull()
    expect(screen.queryByLabelText('STL')).toBeNull()
    expect(screen.getByDisplayValue('gearbox.yaml')).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download' }))
    })
    expect(onDownload).toHaveBeenCalledWith({
      format: 'yaml', tessellation: 'normal', fileName: 'gearbox.yaml', selection: EVERYTHING,
    })
  })

  it('falls back to an offered format when reopened with a narrower set', async () => {
    const props = { onDownload: vi.fn(), onCancel: vi.fn() }
    const { rerender } = render(<ExportDialog isOpen defaultName="bracket" {...props} />)
    rerender(<ExportDialog isOpen={false} defaultName="bracket" {...props} />)

    // One mounted dialog serves every row of the workspace list, so the format
    // picked for a part must not survive into an assembly that cannot offer it.
    rerender(<ExportDialog isOpen defaultName="gearbox" formats={['yaml']} {...props} />)
    expect(screen.getByDisplayValue('gearbox.yaml')).toBeInTheDocument()
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

    expect(onDownload).toHaveBeenCalledWith({
      format: 'step', tessellation: 'normal', fileName: 'bracket.step', selection: EVERYTHING,
    })
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

// Choosing what to export: the parts section appears only when the caller can
// offer more than one part, and the chosen mode/ticks ride the request.
describe('ExportDialog parts selection', () => {
  const PARTS = [
    { id: 'h1', name: 'Bracket' },
    { id: 'h2', name: 'Bracket' },
    { id: 'h3', name: 'Plate' },
  ]

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  const download = () => fireEvent.click(screen.getByRole('button', { name: 'Download' }))

  it('hides the parts controls for a single-part caller', () => {
    render(
      <ExportDialog isOpen defaultName="part" parts={[{ id: 'a', name: 'A' }]} onDownload={vi.fn()} onCancel={vi.fn()} />
    )
    expect(screen.queryByText('Parts')).toBeNull()
  })

  it('defaults to everything: all parts ticked and one file, unchanged from before', async () => {
    const onDownload = vi.fn()
    render(<ExportDialog isOpen defaultName="asm" parts={PARTS} onDownload={onDownload} onCancel={vi.fn()} />)

    expect(screen.getAllByText('Bracket')).toHaveLength(2)
    expect(screen.getByText('Plate')).toBeInTheDocument()
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes).toHaveLength(3)
    expect(boxes.every(box => box.checked && box.disabled)).toBe(true)

    await act(async () => { download() })
    expect(onDownload).toHaveBeenCalledWith({
      format: 'step', tessellation: 'normal', fileName: 'asm.step',
      selection: { mode: 'everything', selectedIds: [] },
    })
  })

  it('selected mode forwards only the ticked ids', async () => {
    const onDownload = vi.fn()
    render(<ExportDialog isOpen defaultName="asm" parts={PARTS} onDownload={onDownload} onCancel={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('Selected parts'))
    // Switching to selected starts from the whole list; untick Plate.
    fireEvent.click(screen.getByLabelText('Plate'))
    await act(async () => { download() })

    expect(onDownload).toHaveBeenCalledWith({
      format: 'step', tessellation: 'normal', fileName: 'asm.step',
      selection: { mode: 'selected', selectedIds: ['h1', 'h2'] },
    })
  })

  it('separate mode forwards the mode and the ticks', async () => {
    const onDownload = vi.fn()
    render(<ExportDialog isOpen defaultName="asm" parts={PARTS} onDownload={onDownload} onCancel={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('Each part separately'))
    await act(async () => { download() })

    expect(onDownload).toHaveBeenCalledWith({
      format: 'step', tessellation: 'normal', fileName: 'asm.step',
      selection: { mode: 'separate', selectedIds: ['h1', 'h2', 'h3'] },
    })
  })

  it('disables the export button when nothing is ticked', () => {
    render(<ExportDialog isOpen defaultName="asm" parts={PARTS} onDownload={vi.fn()} onCancel={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('Selected parts'))
    for (const box of screen.getAllByLabelText('Bracket')) fireEvent.click(box)
    fireEvent.click(screen.getByLabelText('Plate'))

    expect(screen.getByRole('button', { name: 'Download' })).toBeDisabled()
  })
})
