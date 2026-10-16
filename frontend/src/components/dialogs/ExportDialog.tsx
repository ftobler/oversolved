import { useEffect, useRef, useState } from 'react'
import Dialog from '@/components/dialogs/Dialog'
import { Spinner } from '@/components/shared/Spinner'
import { defaultExportFileName, ensureExtension, swapExtension } from '@/utils/core/exportFileName'
import { isDevBuild } from '@/kernel/isDevBuild'
import {
  DEFAULT_TESSELLATION_PRESET,
  TESSELLATION_PRESET_ORDER,
  type TessellationPreset,
} from '@/kernel/tessellationPresets'
import {
  DEFAULT_EXPORT_SELECTION,
  exportHasOutput,
  type ExportMode,
  type ExportPart,
  type ExportSelection,
} from '@/utils/exportSelection'
import '@/components/dialogs/ExportDialog.css'

export type ExportFormat = 'step' | 'stl' | 'yaml'

/** Everything the user chose, handed to the caller in one object. */
export interface ExportRequest {
  format: ExportFormat
  // STL mesh quality; the caller forwards it to the kernel (STEP ignores it).
  tessellation: TessellationPreset
  fileName: string
  // Which parts to cover and how to bundle them. Everything when the caller
  // offered no parts.
  selection: ExportSelection
}

export interface ExportDialogProps {
  isOpen: boolean
  defaultName: string
  onDownload: (request: ExportRequest) => void | Promise<void>
  onCancel: () => void
  /**
   * Offer the STL tessellation choice. The assembly export writes STL straight
   * from the already-tessellated bundle meshes, so there is no deflection left
   * to choose and the control would be inert.
   */
  showTessellation?: boolean
  /**
   * The parts the caller can export. Omitted for a single-document export
   * (part editor, workspace row): the selection controls are hidden and the
   * export covers everything, as before.
   */
  parts?: readonly ExportPart[]
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
const PRESET_LABEL: Record<TessellationPreset, string> = { fine: 'Fine', normal: 'Normal', coarse: 'Coarse' }
const MODE_LABEL: Record<ExportMode, string> = {
  everything: 'Everything',
  selected: 'Selected parts',
  separate: 'Each part separately',
}
const MODES: readonly ExportMode[] = ['everything', 'selected', 'separate']

export default function ExportDialog({
  isOpen,
  defaultName,
  onDownload,
  onCancel,
  showTessellation = true,
  parts,
  formats = ALL_FORMATS,
}: ExportDialogProps) {
  const [picked, setFormat] = useState<ExportFormat>(formats[0])
  // Derived rather than reset in an effect: one mounted dialog serves callers
  // with different format sets, and a pick the current caller cannot produce
  // falls back to its first format on the very render it would have shown.
  const format = formats.includes(picked) ? picked : formats[0]
  const [tessellation, setTessellation] = useState<TessellationPreset>(DEFAULT_TESSELLATION_PRESET)
  const [selection, setSelection] = useState<ExportSelection>(DEFAULT_EXPORT_SELECTION)
  const [fileName, setFileName] = useState(() => defaultExportFileName(defaultName, format))
  const [isExporting, setIsExporting] = useState(false)
  const wasOpen = useRef(isOpen)

  // The dialog stays mounted between exports, so the document name only reaches
  // it after the first open. Re-seed the field and the parts selection on every
  // open, but never while it is open: that would wipe whatever the user typed or
  // ticked. The selection is reset because the parts list belongs to one caller
  // and can change between opens.
  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      setFileName(defaultExportFileName(defaultName, format))
      setSelection(DEFAULT_EXPORT_SELECTION)
    }
    wasOpen.current = isOpen
  }, [isOpen, defaultName, format])

  const showParts = !!parts && parts.length > 1

  const handleFormatChange = (newFormat: ExportFormat) => {
    setFormat(newFormat)
    setFileName(prev => swapExtension(prev, newFormat))
  }

  // Everything starts from the whole list, so switching to a narrower mode does
  // not silently drop parts the user can still see ticked.
  const handleModeChange = (mode: ExportMode) => {
    setSelection(prev => ({
      mode,
      selectedIds: mode === 'everything'
        ? prev.selectedIds
        : (prev.mode === 'everything' && parts ? parts.map(part => part.id) : prev.selectedIds),
    }))
  }

  const togglePart = (id: string) => {
    setSelection(prev => {
      const ticked = new Set(prev.selectedIds)
      if (ticked.has(id)) ticked.delete(id)
      else ticked.add(id)
      return { ...prev, selectedIds: [...ticked] }
    })
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
      await onDownload({ format, tessellation, fileName: name, selection })
    } catch (e) {
      // The parent surfaces the failure; log it only under a dev build so the
      // dialog can still reset its busy state without prod console chatter.
      if (isDevBuild()) console.error('Export failed:', e)
    } finally {
      setIsExporting(false)
    }
  }

  const handleCancel = () => {
    if (isExporting) return
    onCancel()
  }

  // Nothing ticked means nothing to write; the caller owns the outcome, so the
  // button is simply held down rather than letting an empty export through.
  const nothingToExport = showParts && !exportHasOutput(parts!, selection)

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
      confirmDisabled={nothingToExport}
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
          <label className="export-dialog-label">Tessellation</label>
          <div className="export-dialog-radio-group">
            {TESSELLATION_PRESET_ORDER.map(preset => (
              <label className="export-dialog-radio" key={preset}>
                <input
                  type="radio"
                  name="tessellation"
                  value={preset}
                  checked={tessellation === preset}
                  disabled={isExporting}
                  onChange={() => setTessellation(preset)}
                />
                <span>{PRESET_LABEL[preset]}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {showParts && (
        <div className="export-dialog-section">
          <label className="export-dialog-label">Parts</label>
          <div className="export-dialog-radio-group">
            {MODES.map(mode => (
              <label className="export-dialog-radio" key={mode}>
                <input
                  type="radio"
                  name="export-mode"
                  value={mode}
                  checked={selection.mode === mode}
                  disabled={isExporting}
                  onChange={() => handleModeChange(mode)}
                />
                <span>{MODE_LABEL[mode]}</span>
              </label>
            ))}
          </div>
          <ul className="export-dialog-parts">
            {parts!.map(part => {
              // Everything shows every part ticked; the boxes are then a picture
              // of the mode, not something to toggle.
              const checked = selection.mode === 'everything' || selection.selectedIds.includes(part.id)
              return (
                <li key={part.id}>
                  <label className="export-dialog-radio">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={isExporting || selection.mode === 'everything'}
                      onChange={() => togglePart(part.id)}
                    />
                    <span>{part.name}</span>
                  </label>
                </li>
              )
            })}
          </ul>
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
