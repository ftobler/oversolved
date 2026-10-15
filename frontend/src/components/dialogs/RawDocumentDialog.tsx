// The read-only fallback for a document that failed validation: the field the
// loader refused, the raw text itself, and a raw export, so a file the app
// cannot open is still a file the user keeps. Plain and viewport-free.
import Dialog from '@/components/dialogs/Dialog'
import { downloadBlob } from '@/utils/core/downloadBlob'
import { secureFilename, UNTITLED_DOC_NAME } from '@/stores/documentStore/secureFilename'
import type { DocLoadError } from '@/persistence/docSchema'
import './RawDocumentDialog.css'

export default function RawDocumentDialog({ failure, onClose }: { failure: DocLoadError | null; onClose: () => void }) {
  if (!failure) return null
  const text = failure.rawText ?? ''
  const title = failure.docName ? `Could not open "${failure.docName}"` : 'Could not open the document'
  // A document name is arbitrary user text; the downloaded file name goes
  // through the same sanitizer every other export names files with.
  const rawFileName = `${secureFilename(failure.docName) || UNTITLED_DOC_NAME}.raw.yaml`
  return (
    <Dialog
      isOpen
      title={title}
      icon="error_outline"
      onClose={onClose}
      onConfirm={onClose}
      confirmLabel="Close"
      showCancel={false}
      className="raw-document-dialog"
      extraAction={{
        label: 'Export raw',
        onClick: () => downloadBlob(new Blob([text], { type: 'application/yaml' }), rawFileName),
      }}
    >
      <p className="raw-document-dialog-field">
        <code>{failure.field}</code>: {failure.message}
      </p>
      <p className="raw-document-dialog-hint">
        The document is shown below read-only so its content is not lost.
      </p>
      <textarea
        className="raw-document-dialog-text"
        readOnly
        value={text}
        spellCheck={false}
        aria-label="Raw document text"
      />
    </Dialog>
  )
}
