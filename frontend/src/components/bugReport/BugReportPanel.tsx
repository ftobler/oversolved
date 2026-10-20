import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { backendBundle } from '@/adapters/backend'
import MessageDialog from '@/components/dialogs/MessageDialog'
import { SelectionSetRow } from '@/components/bugReport/SelectionSetRow'
import { useEditorState, editorState } from '@/hooks/useEditorState'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { isDraftEmpty, useBugReportStore } from '@/stores/bugReportStore'
import { describeMutation } from '@/utils/core/mutationDescriptions'
import { insertReference, unknownReferences } from '@/utils/core/reportReferences'
import type { Mutation } from '@/types/cad'
import '@/components/layout/Glass.css'
import '@/components/bugReport/BugReportPanel.css'

type UndoEntry = { doc: unknown; mutation: Mutation }

interface BugReportPanelProps {
  // True inside the part editor, where the viewport is live and a set's chip
  // can arm the pick field. Outside it the sets stay visible and editable, but
  // there is no document to pick in.
  canPick?: boolean
  // The right-overlay mount sits in the editor's card column; the header mount
  // is a fixed card over whatever page is showing.
  placement?: 'overlay' | 'header'
}

/**
 * The bug report as a non-modal floating card, like the feature editor. The
 * viewport stays usable while it is open: picking a set's chip arms the normal
 * pick field, the rollback bar keeps working, and the draft lives in the store
 * so closing the panel (or walking to another part) does not lose it.
 */
