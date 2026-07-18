import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import BugReportDialog from '@/components/dialogs/BugReportDialog'
import { backendBundle } from '@/adapters/backend'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

function fillTitle(text: string) {
  fireEvent.change(screen.getByPlaceholderText('Title'), { target: { value: text } })
}

describe('BugReportDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    usePartEditorStore.setState({ undoStack: [], redoStack: [], doc: null })
    useSketchEditorStore.setState({ normalSelection: new Set<string>() })
  })

  it('renders nothing when closed', () => {
    render(<BugReportDialog isOpen={false} onClose={vi.fn()} />)
    expect(screen.queryByText('Report a Bug')).not.toBeInTheDocument()
  })

  it('renders as a dialog, not inside the debug drawer', () => {
    const { container } = render(<BugReportDialog isOpen onClose={vi.fn()} />)
    expect(screen.getByText('Report a Bug')).toBeInTheDocument()
    expect(container.querySelector('.dialog-component-overlay')).toBeInTheDocument()
    expect(container.querySelector('.debug-drawer')).not.toBeInTheDocument()
  })

  // The header icon must stay a plain glyph: MessageDialog tints its icon per
  // variant to signal info/success/error, and a bug report is none of those.
  it('shows an untinted bug icon in the header', () => {
    const { container } = render(<BugReportDialog isOpen onClose={vi.fn()} />)
    const icon = container.querySelector('.dialog-component-icon')
    expect(icon).toHaveTextContent('bug_report')
    expect(icon?.className).not.toMatch(/message-dialog-icon-/)
  })

  it('refuses to submit without a title', async () => {
    const send = vi.spyOn(backendBundle.telemetry, 'send').mockResolvedValue()
    render(<BugReportDialog isOpen onClose={vi.fn()} />)
    fireEvent.click(screen.getByText('Submit Report'))
    expect(await screen.findByText('Title is required')).toBeInTheDocument()
    expect(send).not.toHaveBeenCalled()
  })

  it('sends the report with the checked attachments and closes', async () => {
    const send = vi.spyOn(backendBundle.telemetry, 'send').mockResolvedValue()
    const onClose = vi.fn()
    usePartEditorStore.setState({ doc: { features: [] } })
    useSketchEditorStore.setState({ normalSelection: new Set(['edge-1']) })

    render(<BugReportDialog isOpen onClose={onClose} />)
    fillTitle('It broke')
    fireEvent.change(screen.getByPlaceholderText('Description (what went wrong?)'), {
      target: { value: 'while extruding' },
    })
    fireEvent.click(screen.getByText('Submit Report'))

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0][0]).toMatchObject({
      title: 'It broke',
      description: 'while extruding',
      ast: { features: [] },
      selection: ['edge-1'],
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('omits attachments the user unchecks', async () => {
    const send = vi.spyOn(backendBundle.telemetry, 'send').mockResolvedValue()
    render(<BugReportDialog isOpen onClose={vi.fn()} />)
    fillTitle('No payload')
    fireEvent.click(screen.getByLabelText(/AST/))
    fireEvent.click(screen.getByLabelText(/Selection/))
    fireEvent.click(screen.getByLabelText(/Edit history/))
    fireEvent.click(screen.getByText('Submit Report'))

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    const report = send.mock.calls[0][0]
    expect(report).not.toHaveProperty('ast')
    expect(report).not.toHaveProperty('selection')
    expect(report).not.toHaveProperty('history')
  })

  it('reports a failed submit and keeps the dialog open', async () => {
    vi.spyOn(backendBundle.telemetry, 'send').mockRejectedValue(new Error('offline'))
    const onClose = vi.fn()
    render(<BugReportDialog isOpen onClose={onClose} />)
    fillTitle('Will fail')
    fireEvent.click(screen.getByText('Submit Report'))

    expect(await screen.findByText(/Failed to submit/)).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('clears the draft after a successful submit so it cannot be re-sent', async () => {
    vi.spyOn(backendBundle.telemetry, 'send').mockResolvedValue()
    render(<BugReportDialog isOpen onClose={vi.fn()} />)
    fillTitle('One shot')
    fireEvent.click(screen.getByText('Submit Report'))

    await waitFor(() => expect(screen.getByPlaceholderText('Title')).toHaveValue(''))
  })
})
