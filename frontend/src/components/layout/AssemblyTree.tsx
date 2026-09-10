import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type MouseEvent as ReactMouseEvent } from 'react'
import type { PartInstance, MateFeature } from '@/types/cad'
import type { AssemblySolveStatus } from '@/kernel/solveAssembly'
import { mateFailure, partFailure, assemblyVerdict } from '@/utils/core/assemblyStatus'
import type { AssemblyBuiltinListItem } from '@/utils/assemblyRender'
import { relatedMateIds, relatedPartHandles } from '@/utils/assemblyTreeHighlight'
import { MATE_KIND_LABELS } from '@/utils/mateKinds'
import { getFeatureIcon } from '@/components/layout/featureIcons'
import RightClickMenu, { type ContextMenuItem } from '@/components/dialogs/RightClickMenu'
import featurePartIcon from '@/assets/icons/feature-part.svg'
import contextEditIcon from '@/assets/icons/context-edit.svg'
import contextDeleteIcon from '@/assets/icons/context-delete.svg'
import contextDuplicateIcon from '@/assets/icons/context-duplicate.svg'
import iconRenameIcon from '@/assets/icons/rename.svg'
import okIcon from '@/assets/icons/dialog-ok.svg'
import cancelIcon from '@/assets/icons/dialog-cancel.svg'
import iconEyeIcon from '@/assets/icons/icon-eye.svg'
import iconEyeOffIcon from '@/assets/icons/icon-eye-off.svg'
import iconDotsIcon from '@/assets/icons/dots.svg'
import constraintFixedIcon from '@/assets/icons/constraint-fixed.svg'
import mateIcon from '@/assets/icons/constraint-coincident.svg'

// The split follows the part editor's Sidebar so the two editors resize the same
// way: a top pane (Origin + Parts) and a bottom pane (Mates).
const MIN_SPLIT_PERCENT = 20
const MAX_SPLIT_PERCENT = 80
const DEFAULT_SPLIT_PERCENT = 70

interface AssemblyTreeProps {
  instances: PartInstance[]
  // The assembly's own origin and reference planes, hidden by default.
  builtins: AssemblyBuiltinListItem[]
  mates: MateFeature[]
  // The whole solve verdict. A failed part or mate renders red on its row.
  status?: AssemblySolveStatus | null
  // Map from a part handle to a display label (the part document's name).
  labelFor?: (handle: string) => string | undefined
  // The selected instance is the one the transform triad attaches to (Stage 6d).
  selectedHandle?: string | null
  // The selected mate: highlighted in the tree (and, going forward, its two
  // parts and mated geometry in the viewport). Selecting does not open the editor.
  selectedMateId?: string | null
  // The mate whose inline editor is open. Opened from the row's edit action, not
  // a plain click, so a click can select without diving into the parameter form.
  editingMateId?: string | null
  // The instance whose inline editor is open.
  editingInstanceHandle?: string | null
  onSelectPart?: (handle: string) => void
  // Drag-reorder callbacks. `beforeHandle`/`beforeId` name the row the dragged
  // item is dropped in front of, or null when dropped past the last row of its
  // list. The owner persists the new order in the document's feature array.
  onReorderInstance?: (movingHandle: string, beforeHandle: string | null) => void
  onReorderMate?: (movingId: string, beforeId: string | null) => void
  onOpenPartNewTab: (handle: string) => void
  onDuplicateInstance: (handle: string) => void
  onDeleteInstance: (handle: string) => void
  onToggleVisible: (handle: string, visible: boolean) => void
  onToggleFixed: (handle: string, fixed: boolean) => void
  onToggleBuiltinVisible: (id: string, visible: boolean) => void
  onEditInstance: (handle: string) => void
  onCommitInstance: () => void
  onCancelInstance: () => void
  // Rendered inside the instance's row while it is being edited.
  renderInstanceEditor: (instance: PartInstance) => ReactNode
  onSelectMate?: (featureId: string) => void
  // Open the mate's inline editor (the row's pencil action).
  onEditMate?: (featureId: string) => void
  onCommitMate: () => void
  onCancelMate: () => void
  onDeleteMate: (featureId: string) => void
  // A rename gesture only names its subject; the owner collects the new label in
  // a dialog, the same split the part editor's context menu uses. The current
  // name is what the row shows, so an unlabelled mate seeds 'Fixed 1'.
  onRequestRenameMate: (featureId: string, currentName: string) => void
  // Rendered inside the mate's row while it is being edited.
  renderMateEditor: (mate: MateFeature) => ReactNode
}