export default function BugReportPanel({ canPick = false, placement = 'overlay' }: BugReportPanelProps) {
  const open = useBugReportStore(s => s.open)
  const title = useBugReportStore(s => s.title)
  const description = useBugReportStore(s => s.description)
  const sets = useBugReportStore(s => s.sets)
  const attachments = useBugReportStore(s => s.attachments)
  const setText = useBugReportStore(s => s.setText)
  const setAttachments = useBugReportStore(s => s.setAttachments)
  const addSet = useBugReportStore(s => s.addSet)
  const close = useBugReportStore(s => s.close)
  const discard = useBugReportStore(s => s.discard)

  const rollback = useEditorState(s => s.rollbackPosition)
  const features = usePartEditorStore(s => s.features)
  const partLabels = usePartEditorStore(s => s.partLabels)
  const undoStack = usePartEditorStore(s => s.undoStack) as UndoEntry[]
  const doc = usePartEditorStore(s => s.doc)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const pendingCaret = useRef<number | null>(null)
  // Null until the user has put the caret in the textarea. An unfocused
  // textarea reports selectionStart 0, which would prepend the reference to an
  // existing description; an untouched field appends instead.
  const caretRef = useRef<{ start: number; end: number } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  // Focus and caret land after React has painted the new description; doing it
  // inside the click handler would target the pre-insert value.
  useEffect(() => {
    const caret = pendingCaret.current
    if (caret === null || !textareaRef.current) return
    pendingCaret.current = null
    textareaRef.current.focus()
    textareaRef.current.setSelectionRange(caret, caret)
  }, [description])

  const rememberCaret = () => {
    const element = textareaRef.current
    if (!element) return
    caretRef.current = { start: element.selectionStart, end: element.selectionEnd }
  }

  const insertAtCaret = (name: string) => {
    const caret = caretRef.current ?? { start: description.length, end: description.length }
    const next = insertReference(description, name, caret.start, caret.end)
    setText({ description: next.text })
    caretRef.current = { start: next.caret, end: next.caret }
    pendingCaret.current = next.caret
  }

  const handleSubmit = async () => {
    if (submitting) return
    const state = useBugReportStore.getState()
    if (!state.title.trim()) {
      setError('Title is required')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const report: Record<string, unknown> = {
        title: state.title,
        description: state.description,
        // The bar the attached document was saved at, so a triager can reopen
        // the same partial build.
        rollback: editorState.getState().rollbackPosition,
        selectionSets: state.sets.map(set => ({
          name: set.name,
          picks: set.picks.map(pick => ({ ...pick })),
        })),
      }
      if (state.attachments.doc) report.doc = doc
      if (state.attachments.history) {
        const history = usePartEditorStore.getState().undoStack as UndoEntry[]
        report.history = history.slice(-state.attachments.historyCount).map(entry => ({
          mutation: entry.mutation,
          label: describeMutation(entry.mutation),
        }))
      }
      await backendBundle.telemetry.send(report)
      // A sent report must not reappear in the next one.
      discard()
      setSuccess(true)
    } catch (e) {
      setError(`Failed to submit: ${e}`)
    } finally {
      setSubmitting(false)
    }
  }

  const requestDiscard = () => {
    if (isDraftEmpty(useBugReportStore.getState())) {
      discard()
      return
    }
    setConfirmDiscard(true)
  }

  const unknown = unknownReferences(description, sets.map(s => s.name))
  const anyPicks = sets.some(s => s.picks.length > 0)

  // The part editor mounts this panel in `.floating-right`, whose column is
  // pointer-events: none so the gaps orbit and pick. The shared Dialog shell
  // does not opt back in, so a dialog left in that column would be mouse-dead
  // and its backdrop would not stop the camera. Portals put both dialogs in
  // the document body, outside every overlay.
  const dialogs = (
    <>
      <MessageDialog
        isOpen={success}
        title="Bug Report"
        message="Bug report submitted successfully!"
        variant="success"
        onClose={() => setSuccess(false)}
      />

      <MessageDialog
        isOpen={confirmDiscard}
        title="Discard bug report"
        message="The report draft and its picked selection sets will be lost."
        variant="error"
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        onConfirm={() => { setConfirmDiscard(false); discard() }}
        onClose={() => setConfirmDiscard(false)}
      />
    </>
  )

  return (
    <>
      {open && (
        <div
          className={`glass-panel bug-report-panel${placement === 'header' ? ' bug-report-panel--header' : ''}`}
        >
          <div className="bug-report-panel-header">
            <span className="material-icons-outlined bug-report-icon">bug_report</span>
            <span className="bug-report-panel-title">Report a bug</span>
            <button
              type="button"
              className="bug-report-submit"
              onClick={handleSubmit}
              disabled={submitting}
            >
              {submitting ? 'Submitting...' : 'Submit'}
            </button>
            <button
              type="button"
              className="bug-report-discard"
              onClick={requestDiscard}
              disabled={submitting}
            >
              Discard
            </button>
            <button
              type="button"
              className="bug-report-close"
              title="Close"
              aria-label="Close report"
              onClick={() => { setError(null); close() }}
              disabled={submitting}
            >
              ×
            </button>
          </div>

          <div className="bug-report-panel-body">
            <input
              type="text"
              className="bug-report-title-input"
              placeholder="Title"
              aria-label="Title"
              value={title}
              onChange={e => setText({ title: e.target.value })}
              disabled={submitting}
            />
            <textarea
              ref={textareaRef}
              className="bug-report-textarea"
              placeholder="Description (what went wrong?)"
              aria-label="Description"
              value={description}
              onChange={e => { setText({ description: e.target.value }); rememberCaret() }}
              onFocus={rememberCaret}
              onSelect={rememberCaret}
              onKeyUp={rememberCaret}
              onClick={rememberCaret}
              disabled={submitting}
            />
            {unknown.map(name => (
              <div key={name} className="bug-report-warning">
                #{name} names no selection set
              </div>
            ))}
            {error && <div className="bug-report-error">{error}</div>}

            <div className="bug-report-sets-title">Selection sets</div>
            {!canPick && <div className="bug-report-pick-note">Open a part to pick</div>}
            <div className="bug-report-sets">
              {sets.map(set => (
                <SelectionSetRow
                  key={set.id}
                  set={set}
                  canPick={canPick}
                  currentRollback={rollback}
                  features={features}
                  partLabels={partLabels}
                  onInsertReference={insertAtCaret}
                />
              ))}
            </div>
            {canPick && !anyPicks && (
              <div className="bug-report-hint">
                Pick a set's chip while the panel is open. Picking the same thing again removes it;
                to compare before and after, put the pick in two sets, one for each bar position.
              </div>
            )}
            <button type="button" className="bug-report-add-set" onClick={() => addSet()}>
              + Add selection set
            </button>

            <div className="bug-report-attachments">
              <div className="bug-report-attachments-title">Attached Data</div>
              <div className="bug-report-attachments-list">
                <label className="bug-report-checkbox-label">
                  <input
                    type="checkbox"
                    checked={attachments.doc}
                    onChange={e => setAttachments({ doc: e.target.checked })}
                    disabled={submitting}
                  />
                  Document
                </label>
                <label className="bug-report-checkbox-label">
                  <input
                    type="checkbox"
                    checked={attachments.history}
                    onChange={e => setAttachments({ history: e.target.checked })}
                    disabled={submitting}
                  />
                  Edit history (last
                  <input
                    type="number"
                    min="1"
                    max={undoStack.length || 50}
                    value={attachments.historyCount}
                    onChange={e => setAttachments({
                      historyCount: Math.max(1, Math.min(undoStack.length || 50, parseInt(e.target.value) || 1)),
                    })}
                    disabled={submitting || !attachments.history}
                    className="bug-report-history-input"
                    aria-label="History entries to attach"
                  />
                  of {undoStack.length} items)
                </label>
              </div>
            </div>
          </div>
        </div>
      )}

      {createPortal(dialogs, document.body)}
    </>
  )
}
