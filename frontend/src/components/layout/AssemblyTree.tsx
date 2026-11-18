import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import type { AssemblyDoc, PartInstance, MateFeature, PartFeature } from '@/types/cad'
import type { AssemblySolveStatus } from '@/kernel/solveAssembly'
import { mateFailure, partFailure, assemblyVerdict } from '@/utils/core/assemblyStatus'
import { markNameClass } from '@/utils/core/statusMark'
import type { AssemblyBuiltinListItem } from '@/utils/assemblyRender'
import { readSelection, type AssemblySubject } from '@/utils/assemblySelection'
import {
  buildAssemblyTree,
  leafPathOf,
  type AssemblyTreeNode,
} from '@/utils/assemblyTreeModel'
import { hintDrivers, relatedHints } from '@/picking/relationHint'
import { ASSEMBLY_RULES, buildAssemblyRelationCtx } from '@/registry/relationRuleRegistry'
import { MATE_KIND_LABELS } from '@/utils/mateKinds'
import { getFeatureIcon } from '@/components/layout/featureIcons'
import RightClickMenu, { type ContextMenuItem } from '@/components/dialogs/RightClickMenu'
import { RebuildButton } from '@/components/rebuild/RebuildButton'
import featurePartIcon from '@/assets/icons/feature-part.svg'
import contextEditIcon from '@/assets/icons/context-edit.svg'
import contextDeleteIcon from '@/assets/icons/context-delete.svg'
import contextDuplicateIcon from '@/assets/icons/context-duplicate.svg'
import contextHideIcon from '@/assets/icons/context-hide.svg'
import iconRenameIcon from '@/assets/icons/rename.svg'
import okIcon from '@/assets/icons/dialog-ok.svg'
import cancelIcon from '@/assets/icons/dialog-cancel.svg'
import iconEyeIcon from '@/assets/icons/icon-eye.svg'
import iconEyeOffIcon from '@/assets/icons/icon-eye-off.svg'
import iconDotsIcon from '@/assets/icons/dots.svg'
import constraintFixedIcon from '@/assets/icons/constraint-fixed.svg'
import mateIcon from '@/assets/icons/constraint-coincident.svg'

// The tree has no entity selection of its own; the accessor still wants the
// orthogonal set, and a shared empty instance keeps the read allocation-free.
const EMPTY_ENTITIES: ReadonlySet<string> = new Set()

// The assembly rebuild has no per-feature timing table yet: the button shares the
// part editor's popover, which hides itself when it has nothing to show. Shared
// empties keep the hover machinery from seeing a new value every render.
const EMPTY_TIMINGS: Record<string, number> = {}
const EMPTY_FEATURES: PartFeature[] = []

