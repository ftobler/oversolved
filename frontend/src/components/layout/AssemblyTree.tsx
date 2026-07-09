import { useState } from 'react'
import type { PartInstance, MateFeature, MateKind } from '@/types/cad'
import type { MateResult } from '@/kernel/solveAssembly'
import { MATE_KINDS, MATE_KIND_LABELS, mateSummary } from '@/utils/mateKinds'

interface AssemblyTreeProps {
  instances: PartInstance[]
  mates: MateFeature[]
  // Per-mate solve outcome, keyed by feature id. A stale mate renders red.
  mateResults?: Record<string, MateResult>
  // Map from a part handle to a display label (part doc name), when known.
  labelFor?: (handle: string) => string | undefined
  // The selected instance is the one the transform triad attaches to (Stage 6d).
  selectedHandle?: string | null
  selectedMateId?: string | null
  onSelectPart?: (handle: string) => void
  onInsertPart: () => void
  onOpenPart: (handle: string) => void
  onDeleteInstance: (handle: string) => void
  onToggleVisible: (handle: string, visible: boolean) => void
  onToggleFixed: (handle: string, fixed: boolean) => void
  onInsertMate?: (kind: MateKind) => void
  onSelectMate?: (featureId: string) => void
}

// The assembly's feature tree: part instances (with visibility / ground / open
// / delete controls) and mates. Presentational only; all mutations flow back
// through the callbacks so the logic stays viewport-free and testable.
export function AssemblyTree({
  instances,
  mates,
  mateResults,
  labelFor,
  selectedHandle,
  selectedMateId,
  onSelectPart,
  onInsertPart,
  onOpenPart,
  onDeleteInstance,
  onToggleVisible,
  onToggleFixed,
  onInsertMate,
  onSelectMate,
}: AssemblyTreeProps) {
  const [kindMenuOpen, setKindMenuOpen] = useState(false)
  return (
    <div className="assembly-tree">
      <div className="assembly-tree-header">
        <span>Parts ({instances.length})</span>
        <button
          type="button"
          className="assembly-tree-insert-btn"
          onClick={onInsertPart}
          title="Insert part"
          aria-label="Insert part"
        >
          <span className="material-icons-outlined">add</span>
        </button>
      </div>

      <ul className="assembly-tree-list">
        {instances.map(inst => {
          const visible = inst.visible !== false
          const label = labelFor?.(inst.handle) || inst.doc_id
          const selected = selectedHandle === inst.handle
          return (
            <li
              key={inst.handle}
              className={`assembly-tree-instance${selected ? ' selected' : ''}`}
              aria-selected={selected}
              onClick={() => onSelectPart?.(inst.handle)}
            >
              <button
                type="button"
                className="assembly-tree-open-btn"
                onClick={() => onOpenPart(inst.handle)}
                title="Open part"
              >
                {label}{inst.fixed ? ' (fixed)' : ''}
              </button>
              {/* Row actions are not selections: without stopPropagation the
                  row's onClick would re-select the part these buttons just hid,
                  grounded, or deleted. */}
              <button
                type="button"
                className="assembly-tree-icon-btn"
                onClick={(e) => { e.stopPropagation(); onToggleVisible(inst.handle, !visible) }}
                title={visible ? 'Hide' : 'Show'}
                aria-label={visible ? 'Hide part' : 'Show part'}
              >
                <span className="material-icons-outlined">
                  {visible ? 'visibility' : 'visibility_off'}
                </span>
              </button>
              <button
                type="button"
                className={`assembly-tree-icon-btn${inst.fixed ? ' active' : ''}`}
                onClick={(e) => { e.stopPropagation(); onToggleFixed(inst.handle, !inst.fixed) }}
                title={inst.fixed ? 'Unground' : 'Ground (fix)'}
                aria-label={inst.fixed ? 'Unground part' : 'Ground part'}
              >
                <span className="material-icons-outlined">
                  {inst.fixed ? 'lock' : 'lock_open'}
                </span>
              </button>
              <button
                type="button"
                className="assembly-tree-icon-btn"
                onClick={(e) => { e.stopPropagation(); onDeleteInstance(inst.handle) }}
                title="Delete"
                aria-label="Delete part"
              >
                <span className="material-icons-outlined">delete</span>
              </button>
            </li>
          )
        })}
        {instances.length === 0 && (
          <li className="assembly-tree-empty">No parts yet.</li>
        )}
      </ul>

      <div className="assembly-tree-header">
        <span>Mates ({mates.length})</span>
        {onInsertMate && (
          <button
            type="button"
            className="assembly-tree-insert-btn"
            onClick={() => setKindMenuOpen(o => !o)}
            title="Insert mate"
            aria-label="Insert mate"
            aria-expanded={kindMenuOpen}
          >
            <span className="material-icons-outlined">add</span>
          </button>
        )}
      </div>

      {kindMenuOpen && onInsertMate && (
        <ul className="assembly-tree-list mate-kind-menu">
          {MATE_KINDS.map(kind => (
            <li key={kind}>
              <button
                type="button"
                className="mate-kind-option"
                onClick={() => { setKindMenuOpen(false); onInsertMate(kind) }}
              >
                {MATE_KIND_LABELS[kind]}
              </button>
            </li>
          ))}
        </ul>
      )}

      <ul className="assembly-tree-list">
        {mates.map(({ id, mate }) => {
          const stale = !!mateResults?.[id]?.stale
          const selected = selectedMateId === id
          return (
            <li
              key={id}
              className={`assembly-tree-mate${stale ? ' stale' : ''}${selected ? ' selected' : ''}`}
              aria-selected={selected}
              title={stale ? 'A reference no longer resolves; re-pick it.' : undefined}
              onClick={() => onSelectMate?.(id)}
            >
              {mateSummary(mate.kind, mate.ref_a, mate.ref_b, labelFor)}
            </li>
          )
        })}
        {mates.length === 0 && (
          <li className="assembly-tree-empty">No mates yet.</li>
        )}
      </ul>
    </div>
  )
}
