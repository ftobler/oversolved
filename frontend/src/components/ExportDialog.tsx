import { useState } from 'react'
import '@/components/ExportDialog.css'

export type ExportFormat = 'step' | 'stl'

export interface ExportDialogProps {
  isOpen: boolean
  defaultName: string
  onDownload: (format: ExportFormat, tessellation: number) => void
  onCancel: () => void
}

export default function ExportDialog({ isOpen, defaultName, onDownload, onCancel }: ExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>('step')
  const [tessellation, setTessellation] = useState(0.5)

  if (!isOpen) return null

  const handleDownload = () => {
    onDownload(format, format === 'stl' ? tessellation : 0)
  }

  const extension = format === 'step' ? 'step' : 'stl'

  return (
    <div className="export-dialog-overlay" onClick={onCancel}>
      <div className="export-dialog" onClick={e => e.stopPropagation()}>
        <div className="export-dialog-title">Export</div>

        <div className="export-dialog-section">
          <label className="export-dialog-label">Format</label>
          <div className="export-dialog-radio-group">
            <label className="export-dialog-radio">
              <input
                type="radio"
                name="format"
                value="step"
                checked={format === 'step'}
                onChange={() => setFormat('step')}
              />
              <span>STEP</span>
            </label>
            <label className="export-dialog-radio">
              <input
                type="radio"
                name="format"
                value="stl"
                checked={format === 'stl'}
                onChange={() => setFormat('stl')}
              />
              <span>STL</span>
            </label>
          </div>
        </div>

        {format === 'stl' && (
          <div className="export-dialog-section">
            <label className="export-dialog-label">Tessellation Detail</label>
            <div className="export-dialog-slider-row">
              <input
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={tessellation}
                onChange={e => setTessellation(parseFloat(e.target.value))}
                className="export-dialog-slider"
              />
              <span className="export-dialog-slider-value">{tessellation.toFixed(1)}</span>
            </div>
          </div>
        )}

        <div className="export-dialog-filename">
          <span className="export-dialog-label">File</span>
          <span className="export-dialog-filename-text">{defaultName}.{extension}</span>
        </div>

        <div className="export-dialog-buttons">
          <button className="export-dialog-btn export-dialog-btn-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button className="export-dialog-btn export-dialog-btn-download" onClick={handleDownload}>
            Download
          </button>
        </div>
      </div>
    </div>
  )
}