export interface AssemblyTreeProps {
  instances: PartInstance[]
  // The assembly's own origin and reference planes, hidden by default.
  builtins: AssemblyBuiltinListItem[]
  mates: MateFeature[]
  // The whole solve verdict. A failed part or mate renders red on its row.
  status?: AssemblySolveStatus | null
  // Rebuild every part bundle from its current document and re-solve: the part
  // editor's Rebuild action in assembly terms. Absent when no solve hook is
  // wired, which is why the header renders no button then.
  onRebuild?: () => void
  // A full (non-live) assembly solve is running. The page mirrors the solver
  // store's flag, so the button spins and cannot start a second rebuild.
  isRebuilding?: boolean
  // Map from a part handle to a display label (the part document's name).
  labelFor?: (handle: string) => string | undefined
  // The workspace's assembly documents by doc id, loaded for the tree's child
  // rows. `null` is a document that could not be read (a failed row);
  // `undefined` is still loading.
  subassemblies?: Record<string, AssemblyDoc | null>
  // Whether a doc id names a part or an assembly. Absent means every instance is
  // a part, which keeps the pre-tree callers working.
  docKindOf?: (docId: string) => 'part' | 'assembly' | undefined
  // Doc id -> display name, for child rows whose handle is not a top-level one.
  docNames?: Record<string, string>
  // The child leaves hidden for viewing, keyed by the full handle path.
  hiddenLeafPaths?: ReadonlySet<string>
  onSetLeafVisible?: (key: string, visible: boolean) => void
  // The tree subject: at most one part handle or mate id. The union makes "both
  // a part and a mate selected" unrepresentable, so cross-highlight and the row
  // `.selected` read derive from one slot instead of two independent fields.
  subject?: AssemblySubject | null
  // The mate whose editor is open. Opened from the row's edit action, not a
  // plain click, so a click can select without diving into the parameter form.
  editingMateId?: string | null
  // The instance whose editor is open.
  editingInstanceHandle?: string | null
  // A child row selects the top-level instance (what moves) plus its leaf path.
  onSelectPart?: (handle: string, leafPath?: string) => void
  // Drag-reorder callbacks. `beforeHandle`/`beforeId` name the row the dragged
  // item is dropped in front of, or null when dropped past the last row of its
  // list. The owner persists the new order in the document's feature array.
  onReorderInstance?: (movingHandle: string, beforeHandle: string | null) => void
  onReorderMate?: (movingId: string, beforeId: string | null) => void
  // `docId` is the child document for a sub-assembly row; absent means the
  // top-level instance's own doc_id, which the owner resolves from the handle.
  onOpenPartNewTab: (handle: string, docId?: string) => void
  onDuplicateInstance: (handle: string) => void
  onDeleteInstance: (handle: string) => void
  onToggleVisible: (handle: string, visible: boolean) => void
  onToggleFixed: (handle: string, fixed: boolean) => void
  onToggleBuiltinVisible: (id: string, visible: boolean) => void
  onEditInstance: (handle: string) => void
  onCommitInstance: () => void
  onCancelInstance: () => void
  onSelectMate?: (featureId: string) => void
  // Open the mate's editor (the row's pencil action).
  onEditMate?: (featureId: string) => void
  onCommitMate: () => void
  onCancelMate: () => void
  onDeleteMate: (featureId: string) => void
  // A rename gesture only names its subject; the owner collects the new label in
  // a dialog, the same split the part editor's context menu uses. The current
  // name is what the row shows: the mate's stored label, or the bare kind label
  // for a legacy mate that never had one.
  onRequestRenameMate: (featureId: string, currentName: string) => void
}

