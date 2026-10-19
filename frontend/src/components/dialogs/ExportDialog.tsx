import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
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
  type ExportBundle,
  type ExportPart,
  type ExportScope,
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
  // Which parts to cover and how to bundle them. The full document for YAML.
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
   * The parts the caller can export. Omitted when the caller has no part list
   * to offer (a workspace row, a part whose solve published no bodies): the
   * scope controls are hidden and the export covers everything.
   */
  parts?: readonly ExportPart[]
  /**
   * The parts selected in the document before this dialog opened. The dialog
   * never edits this selection: the modal hides the viewport, so the choice is
   * a snapshot. Omitted or empty disables "Selected Parts"; the option stays
   * visible so the user can see why.
   */
  selectedPartIds?: readonly string[]
  /**
   * Which scope starts selected when there is a multi-part list. The body
   * context menu opens the dialog already aimed at that body; the toolbar
   * export starts from All Parts.
   */
  defaultScope?: ExportScope
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
const BUNDLE_LABEL: Record<ExportBundle, string> = { consolidated: 'One file', zip: 'ZIP archive' }

export default function ExportDialog({
  isOpen,
  defaultName,
  onDownload,
  onCancel,
  showTessellation = true,
  parts,
  selectedPartIds = [],
  defaultScope = 'all',
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
  // Starts false, not `isOpen`: a caller that mounts the dialog already open
  // must still take the opening snapshot once, like one that opens it later.
  const wasOpen = useRef(false)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const tabPanelId = useId()

  // The dialog stays mounted between exports, so the document name only reaches
  // it after the first open. Re-seed the field and the part choice on every
  // open, but never while it is open: that would wipe whatever the user typed or
  // chose. The selected ids are captured here, not read live: the viewport that
  // made the selection is covered by this modal.
  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      const ids = [...selectedPartIds]
      setFileName(defaultExportFileName(defaultName, format))
      setSelection({
        ...DEFAULT_EXPORT_SELECTION,
        scope: defaultScope === 'selected' && ids.length > 0 ? 'selected' : 'all',
        selectedIds: ids,
      })
    }
    wasOpen.current = isOpen
  }, [isOpen, defaultName, format, defaultScope, selectedPartIds])

  // Read the captured ids, never the live prop: once the modal is up, the
  // document selection behind it is no longer the user's answer to this
  // question. Parts still have to exist in this caller's list so a stale id
  // from another document cannot keep "Selected Parts" available.
  const selectedIdSet = new Set(selection.selectedIds)
  const validSelectedIds = parts
    ? parts.filter(part => selectedIdSet.has(part.id)).map(part => part.id)
    : []
  const showScope = format !== 'yaml' && !!parts && parts.length > 1
  const showBundle = format !== 'yaml' && !!parts && parts.length > 1
  const selectedCount = validSelectedIds.length
  // Even when the caller offers only one part (so the scope controls are
  // hidden), a body context-menu export still starts on its explicit target.
  // The request keeps that narrower scope rather than widening it to All Parts.
  const scope: ExportScope = selection.scope === 'selected' && selectedCount > 0
    ? 'selected'
    : 'all'
  const bundle: ExportBundle = showBundle ? selection.bundle : 'consolidated'

  const handleFormatChange = (newFormat: ExportFormat) => {
    // A click on the active tab (or Home/End landing on it) is not a format
    // change: swapping the extension would mangle a hand-typed file name. Still
    // pin the shown format, which can be a fallback when the last pick is not in
    // this caller's set.
    if (newFormat === format) {
      setFormat(newFormat)
      return
    }
    setFormat(newFormat)
    setFileName(prev => swapExtension(prev, newFormat))
  }

  // A tablist is expected to move with the arrow keys, not only Tab and click.
  // Roving tabIndex keeps one stop in the tab order while the arrows walk the
  // formats that this caller actually offers.
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % formats.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + formats.length) % formats.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = formats.length - 1
    else return
    event.preventDefault()
    handleFormatChange(formats[next])
    tabRefs.current[next]?.focus()
  }

  const requestSelection: ExportSelection = format === 'yaml'
    ? { ...DEFAULT_EXPORT_SELECTION }
    : {
        scope,
        bundle,
        selectedIds: scope === 'selected' ? validSelectedIds : [],
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
      await onDownload({ format, tessellation, fileName: name, selection: requestSelection })
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

  // No resolvable part means nothing to write; the caller owns the outcome, so
  // the button is held down rather than letting an empty export through. The
  // scope falls back to All Parts when no captured id resolves, so this is a
  // last guard rather than a normal path.
  const nothingToExport = showScope && !exportHasOutput(parts!, requestSelection)

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
      className="export-dialog"
    >
      <div className="export-dialog-tabs" role="tablist" aria-label="Export format">
        {formats.map((option, index) => (
          <button
            key={option}
            ref={element => { tabRefs.current[index] = element }}
            type="button"
            role="tab"
            className="export-dialog-tab"
            aria-label={FORMAT_LABEL[option]}
            aria-selected={format === option}
            aria-controls={tabPanelId}
            id={`${tabPanelId}-tab-${option}`}
            tabIndex={format === option ? 0 : -1}
            disabled={isExporting}
            onClick={() => handleFormatChange(option)}
            onKeyDown={event => handleTabKeyDown(event, index)}
          >
            {FORMAT_LABEL[option]}
          </button>
        ))}
      </div>

      <div
        className="export-dialog-panel"
        role="tabpanel"
        id={tabPanelId}
        aria-labelledby={`${tabPanelId}-tab-${format}`}
      >
        {format === 'yaml' ? (
          <p className="export-dialog-note">YAML exports the complete document. Part options do not apply.</p>
        ) : (
          <>
            {format === 'stl' && showTessellation && (
              <div className="export-dialog-section">
                <span className="export-dialog-label">Tessellation</span>
                <div className="export-dialog-choices">
                  {TESSELLATION_PRESET_ORDER.map(preset => (
                    <label className="export-dialog-choice" key={preset}>
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

            {showScope && (
              <div className="export-dialog-section">
                <span className="export-dialog-label">Parts</span>
                <div className="export-dialog-choices">
                  <label className="export-dialog-choice">
                    <input
                      type="radio"
                      name="export-scope"
                      value="all"
                      aria-label="All Parts"
                      checked={scope === 'all'}
                      disabled={isExporting}
                      onChange={() => setSelection(prev => ({ ...prev, scope: 'all' }))}
                    />
                    <span>All Parts</span>
                  </label>
                  <label className="export-dialog-choice">
                    <input
                      type="radio"
                      name="export-scope"
                      value="selected"
                      aria-label="Selected Parts"
                      checked={scope === 'selected'}
                      disabled={isExporting || selectedCount === 0}
                      onChange={() => setSelection(prev => ({ ...prev, scope: 'selected' }))}
                    />
                    <span>Selected Parts</span>
                    <span className="export-dialog-count" aria-hidden="true">{selectedCount}</span>
                  </label>
                </div>
                {selectedCount === 0 && (
                  <p className="export-dialog-hint">Select parts in the document before opening Export.</p>
                )}
              </div>
            )}

            {showBundle && (
              <div className="export-dialog-section">
                <span className="export-dialog-label">Output</span>
                <div className="export-dialog-choices">
                  {(Object.keys(BUNDLE_LABEL) as ExportBundle[]).map(option => (
                    <label className="export-dialog-choice" key={option}>
                      <input
                        type="radio"
                        name="export-bundle"
                        value={option}
                        aria-label={BUNDLE_LABEL[option]}
                        checked={bundle === option}
                        disabled={isExporting}
                        onChange={() => setSelection(prev => ({ ...prev, bundle: option }))}
                      />
                      <span>{BUNDLE_LABEL[option]}</span>
                    </label>
                  ))}
                </div>
                <p className="export-dialog-hint">
                  One file holds every chosen part. ZIP downloads one archive with an entry per part.
                </p>
              </div>
            )}
          </>
        )}
      </div>

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
