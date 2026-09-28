import { useEffect, useRef, useState } from 'react'
import Dialog from '@/components/dialogs/Dialog'
import { Spinner } from '@/components/shared/Spinner'
import { defaultExportFileName, ensureExtension, swapExtension } from '@/utils/core/exportFileName'
import '@/components/dialogs/ExportDialog.css'

export type ExportFormat = 'step' | 'stl' | 'yaml'

export interface ExportDialogProps {
  isOpen: boolean
  defaultName: string
  onDownload: (format: ExportFormat, tessellation: number, fileName: string) => void | Promise<void>
  onCancel: () => void
  /**
   * Offer the STL tessellation knob. The assembly export writes STL straight
   * from the already-tessellated bundle meshes, so there is no deflection left
   * to choose and the slider would be an inert control.
   */
  showTessellation?: boolean
  /**
   * The formats offered, in display order; the first is the one selected when
   * the current pick is not offered. The editor's assembly export emits only
   * STEP/STL, and an assembly exported from the workspace list only its source,
   * so each caller names what it can actually produce rather than presenting a
   * broken option.
   */
  formats?: readonly ExportFormat[]
}

const ALL_FORMATS: readonly ExportFormat[] = ['step', 'stl', 'yaml']
const FORMAT_LABEL: Record<ExportFormat, string> = { step: 'STEP', stl: 'STL', yaml: 'YAML' }

export default function ExportDialog({
  isOpen,
  defaultName,
  onDownload,
  onCancel,
  showTessellation = true,
  formats = ALL_FORMATS,
}: ExportDialogProps) {
  const [picked, setFormat] = useState<ExportFormat>(formats[0])
  // Derived rather than reset in an effect: one mounted dialog serves callers
  // with different format sets, and a pick the current caller cannot produce
  // falls back to its first format on the very render it would have shown.
  const format = formats.includes(picked) ? picked : formats[0]
  const [tessellation, setTessellation] = useState(0.5)
  const [fileName, setFileName] = useState(() => defaultExportFileName(defaultName, format))
  const [isExporting, setIsExporting] = useState(false)
  const wasOpen = useRef(isOpen)

  // The dialog stays mounted between exports, so the document name only reaches
  // it after the first open. Re-seed the field on every open, but never while it
  // is open: that would wipe whatever the user typed.
  useEffect(() => {
    if (isOpen && !wasOpen.current) setFileName(defaultExportFileName(defaultName, format))
    wasOpen.current = isOpen
  }, [isOpen, defaultName, format])

  const handleFormatChange = (newFormat: ExportFormat) => {
    setFormat(newFormat)
    setFileName(prev => swapExtension(prev, newFormat))
  }

  // The worker rebuild + tessellation + STEP/STL serialisation can take seconds on
  // a heavy body. Freeze the whole dialog for the duration: there is no way to
  // abort an in-flight worker export, so a cancel would only desync the UI.
  const handleDownload = async () => {
    if (isExporting) return
    const name = ensureExtension(fileName, format)  // the user may have deleted the extension
    setFileName(name)
    setIsExporting(true)
    try {
      await onDownload(format, format === 'stl' ? tessellation : 0, name)
    } catch (e) {
      console.error('Export failed:', e)  // the parent reports it; never leave the dialog stuck busy
    } finally {
      setIsExporting(false)
    }
  }

  const handleCancel = () => {
    if (isExporting) return
    onCancel()
  }

  return (
    <Dialog
      isOpen={isOpen}
      title="Export Model"
      icon="download"
      onClose={handleCancel}
      onConfirm={handleDownload}
      confirmLabel={isExporting ? (
        <>
          <Spinner className="export-dialog-spinner" />
          <span>Generating...</span>
        </>
      ) : 'Download'}
      busy={isExporting}
    >
      <div className="export-dialog-section">
        <label className="export-dialog-label">Format</label>
        <div className="export-dialog-radio-group">
          {formats.map(option => (
            <label className="export-dialog-radio" key={option}>
              <input
                type="radio"
                name="format"
                value={option}
                checked={format === option}
                disabled={isExporting}
                onChange={() => handleFormatChange(option)}
              />
              <span>{FORMAT_LABEL[option]}</span>
            </label>
          ))}
        </div>
      </div>

      {format === 'stl' && showTessellation && (
        <div className="export-dialog-section">
          <label className="export-dialog-label">Tessellation Detail</label>
          <div className="export-dialog-slider-row">
            <input
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={tessellation}
              disabled={isExporting}
              onChange={e => setTessellation(parseFloat(e.target.value))}
              className="export-dialog-slider"
            />
            <span className="export-dialog-slider-value">{tessellation.toFixed(1)}</span>
          </div>
        </div>
      )}

      <div className="export-dialog-filename">
        <span className="export-dialog-label">File</span>
        <input
          className="export-dialog-filename-input"
          value={fileName}
          disabled={isExporting}
          onChange={e => setFileName(e.target.value)}
        />
      </div>
    </Dialog>
  )
}