// The assembly's feature tree, styled to mirror the part editor: a Parts card
// of origin planes and part instances (the "Features" analog) over a Mates card
// (the "Parts" analog), both placed by AssemblyDocumentPanel as floating glass
// cards. An edited row keeps the pink `.editing` highlight and its own
// OK/Cancel pair, but grows no form: the editor body lives in the right card
// (AssemblyEditPanel.tsx). Row actions use the part editor's svg glyphs, and the
// tridot opens the same RightClickMenu. Presentational only; all mutations flow
// back through the callbacks so the logic stays viewport-free and testable.
export function AssemblyTree({
  instances,
  builtins,
  mates,
  status,
  onRebuild,
  isRebuilding,
  labelFor,
  subassemblies,
  docKindOf,
  docNames,
  hiddenLeafPaths,
  onSetLeafVisible,
  subject,
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
  onSelectMate,
  onEditMate,
  onCommitMate,
  onCancelMate,
  onDeleteMate,
  onRequestRenameMate,
}: AssemblyTreeProps) {
  const [menu, setMenu] = useState<{ position: [number, number]; items: ContextMenuItem[] } | null>(null)

  // Expanded sub-assembly rows are a view state keyed by the handle path, not a
  // document write and not an undo step. A new document starts folded.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const toggleExpanded = useCallback((key: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const tree = useMemo(() => buildAssemblyTree(instances, {
    docFor: docId => (subassemblies !== undefined && docId in subassemblies ? subassemblies[docId] : undefined),
    kindOf: docId => docKindOf?.(docId),
    nameOf: (handle, docId) => labelFor?.(handle) ?? docNames?.[docId] ?? docId,
  }), [instances, subassemblies, docKindOf, labelFor, docNames])

  // The row picked up by an HTML5 drag. Held in a ref, not state: it changes only
  // at drag start/end and the reorder reads it on drop, so it never needs to
  // re-render. `dragOverKey` does drive a render -- it paints the drop indicator.
  const dragItemRef = useRef<{ kind: 'part' | 'mate'; id: string } | null>(null)
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)
  const endDrag = useCallback(() => {
    dragItemRef.current = null
    setDragOverKey(null)
  }, [])

  const openMenu = (e: ReactMouseEvent, items: ContextMenuItem[]) => {
    e.stopPropagation()
    setMenu({ position: [e.clientX, e.clientY], items })
  }

  // Enter/Space on a focused row selects it, mirroring the row's click. Only the
  // row itself reacts: a key event bubbling from a row action must not re-select
  // the subject the action belongs to.
  const rowKeyDown = (e: ReactKeyboardEvent<HTMLLIElement>, select: () => void) => {
    if (e.target !== e.currentTarget) return
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    e.stopPropagation()
    select()
  }

  // Cross-highlight: a selected part row lights up the mates that reference it,
  // and a selected mate row lights up the parts it mates. Every selected part
  // and the selected mate are drivers (the subject union keeps one of each at
  // most), so widening the subject to a multi-part set needs no change here.
  // Both panes read the same rule table and the same tree answer.
  const view = useMemo(() => readSelection(subject ?? null, EMPTY_ENTITIES), [subject])
  const drivers = useMemo(
    () => (view.mate === null ? [...view.parts] : [...view.parts, view.mate]),
    [view],
  )
  const relatedIds = useMemo(
    () => relatedHints(hintDrivers(drivers), ASSEMBLY_RULES, buildAssemblyRelationCtx(mates)).tree,
    [drivers, mates],
  )

  // The same display name each mate row shows (stored label, or the bare kind
  // label for a legacy mate), so the verdict banner names the mates the user
  // sees instead of their raw solve ids.
  const mateNames = useMemo(() => {
    const names = new Map<string, string>()
    for (const { id, mate } of mates) names.set(id, mate.label || MATE_KIND_LABELS[mate.kind])
    return names
  }, [mates])

  // The whole-assembly verdict, shown on a root row: overconstrained is a hard
  // error, underconstrained a warning that the assembly is valid but still has
  // freedom. Fully constrained and trivial solves carry no mark.
  const verdictMark = assemblyVerdict(status ?? null, id => mateNames.get(id))

  // One sub-assembly's children, folded behind its chevron. A child is owned by
  // the child document: it can be selected, its view eye toggled and it can be
  // opened in a new tab, but it cannot be edited, deleted, reordered or
  // re-fixed here. Selecting it selects the top-level instance that moves.
  const renderDescendants = (node: AssemblyTreeNode, topHandle: string): ReactNode => {
    if (node.children.length === 0 || !expanded.has(node.key)) return null
    return (
      <ul className="features-list assembly-subtree" role="group" aria-label={`${node.label} contents`}>
        {node.children.map(child => {
          const hidden = hiddenLeafPaths?.has(child.key) ?? false
          const selected = view.parts.has(topHandle) && view.leafPath === leafPathOf(child)
          const expandable = child.children.length > 0
          const childMenu: ContextMenuItem[] = [
            {
              label: 'Open in new tab',
              icon: featurePartIcon,
              onClick: () => onOpenPartNewTab(topHandle, child.docId),
            },
          ]
          return (
            <li
              key={child.key}
              className={`feature-item subassembly-row${selected ? ' selected' : ''}${hidden ? ' invisible' : ''}${child.failed ? ' failed' : ''}`}
              role="option"
              tabIndex={0}
              aria-selected={selected}
              title={child.failed ? `${child.label} could not be read` : undefined}
              onClick={(e) => {
                e.stopPropagation()
                onSelectPart?.(topHandle, leafPathOf(child))
              }}
              onKeyDown={(e) => {
                e.stopPropagation()
                rowKeyDown(e, () => onSelectPart?.(topHandle, leafPathOf(child)))
              }}
            >
              <div className="feature-item-title" style={{ paddingLeft: `${8 + Math.max(0, child.depth - 1) * 14}px` }}>
                {expandable ? (
                  <button
                    type="button"
                    className="subassembly-chevron"
                    onClick={(e) => { e.stopPropagation(); toggleExpanded(child.key) }}
                    aria-label={`${expanded.has(child.key) ? 'Collapse' : 'Expand'} ${child.label}`}
                    aria-expanded={expanded.has(child.key)}
                    title={expanded.has(child.key) ? 'Collapse' : 'Expand'}
                  >
                    <span className="material-icons">{expanded.has(child.key) ? 'expand_more' : 'chevron_right'}</span>
                  </button>
                ) : (
                  <span className="subassembly-chevron-spacer" aria-hidden="true" />
                )}
                {child.kind === 'assembly'
                  ? <span className="material-icons feature-icon subassembly-node-icon" aria-hidden="true">account_tree</span>
                  : <img className="feature-icon" src={featurePartIcon} alt="" />}
                <span className={`feature-name${child.failed ? ' failed' : ''}`}>{child.label}</span>
                <div className="feature-item-actions">
                  <button
                    type="button"
                    className="feature-visibility-btn"
                    onClick={(e) => { e.stopPropagation(); onSetLeafVisible?.(child.key, hidden) }}
                    title={hidden ? 'Show' : 'Hide'}
                    aria-label={hidden ? `Show ${child.label}` : `Hide ${child.label}`}
                  >
                    <img src={hidden ? iconEyeOffIcon : iconEyeIcon} alt={hidden ? 'Hidden' : 'Visible'} />
                  </button>
                  <button
                    type="button"
                    className="feature-context-btn"
                    onClick={(e) => openMenu(e, childMenu)}
                    title="More options"
                    aria-label={`${child.label} options`}
                  >
                    <img src={iconDotsIcon} alt="Options" />
                  </button>
                </div>
              </div>
              {renderDescendants(child, topHandle)}
            </li>
          )
        })}
      </ul>
    )
  }

  return (
    <>
      <div className="sidebar-top glass-panel assembly-panel">
        <div className="sidebar-header">
          <span>Parts</span>
          {onRebuild && (
            <RebuildButton
              featureTimings={EMPTY_TIMINGS}
              features={EMPTY_FEATURES}
              onClick={onRebuild}
              isLoading={isRebuilding}
              title="Rebuild assembly (rebuilds every part, clears cache)"
            />
          )}
        </div>
        {verdictMark.level && (
          <div
            className={`assembly-verdict assembly-verdict-${verdictMark.level}`}
            role="status"
            title={verdictMark.message}
            data-verdict={verdictMark.verdict}
          >
            <span className="assembly-verdict-name">Assembly</span>
            <span className={`feature-name${markNameClass(verdictMark)}`}>
              {verdictMark.message}
            </span>
          </div>
        )}
        <ul
          className="features-list"
          role="listbox"
          aria-label="Parts"
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
            <li key={b.id} role="presentation" className={`feature-item builtin${b.visible ? '' : ' invisible'}`}>
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

          {instances.map((inst, index) => {
            const node = tree[index]
            const isAssembly = node?.kind === 'assembly'
            const visible = inst.visible !== false
            const label = labelFor?.(inst.handle) || inst.doc_id
            const selected = view.parts.has(inst.handle)
            const related = relatedIds.has(inst.handle)
            const editing = editingInstanceHandle === inst.handle
            const failMark = partFailure(inst.handle, status ?? null)
            const menuItems: ContextMenuItem[] = [
              // A failed part is the one row with a repair action of its own:
              // its editor holds the Part picker, which waits on the missing
              // doc_id as soon as the row opens.
              ...(failMark.failed
                ? [{ label: 'Rebind part', icon: featurePartIcon, onClick: () => onEditInstance(inst.handle) }]
                : []),
              { label: 'Open in new tab', icon: featurePartIcon, onClick: () => onOpenPartNewTab(inst.handle, inst.doc_id) },
              { label: 'Duplicate', icon: contextDuplicateIcon, onClick: () => onDuplicateInstance(inst.handle) },
              { label: visible ? 'Hide' : 'Show', icon: contextHideIcon, onClick: () => onToggleVisible(inst.handle, !visible) },
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
                role="option"
                tabIndex={0}
                aria-selected={selected}
                title={failMark.level ? failMark.message : undefined}
                onClick={() => onSelectPart?.(inst.handle)}
                onKeyDown={(e) => rowKeyDown(e, () => onSelectPart?.(inst.handle))}
                // Not draggable while its editor is open: a reorder mid-edit is
                // not a requested gesture, and the edited row is the anchor the
                // right card is describing.
                draggable={!editing}
                onDragStart={(e) => { dragItemRef.current = { kind: 'part', id: inst.handle }; e.dataTransfer.effectAllowed = 'move' }}
                onDragEnd={endDrag}
                onDragOver={(e) => {
                  if (dragItemRef.current?.kind !== 'part') return
                  e.preventDefault()
                  e.stopPropagation()  // a row target beats the list's append target
                  // Moving a part into a child document is out of scope: a
                  // sub-assembly row is not a drop target and paints no marker.
                  if (!isAssembly) setDragOverKey(`part:${inst.handle}`)
                }}
                onDrop={(e) => {
                  if (dragItemRef.current?.kind !== 'part') return
                  e.preventDefault()
                  e.stopPropagation()
                  const moving = dragItemRef.current.id
                  endDrag()
                  if (!isAssembly && moving !== inst.handle) onReorderInstance?.(moving, inst.handle)
                }}
              >
                <div className="feature-item-title">
                  {node?.children.length ? (
                    <button
                      type="button"
                      className="subassembly-chevron"
                      onClick={(e) => { e.stopPropagation(); toggleExpanded(node.key) }}
                      aria-label={`${expanded.has(node.key) ? 'Collapse' : 'Expand'} ${label}`}
                      aria-expanded={expanded.has(node.key)}
                      title={expanded.has(node.key) ? 'Collapse' : 'Expand'}
                    >
                      <span className="material-icons">{expanded.has(node.key) ? 'expand_more' : 'chevron_right'}</span>
                    </button>
                  ) : (
                    <span className="subassembly-chevron-spacer" aria-hidden="true" />
                  )}
                  {isAssembly
                    ? <span className="material-icons feature-icon subassembly-node-icon" aria-hidden="true">account_tree</span>
                    : <img className="feature-icon" src={featurePartIcon} alt="" />}
                  <span className={`feature-name${markNameClass(failMark)}`}>{label}</span>
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
                {node && renderDescendants(node, inst.handle)}
              </li>
            )
          })}

          {builtins.length === 0 && instances.length === 0 && (
            <li className="empty" role="presentation">No parts yet.</li>
          )}
        </ul>
      </div>

      <div className="sidebar-bottom glass-panel assembly-panel">
        <div className="sidebar-header"><span>Mates</span></div>
        <ul
          className="features-list"
          role="listbox"
          aria-label="Mates"
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
            // The label is stored on the mate at append time, so this fallback
            // only serves legacy docs that never had one; the tree deliberately
            // keeps no render ordinal, which is what used to renumber a mate
            // when an earlier sibling of the same kind was deleted.
            const name = mate.label || MATE_KIND_LABELS[mate.kind]
            const mateMark = mateFailure(id, status ?? null, [mate.ref_a.part, mate.ref_b.part])
            // mateFailure owns the cause: 'stale' keeps the legacy unresolved-ref
            // look, a model cause reddens the name with its own message.
            const bareStale = mateMark.cause === 'stale'
            const selected = view.mate === id
            const related = relatedIds.has(id)
            const editing = editingMateId === id
            const menuItems: ContextMenuItem[] = [
              { label: 'Rename', icon: iconRenameIcon, onClick: () => onRequestRenameMate(id, name) },
              { label: 'Delete', icon: contextDeleteIcon, className: 'danger', onClick: () => onDeleteMate(id) },
            ]
            return (
              <li
                key={id}
                className={`feature-item mate-item${bareStale ? ' stale' : ''}${selected ? ' selected' : ''}${related ? ' related' : ''}${editing ? ' editing' : ''}${dragOverKey === `mate:${id}` ? ' drag-over' : ''}`}
                role="option"
                tabIndex={0}
                aria-selected={selected}
                title={mateMark.level ? mateMark.message : undefined}
                onClick={() => onSelectMate?.(id)}
                onKeyDown={(e) => rowKeyDown(e, () => onSelectMate?.(id))}
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
                  <span className={`feature-name${bareStale ? '' : markNameClass(mateMark)}`}>{name}</span>
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
              </li>
            )
          })}
          {mates.length === 0 && (
            <li className="empty" role="presentation">No mates yet.</li>
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
    </>
  )
}
