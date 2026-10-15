// The recovery screen a crashed editor (or viewport) lands on. Catches render
// errors in its subtree, flushes the recovery journal and records a crash
// report, then offers the two exits that cannot lose the work: reload, and
// download the live document as YAML.
//
// The flush reads the session through the recovery registry, never React
// state: at this point the failed tree's state is exactly what cannot be
// trusted, while the DocSession and its journal sink are plain objects that
// outlive the render.
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { stringify as stringifyYaml } from 'yaml'
import { errorParts, recordCrashReport } from '@/recovery/crashReports'
import { flushRecoveryEditor, recoveryEditorSnapshot } from '@/recovery/autosave'
import { downloadBlob } from '@/utils/core/downloadBlob'
import './EditorErrorBoundary.css'

interface EditorErrorBoundaryProps {
  children: ReactNode
  // What the fallback says came down ("editor", "viewport").
  label?: string
  // page fills the window (the editor route's whole body); the default fits
  // whatever box the boundary was mounted in (a viewport host).
  variant?: 'page' | 'inline'
}

// The document download, serialized at catch time: after the subtree unmounts
// no editor is registered any more, so a later click cannot read the session.
interface CapturedDownload {
  filename: string
  text: string
}

interface EditorErrorBoundaryState {
  error: Error | null
  download: CapturedDownload | null
}

export default class EditorErrorBoundary extends Component<EditorErrorBoundaryProps, EditorErrorBoundaryState> {
  state: EditorErrorBoundaryState = { error: null, download: null }

  static getDerivedStateFromError(error: Error): Partial<EditorErrorBoundaryState> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Flush first: the journal write is the one durable copy of the edits, and
    // it must be captured before the failed subtree's cleanup can run.
    flushRecoveryEditor()
    const facts = recoveryEditorSnapshot()
    this.setState({
      download: facts?.doc
        ? {
            filename: `${facts.docName.trim() || facts.docId || 'document'}.yaml`,
            text: stringifyYaml(facts.doc),
          }
        : null,
    })
    const parts = errorParts(error)
    const stack = [parts.stack, info.componentStack ? `Component stack:${info.componentStack}` : null]
      .filter((part): part is string => part !== null && part !== '')
      .join('\n')
    void recordCrashReport({
      source: 'boundary',
      message: parts.message,
      stack: stack || null,
    })
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  private handleDownload = (): void => {
    const download = this.state.download
    if (!download) return
    downloadBlob(new Blob([download.text], { type: 'text/yaml' }), download.filename)
  }

  render(): ReactNode {
    const { error, download } = this.state
    if (!error) return this.props.children
    const label = this.props.label ?? 'editor'
    return (
      <div
        className={`editor-error-boundary${this.props.variant === 'page' ? ' editor-error-boundary-page' : ''}`}
        role="alert"
      >
        <span className="material-icons-outlined editor-error-boundary-icon">error_outline</span>
        <h2 className="editor-error-boundary-title">The {label} hit an error</h2>
        <p className="editor-error-boundary-message">{error.message || String(error)}</p>
        <p className="editor-error-boundary-hint">
          The unsaved edits were written to the recovery journal and are offered when the document
          reopens. A crash report was recorded locally.
        </p>
        <div className="editor-error-boundary-actions">
          <button className="btn btn-primary" type="button" onClick={this.handleReload}>
            Reload editor
          </button>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={this.handleDownload}
            disabled={download === null}
          >
            Download document
          </button>
        </div>
      </div>
    )
  }
}
