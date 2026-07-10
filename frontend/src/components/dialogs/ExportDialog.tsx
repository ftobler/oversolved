import { useEffect, useRef, useState } from 'react'
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
   * Offer the YAML format. The assembly export worker path only emits STEP/STL,
   * so the assembly dialog hides YAML rather than presenting a broken option.
   */
  showYaml?: boolean
}

export default function ExportDialog({
  isOpen,
  defaultName,
  onDownload,
  onCancel,
  showTessellation = true,
  showYaml = true,
}: ExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>('step')
  const [tessellation, setTessellation] = useState(0.5)
  const [fileName, setFileName] = useState(() => defaultExportFileName(defaultName, 'step'))
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

  if (!isOpen) return null

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
    <div className="export-dialog-overlay" onClick={handleCancel}>
      <div className="export-dialog" onClick={e => e.stopPropagation()} aria-busy={isExporting}>
        <div className="export-dialog-header">
          <h2 className="export-dialog-title">Export Model</h2>
          <button
            className="export-dialog-close-btn"
            onClick={handleCancel}
            disabled={isExporting}
            title="Close"
            type="button"
          >
            <span className="material-icons">close</span>
          </button>
        </div>

        <div className="export-dialog-body">
          <div className="export-dialog-section">
            <label className="export-dialog-label">Format</label>
            <div className="export-dialog-radio-group">
              <label className="export-dialog-radio">
                <input
                  type="radio"
                  name="format"
                  value="step"
                  checked={format === 'step'}
                  disabled={isExporting}
                  onChange={() => handleFormatChange('step')}
                />
                <span>STEP</span>
              </label>
              <label className="export-dialog-radio">
                <input
                  type="radio"
                  name="format"
                  value="stl"
                  checked={format === 'stl'}
                  disabled={isExporting}
                  onChange={() => handleFormatChange('stl')}
                />
                <span>STL</span>
              </label>
              {showYaml && (
                <label className="export-dialog-radio">
                  <input
                    type="radio"
                    name="format"
                    value="yaml"
                    checked={format === 'yaml'}
                    disabled={isExporting}
                    onChange={() => handleFormatChange('yaml')}
                  />
                  <span>YAML</span>
                </label>
              )}
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
        </div>

        <div className="export-dialog-buttons">
          <button
            className="export-dialog-btn export-dialog-btn-cancel"
            onClick={handleCancel}
            disabled={isExporting}
          >
            Cancel
          </button>
          <button
            className="export-dialog-btn export-dialog-btn-download"
            onClick={handleDownload}
            disabled={isExporting}
          >
            {isExporting ? (
              <>
                <Spinner className="export-dialog-spinner" />
                <span>Generating...</span>
              </>
            ) : (
              'Download'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
