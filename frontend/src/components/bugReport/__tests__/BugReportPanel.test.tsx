import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import BugReportPanel from '@/components/bugReport/BugReportPanel'
import { backendBundle } from '@/adapters/backend'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useEditorState } from '@/hooks/useEditorState'
import { reportPick, useBugReportStore, type PickContext } from '@/stores/bugReportStore'
import type { PartFeature } from '@/types/cad'

const FEATURES: PartFeature[] = [
  { id: 'sk1', kind: 'sketch', label: 'Sketch 1' },
  { id: 'ex1', kind: 'extrude', label: 'Extrude 1', extrude: { sketch: '$sk1', distance: 10 } },
]

const CTX: PickContext = {
  rollback: 2,
  barFeatureId: 'ex1',
  editingFeatureId: null,
  features: FEATURES,
  partLabels: {},
}

function sentReport(send: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  return send.mock.calls[0][0] as Record<string, unknown>
}

function openEmpty() {
  useBugReportStore.getState().discard()
  useBugReportStore.getState().openReport([])
}

beforeEach(() => {
  vi.restoreAllMocks()
  openEmpty()
  usePartEditorStore.setState({
    features: FEATURES,
    doc: { version: 1, kind: 'part', features: FEATURES },
    undoStack: [],
    redoStack: [],
    partLabels: {},
  })
  useEditorState.setState({
    normalSelection: new Set<string>(),
    activePickField: null,
    modeStack: [],
    rollbackPosition: null,
    editingFeatureId: null,
  })
})