// The assembly's feature tree, styled to mirror the part editor: a top pane of
// origin planes and part instances (the "Features" analog) and a bottom pane of
// mates (the "Parts" analog). An edited instance or mate expands its row into
// the same pink dialog the part editor draws, with accept/reject on top. Row
// actions use the part editor's svg glyphs, and the tridot opens the same
// RightClickMenu. Presentational only; all mutations flow back through the
// callbacks so the logic stays viewport-free and testable.
export function AssemblyTree({
  instances,
  builtins,
  mates,
  status,
  labelFor,
  selectedHandle,
  selectedMateId,
  editingMateId,
  editingInstanceHandle,
  onSelectPart,
  onReorderInstance,
  onReorderMate,
  onOpenPartNewTab,
  onDuplicateInstance,
  onDeleteInstance,
  onToggleVisible,
  onToggleFixed,
  onToggleBuiltinVisible,
  onEditInstance,
  onCommitInstance,
  onCancelInstance,
  renderInstanceEditor,
  onSelectMate,
  onEditMate,
  onCommitMate,
  onCancelMate,
  onDeleteMate,
  onRequestRenameMate,
  renderMateEditor,
}: AssemblyTreeProps) {
  const [splitPercent, setSplitPercent] = useState(DEFAULT_SPLIT_PERCENT)
  const [menu, setMenu] = useState<{ position: [number, number]; items: ContextMenuItem[] } | null>(null)
  const isDraggingRef = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // The row picked up by an HTML5 drag. Held in a ref, not state: it changes only
  // at drag start/end and the reorder reads it on drop, so it never needs to
  // re-render. `dragOverKey` does drive a render -- it paints the drop indicator.
  const dragItemRef = useRef<{ kind: 'part' | 'mate'; id: string } | null>(null)
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)
  const endDrag = useCallback(() => {
    dragItemRef.current = null
    setDragOverKey(null)
  }, [])

  const handleMouseDown = useCallback(() => { isDraggingRef.current = true }, [])
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDraggingRef.current || !rootRef.current) return
    const rect = rootRef.current.getBoundingClientRect()
    const newPercent = ((e.clientY - rect.top) / rect.height) * 100
    setSplitPercent(Math.max(MIN_SPLIT_PERCENT, Math.min(MAX_SPLIT_PERCENT, newPercent)))
  }, [])
  const handleMouseUp = useCallback(() => { isDraggingRef.current = false }, [])

  useEffect(() => {
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [handleMouseMove, handleMouseUp])

  const openMenu = (e: ReactMouseEvent, items: ContextMenuItem[]) => {
    e.stopPropagation()
    setMenu({ position: [e.clientX, e.clientY], items })
  }

  // Per-kind ordinal for the default mate name ('Fixed 1', 'Parallel 2', ...).
  const kindOrdinal: Record<string, number> = {}

  // Cross-highlight: a selected part row lights up the mates that reference it,
  // and a selected mate row lights up the two parts it mates. Symmetric and
  // pane-crossing only -- the row that is actually selected never also carries
  // .related, since each function only looks at the other pane's selection.
  const highlightedMateIds = useMemo(() => relatedMateIds(mates, selectedHandle), [mates, selectedHandle])
  const highlightedPartHandles = useMemo(() => relatedPartHandles(mates, selectedMateId), [mates, selectedMateId])

  // The whole-assembly verdict, shown on a root row: overconstrained is a hard
  // error, underconstrained a warning that the assembly is valid but still has
  // freedom. Fully constrained and trivial solves carry no mark.
  const verdictMark = assemblyVerdict(status ?? null)

  return (
    <div className="assembly-tree" ref={rootRef}>
      <div className="sidebar-top" style={{ height: `${splitPercent}%` }}>
        <div className="sidebar-header"><span>Parts</span></div>
        {verdictMark.level && (
          <div
            className={`assembly-verdict assembly-verdict-${verdictMark.level}`}
            role="status"
            title={verdictMark.message}
            data-verdict={verdictMark.verdict}
          >
            <span className="assembly-verdict-name">Assembly</span>
            <span className={`feature-name feature-name-${verdictMark.level === 'error' ? 'error' : 'warning'}`}>
              {verdictMark.message}
            </span>
          </div>
        )}
        <ul
          className="features-list"
          onDragOver={(e) => {
            if (dragItemRef.current?.kind !== 'part') return
            e.preventDefault()  // a row dropped past the last one appends to the parts list
            setDragOverKey('part:end')
          }}
          onDrop={(e) => {
            if (dragItemRef.current?.kind !== 'part') return
            e.preventDefault()
            const moving = dragItemRef.current.id
            endDrag()
            onReorderInstance?.(moving, null)
          }}
        >
          {builtins.map(b => (
            <li key={b.id} className={`feature-item builtin${b.visible ? '' : ' invisible'}`}>
              <div className="feature-item-title">
                <img className="feature-icon" src={getFeatureIcon(b.kind)} alt="" />
                <span className="feature-name">{b.label}</span>
                <div className="feature-item-actions">
                  <button
                    type="button"
                    className="feature-visibility-btn"
                    onClick={(e) => { e.stopPropagation(); onToggleBuiltinVisible(b.id, !b.visible) }}
                    title={b.visible ? 'Hide' : 'Show'}
                    aria-label={b.visible ? `Hide ${b.label}` : `Show ${b.label}`}
                  >
                    <img src={b.visible ? iconEyeIcon : iconEyeOffIcon} alt={b.visible ? 'Visible' : 'Hidden'} />
                  </button>
                </div>
              </div>
            </li>
          ))}

          {instances.map(inst => {
            const visible = inst.visible !== false
            const label = labelFor?.(inst.handle) || inst.doc_id
            const selected = selectedHandle === inst.handle
            const related = highlightedPartHandles.has(inst.handle)
            const editing = editingInstanceHandle === inst.handle
            const failMark = partFailure(inst.handle, status ?? null)
            const menuItems: ContextMenuItem[] = [
              { label: 'Open in new tab', icon: featurePartIcon, onClick: () => onOpenPartNewTab(inst.handle) },
              { label: 'Duplicate', icon: contextDuplicateIcon, onClick: () => onDuplicateInstance(inst.handle) },
              {
                label: inst.fixed ? 'Unfix' : 'Fix',
                icon: constraintFixedIcon,
                onClick: () => onToggleFixed(inst.handle, !inst.fixed),
              },
              { label: 'Delete', icon: contextDeleteIcon, className: 'danger', onClick: () => onDeleteInstance(inst.handle) },
            ]
            return (
              <li
                key={inst.handle}
                className={`feature-item${selected ? ' selected' : ''}${related ? ' related' : ''}${editing ? ' editing' : ''}${visible ? '' : ' invisible'}${dragOverKey === `part:${inst.handle}` ? ' drag-over' : ''}`}
                aria-selected={selected}
                title={failMark.failed ? failMark.message : undefined}
                onClick={() => onSelectPart?.(inst.handle)}
                // Not draggable while its inline editor is open: a draggable
                // ancestor blocks the editor's inputs from taking focus.
                draggable={!editing}
                onDragStart={(e) => { dragItemRef.current = { kind: 'part', id: inst.handle }; e.dataTransfer.effectAllowed = 'move' }}
                onDragEnd={endDrag}
                onDragOver={(e) => {
                  if (dragItemRef.current?.kind !== 'part') return
                  e.preventDefault()
                  e.stopPropagation()  // a row target beats the list's append target
                  setDragOverKey(`part:${inst.handle}`)
                }}
                onDrop={(e) => {
                  if (dragItemRef.current?.kind !== 'part') return
                  e.preventDefault()
                  e.stopPropagation()
                  const moving = dragItemRef.current.id
                  endDrag()
                  if (moving !== inst.handle) onReorderInstance?.(moving, inst.handle)
                }}
              >
                <div className="feature-item-title">
                  <img className="feature-icon" src={featurePartIcon} alt="" />
                  <span className={`feature-name${failMark.failed ? ' feature-name-error' : ''}`}>{label}</span>
                  {/* A fixed part carries the fixed-mate glyph, greyed, after its
                      name -- the mark of the static frame without stealing a row
                      action. Opening the part now lives in the tridot menu. */}
                  {inst.fixed && (
                    <img
                      className="feature-fixed-badge"
                      src={constraintFixedIcon}
                      alt="Fixed"
                      title="Fixed"
                    />
                  )}
                  {/* Row actions are not selections: without stopPropagation the
                      row's onClick would re-select the part these buttons just
                      hid, fixed, or opened a menu on. */}
                  <div className="feature-item-actions">
                    {editing ? (
                      <>
                        <button
                          type="button"
                          className="feature-ok-btn"
                          onClick={(e) => { e.stopPropagation(); onCommitInstance() }}
                          title="OK"
                        >
                          <img src={okIcon} alt="OK" />
                        </button>
                        <button
                          type="button"
                          className="feature-cancel-btn"
                          onClick={(e) => { e.stopPropagation(); onCancelInstance() }}
                          title="Cancel"
                        >
                          <img src={cancelIcon} alt="Cancel" />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="feature-edit-btn"
                          onClick={(e) => { e.stopPropagation(); onEditInstance(inst.handle) }}
                          title="Edit part instance"
                          aria-label="Edit part instance"
                        >
                          <img src={contextEditIcon} alt="Edit" />
                        </button>
                        <button
                          type="button"
                          className="feature-visibility-btn"
                          onClick={(e) => { e.stopPropagation(); onToggleVisible(inst.handle, !visible) }}
                          title={visible ? 'Hide' : 'Show'}
                          aria-label={visible ? 'Hide part' : 'Show part'}
                        >
                          <img src={visible ? iconEyeIcon : iconEyeOffIcon} alt={visible ? 'Visible' : 'Hidden'} />
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      className="feature-context-btn"
                      onClick={(e) => openMenu(e, menuItems)}
                      title="More options"
                      aria-label="Part options"
                    >
                      <img src={iconDotsIcon} alt="Options" />
                    </button>
                  </div>
                </div>
                {editing && renderInstanceEditor(inst)}
              </li>
            )
          })}

          {builtins.length === 0 && instances.length === 0 && (
            <li className="empty">No parts yet.</li>
          )}
        </ul>
      </div>

      <div className="resize-handle" onMouseDown={handleMouseDown} title="Drag to resize" />

      <div className="sidebar-bottom" style={{ height: `${100 - splitPercent}%` }}>
        <div className="sidebar-header"><span>Mates</span></div>
        <ul
          className="features-list"
          onDragOver={(e) => {
            if (dragItemRef.current?.kind !== 'mate') return
            e.preventDefault()
            setDragOverKey('mate:end')
          }}
          onDrop={(e) => {
            if (dragItemRef.current?.kind !== 'mate') return
            e.preventDefault()
            const moving = dragItemRef.current.id
            endDrag()
            onReorderMate?.(moving, null)
          }}
        >
          {mates.map(({ id, mate }) => {
            kindOrdinal[mate.kind] = (kindOrdinal[mate.kind] ?? 0) + 1
            const defaultName = `${MATE_KIND_LABELS[mate.kind] ?? mate.kind} ${kindOrdinal[mate.kind]}`
            const name = mate.label || defaultName
            const mateMark = mateFailure(id, status ?? null, [mate.ref_a.part, mate.ref_b.part])
            // mateFailure owns the cause: 'stale' keeps the legacy unresolved-ref
            // look, a model cause reddens the name with its own message.
            const bareStale = mateMark.cause === 'stale'
            const realCause = mateMark.cause === 'error' || mateMark.cause === 'part'
            const selected = selectedMateId === id
            const related = highlightedMateIds.has(id)
            const editing = editingMateId === id
            const menuItems: ContextMenuItem[] = [
              { label: 'Rename', icon: iconRenameIcon, onClick: () => onRequestRenameMate(id, name) },
              { label: 'Delete', icon: contextDeleteIcon, className: 'danger', onClick: () => onDeleteMate(id) },
            ]
            return (
              <li
                key={id}
                className={`feature-item mate-item${bareStale ? ' stale' : ''}${selected ? ' selected' : ''}${related ? ' related' : ''}${editing ? ' editing' : ''}${dragOverKey === `mate:${id}` ? ' drag-over' : ''}`}
                aria-selected={selected}
                title={mateMark.failed ? mateMark.message : undefined}
                onClick={() => onSelectMate?.(id)}
                draggable={!editing}
                onDragStart={(e) => { dragItemRef.current = { kind: 'mate', id }; e.dataTransfer.effectAllowed = 'move' }}
                onDragEnd={endDrag}
                onDragOver={(e) => {
                  if (dragItemRef.current?.kind !== 'mate') return
                  e.preventDefault()
                  e.stopPropagation()
                  setDragOverKey(`mate:${id}`)
                }}
                onDrop={(e) => {
                  if (dragItemRef.current?.kind !== 'mate') return
                  e.preventDefault()
                  e.stopPropagation()
                  const moving = dragItemRef.current.id
                  endDrag()
                  if (moving !== id) onReorderMate?.(moving, id)
                }}
              >
                <div className="feature-item-title">
                  <img className="feature-icon" src={mateIcon} alt="" />
                  <span className={`feature-name${realCause ? ' feature-name-error' : ''}`}>{name}</span>
                  <div className="feature-item-actions">
                    {editing ? (
                      <>
                        <button
                          type="button"
                          className="feature-ok-btn"
                          onClick={(e) => { e.stopPropagation(); onCommitMate() }}
                          title="OK"
                        >
                          <img src={okIcon} alt="OK" />
                        </button>
                        <button
                          type="button"
                          className="feature-cancel-btn"
                          onClick={(e) => { e.stopPropagation(); onCancelMate() }}
                          title="Cancel"
                        >
                          <img src={cancelIcon} alt="Cancel" />
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="feature-edit-btn"
                        onClick={(e) => { e.stopPropagation(); onEditMate?.(id) }}
                        title="Edit mate"
                        aria-label="Edit mate"
                      >
                        <img src={contextEditIcon} alt="Edit" />
                      </button>
                    )}
                    <button
                      type="button"
                      className="feature-context-btn"
                      onClick={(e) => openMenu(e, menuItems)}
                      title="More options"
                      aria-label="Mate options"
                    >
                      <img src={iconDotsIcon} alt="Options" />
                    </button>
                  </div>
                </div>
                {editing && renderMateEditor({ id, mate })}
              </li>
            )
          })}
          {mates.length === 0 && (
            <li className="empty">No mates yet.</li>
          )}
        </ul>
      </div>

      {menu && (
        <RightClickMenu
          items={menu.items}
          position={menu.position}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
