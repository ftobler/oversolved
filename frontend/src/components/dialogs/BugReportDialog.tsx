import { useState } from 'react'
import Dialog from '@/components/dialogs/Dialog'
import MessageDialog from '@/components/dialogs/MessageDialog'
import { describeMutation } from '@/utils/core/mutationDescriptions'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { backendBundle } from '@/adapters/backend'
import type { Mutation } from '@/types/cad'
import '@/components/dialogs/BugReportDialog.css'

type UndoEntry = { doc: unknown; mutation: Mutation }

export interface BugReportAttachments {
  ast: boolean
  selection: boolean
  history: boolean
  historyCount: number
}

interface BugReportDialogProps {
  isOpen: boolean
  onClose: () => void
}

// The dialog reads the editor state straight off the global stores rather than
// taking it as props: it is opened from the app header, which sits above the
// part editor and has no access to that context. Outside the part editor the
// stores are simply empty and the attachments come out blank.
export default function BugReportDialog({ isOpen, onClose }: BugReportDialogProps) {
  const selection = useSketchEditorStore(s => s.normalSelection)
  const undoStack = usePartEditorStore(s => s.undoStack) as UndoEntry[]
  const doc = usePartEditorStore(s => s.doc)

  const [form, setForm] = useState({ title: '', description: '' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [attachments, setAttachments] = useState<BugReportAttachments>({
    ast: true,
    selection: true,
    history: true,
    historyCount: 5,
  })

  const handleSubmit = async () => {
    if (!form.title.trim()) {
      setError('Title is required')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const report: Record<string, unknown> = {
        title: form.title,
        description: form.description,
      }
      if (attachments.ast) report.ast = doc
      if (attachments.selection) report.selection = [...selection]
      if (attachments.history) {
        report.history = undoStack.slice(-attachments.historyCount).map(entry => ({
          mutation: entry.mutation,
          label: describeMutation(entry.mutation),
        }))
      }
      await backendBundle.telemetry.send(report)
      setForm({ title: '', description: '' })  // a sent report must not reappear in the next one
      setSuccess(true)
      onClose()
    } catch (e) {
      setError(`Failed to submit: ${e}`)
    } finally {
      setSubmitting(false)
    }
  }

  // Closing discards the draft, but only when the submit is not in flight: there
  // is no way to recall a report already handed to the sink.
  const handleClose = () => {
    if (submitting) return
    setError(null)
    onClose()
  }

  return (
    <>
      <Dialog
        isOpen={isOpen}
        title="Report a Bug"
        icon="bug_report"
        onClose={handleClose}
        onConfirm={handleSubmit}
        confirmLabel={submitting ? 'Submitting...' : 'Submit Report'}
        confirmDisabled={submitting}
      >
        <input
          type="text"
          placeholder="Title"
          value={form.title}
          onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
          disabled={submitting}
          className="bug-report-input"
        />
        <textarea
          placeholder="Description (what went wrong?)"
          value={form.description}
          onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
          disabled={submitting}
          className="bug-report-textarea"
        />
        {error && <div className="bug-report-error">{error}</div>}
        <div className="bug-report-attachments">
          <div className="bug-report-attachments-title">Attached Data</div>
          <div className="bug-report-attachments-list">
            <label className="bug-report-checkbox-label">
              <input
                type="checkbox"
                checked={attachments.ast}
                onChange={e => setAttachments(a => ({ ...a, ast: e.target.checked }))}
                disabled={submitting}
              />
              AST (current document)
            </label>
            <label className="bug-report-checkbox-label">
              <input
                type="checkbox"
                checked={attachments.selection}
                onChange={e => setAttachments(a => ({ ...a, selection: e.target.checked }))}
                disabled={submitting}
              />
              Selection ({selection.size} items)
            </label>
            <label className="bug-report-checkbox-label">
              <input
                type="checkbox"
                checked={attachments.history}
                onChange={e => setAttachments(a => ({ ...a, history: e.target.checked }))}
                disabled={submitting}
              />
              Edit history (last
              <input
                type="number"
                min="1"
                max={undoStack.length || 50}
                value={attachments.historyCount}
                onChange={e => setAttachments(a => ({
                  ...a,
                  historyCount: Math.max(1, Math.min(undoStack.length, parseInt(e.target.value) || 1)),
                }))}
                disabled={submitting || !attachments.history}
                className="bug-report-history-input"
              />
              of {undoStack.length} items)
            </label>
          </div>
        </div>
      </Dialog>

      <MessageDialog
        isOpen={success}
        title="Bug Report"
        message="Bug report submitted successfully!"
        variant="success"
        onClose={() => setSuccess(false)}
      />
    </>
  )
}