describe('BugReportPanel', () => {
  it('renders nothing when closed', () => {
    useBugReportStore.getState().close()
    render(<BugReportPanel canPick />)
    expect(screen.queryByText('Report a bug')).not.toBeInTheDocument()
  })

  // The whole point of the move off the modal dialog: the viewport keeps
  // receiving clicks while the report is open.
  it('is not modal and lets an outside click through', () => {
    const outside = vi.fn()
    const { container } = render(
      <div data-testid="outside" onClick={outside}>
        <BugReportPanel canPick />
      </div>,
    )
    expect(container.querySelector('.dialog-component-overlay')).toBeNull()
    fireEvent.click(screen.getByTestId('outside'))
    expect(outside).toHaveBeenCalledTimes(1)
  })

  // The part editor mounts this card in a pointer-events: none column. The
  // dialog shell does not opt back in, so its modal has to be portalled out of
  // that column or it is mouse-dead and its backdrop cannot stop the camera.
  it('portals its dialogs out of the pointer-events-none overlay column', () => {
    useBugReportStore.getState().setText({ title: 'Keep me' })
    const { container } = render(
      <div className="floating-right" style={{ pointerEvents: 'none' }}>
        <BugReportPanel canPick />
      </div>,
    )

    fireEvent.click(screen.getByText('Discard'))

    const dialog = document.querySelector('.dialog-component-overlay')
    expect(dialog).not.toBeNull()
    expect(container.contains(dialog)).toBe(false)
    expect(document.body.contains(dialog)).toBe(true)
  })

  it('refuses to submit without a title', async () => {
    const send = vi.spyOn(backendBundle.telemetry, 'send').mockResolvedValue()
    render(<BugReportPanel canPick />)
    fireEvent.click(screen.getByText('Submit'))
    expect(await screen.findByText('Title is required')).toBeInTheDocument()
    expect(send).not.toHaveBeenCalled()
  })

  it('sends the named selection sets, attachments and rollback bar', async () => {
    const send = vi.spyOn(backendBundle.telemetry, 'send').mockResolvedValue()
    useBugReportStore.getState().openReport(['edge-1'], CTX)
    useBugReportStore.getState().setText({ title: 'It broke', description: 'while extruding' })
    useEditorState.setState({ rollbackPosition: 3 })

    render(<BugReportPanel canPick />)
    fireEvent.click(screen.getByText('Submit'))

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(sentReport(send)).toMatchObject({
      title: 'It broke',
      description: 'while extruding',
      doc: { version: 1, kind: 'part' },
      rollback: 3,
      selectionSets: [{
        name: 'selection',
        picks: [{ query: 'edge-1', rollback: 2, barFeatureId: 'ex1' }],
      }],
    })
  })

  it('omits attachments the user unchecks but keeps the selection sets', async () => {
    const send = vi.spyOn(backendBundle.telemetry, 'send').mockResolvedValue()
    useBugReportStore.getState().setText({ title: 'No payload' })
    useBugReportStore.getState().addSet()

    render(<BugReportPanel canPick />)
    fireEvent.click(screen.getByLabelText(/Document/))
    fireEvent.click(screen.getByLabelText(/Edit history/))
    fireEvent.click(screen.getByText('Submit'))

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    const report = sentReport(send)
    expect(report).not.toHaveProperty('doc')
    expect(report).not.toHaveProperty('history')
    expect(report.selectionSets).toHaveLength(1)
  })

  it('sends the last N history entries with their labels when history is checked', async () => {
    const send = vi.spyOn(backendBundle.telemetry, 'send').mockResolvedValue()
    const undoStack = Array.from({ length: 7 }, (_, i) => ({
      doc: null,
      mutation: { type: 'set_rollback', position: i },
    }))
    usePartEditorStore.setState({ undoStack: undoStack as never })
    useBugReportStore.getState().setText({ title: 'With history' })
    useBugReportStore.getState().setAttachments({ historyCount: 3 })

    render(<BugReportPanel canPick />)
    fireEvent.click(screen.getByText('Submit'))

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    const history = sentReport(send).history as { mutation: { position: number }; label: string }[]
    expect(history).toHaveLength(3)
    expect(history.map(entry => entry.mutation.position)).toEqual([4, 5, 6])
    expect(history.every(entry => typeof entry.label === 'string' && entry.label.length > 0)).toBe(true)
  })

  it('reports a failed submit and keeps the panel open', async () => {
    vi.spyOn(backendBundle.telemetry, 'send').mockRejectedValue(new Error('offline'))
    useBugReportStore.getState().setText({ title: 'Will fail' })
    render(<BugReportPanel canPick />)
    fireEvent.click(screen.getByText('Submit'))

    expect(await screen.findByText(/Failed to submit/)).toBeInTheDocument()
    expect(screen.getByText('Report a bug')).toBeInTheDocument()
    expect(useBugReportStore.getState().open).toBe(true)
  })

  it('clears the draft after a successful submit so it cannot be re-sent', async () => {
    vi.spyOn(backendBundle.telemetry, 'send').mockResolvedValue()
    useBugReportStore.getState().setText({ title: 'One shot' })
    render(<BugReportPanel canPick />)
    fireEvent.click(screen.getByText('Submit'))

    await waitFor(() => expect(useBugReportStore.getState().open).toBe(false))
    expect(useBugReportStore.getState().title).toBe('')
    expect(screen.getByText('Bug report submitted successfully!')).toBeInTheDocument()
  })

  it('inserts a reference at the caret', () => {
    useBugReportStore.getState().addSet()
    const id = useBugReportStore.getState().sets[0].id
    useBugReportStore.getState().renameSet(id, 'before')
    useBugReportStore.getState().setText({ description: 'see  here' })

    render(<BugReportPanel canPick />)
    const textarea = screen.getByPlaceholderText('Description (what went wrong?)') as HTMLTextAreaElement
    textarea.setSelectionRange(4, 4)
    fireEvent.focus(textarea)
    fireEvent.click(screen.getByTitle('Insert reference'))

    expect(useBugReportStore.getState().description).toBe('see #before here')
  })

  it('appends a reference when the textarea was never focused', () => {
    useBugReportStore.getState().addSet()
    useBugReportStore.getState().setText({ description: 'see here' })

    render(<BugReportPanel canPick />)
    fireEvent.click(screen.getByTitle('Insert reference'))

    expect(useBugReportStore.getState().description).toBe('see here#set1')
  })

  it('warns about a token that names no set', () => {
    useBugReportStore.getState().setText({ description: 'see #missing' })
    render(<BugReportPanel canPick />)
    expect(screen.getByText('#missing names no selection set')).toBeInTheDocument()
  })

  it('turns a reference into a warning when its set is removed, without asking', () => {
    useBugReportStore.getState().addSet()
    useBugReportStore.getState().setText({ description: 'see #set1' })
    render(<BugReportPanel canPick />)
    fireEvent.click(screen.getByTitle('Remove selection set'))

    expect(useBugReportStore.getState().sets).toEqual([])
    expect(screen.getByText('#set1 names no selection set')).toBeInTheDocument()
  })

  it('shows a field refusal for a duplicate set name', () => {
    useBugReportStore.getState().addSet()
    useBugReportStore.getState().addSet()
    render(<BugReportPanel canPick />)
    const names = screen.getAllByLabelText('Selection set name')
    fireEvent.change(names[1], { target: { value: 'set1' } })
    fireEvent.blur(names[1])

    expect(screen.getByText('Value refused: name already used')).toBeInTheDocument()
    expect(useBugReportStore.getState().sets[1].name).toBe('set2')
  })

  it('disables picking outside the part editor with a note', () => {
    useBugReportStore.getState().addSet()
    render(<BugReportPanel canPick={false} />)
    expect(screen.getByText('Open a part to pick')).toBeInTheDocument()
    fireEvent.click(document.querySelector('.feature-pick-chip')!)
    expect(useEditorState.getState().activePickField).toBeNull()
  })

  it('disarms the pick field when the panel is closed while armed', () => {
    useBugReportStore.getState().addSet()
    const id = useBugReportStore.getState().sets[0].id
    render(<BugReportPanel canPick />)
    fireEvent.click(document.querySelector('.feature-pick-chip')!)
    expect(useEditorState.getState().activePickField?.featureId).toBe(`bug-report:${id}`)

    fireEvent.click(screen.getByLabelText('Close report'))
    expect(useEditorState.getState().activePickField).toBeNull()
  })

  it('disarms the pick field when the armed set is removed', () => {
    useBugReportStore.getState().addSet()
    const id = useBugReportStore.getState().sets[0].id
    render(<BugReportPanel canPick />)
    fireEvent.click(document.querySelector('.feature-pick-chip')!)
    expect(useEditorState.getState().activePickField?.featureId).toBe(`bug-report:${id}`)

    fireEvent.click(screen.getByTitle('Remove selection set'))
    expect(useEditorState.getState().activePickField).toBeNull()
  })

  it('dims a pick made at another rollback position and names where it came from', () => {
    useBugReportStore.getState().addSet()
    const id = useBugReportStore.getState().sets[0].id
    useBugReportStore.getState().addPick(id, reportPick('@body_ex1', { ...CTX, rollback: 5, barFeatureId: 'ex1' }))
    useEditorState.setState({ rollbackPosition: 3 })

    render(<BugReportPanel canPick />)
    const item = document.querySelector('.feature-pick-chip-item')!
    expect(item.classList.contains('inactive')).toBe(true)
    expect(item.getAttribute('title')).toMatch(/picked after ex1/i)
  })

  it('asks before discarding a non-empty draft and keeps it when refused', () => {
    useBugReportStore.getState().setText({ title: 'Keep me' })
    render(<BugReportPanel canPick />)
    fireEvent.click(screen.getByText('Discard'))
    expect(screen.getByText('Discard bug report')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Keep editing'))
    expect(useBugReportStore.getState().title).toBe('Keep me')
    expect(useBugReportStore.getState().open).toBe(true)
  })
})
