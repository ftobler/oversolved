import type { PartInstance, MateFeatureDef } from '@/types/cad'

interface AssemblyTreeProps {
  instances: PartInstance[]
  mates: MateFeatureDef[]
  // Map from a part handle to a display label (part doc name), when known.
  labelFor?: (handle: string) => string
  // The selected instance is the one the transform triad attaches to (Stage 6d).
  selectedHandle?: string | null
  onSelectPart?: (handle: string) => void
  onInsertPart: () => void
  onOpenPart: (handle: string) => void
  onDeleteInstance: (handle: string) => void
  onToggleVisible: (handle: string, visible: boolean) => void
  onToggleFixed: (handle: string, fixed: boolean) => void
}

// The assembly's feature tree: part instances (with visibility / ground / open
// / delete controls) and mates. Presentational only; all mutations flow back
// through the callbacks so the logic stays viewport-free and testable.
export function AssemblyTree({
  instances,
  mates,
  labelFor,
  selectedHandle,
  onSelectPart,
  onInsertPart,
  onOpenPart,
  onDeleteInstance,
  onToggleVisible,
  onToggleFixed,
}: AssemblyTreeProps) {
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
              <button
                type="button"
                className="assembly-tree-icon-btn"
                onClick={() => onToggleVisible(inst.handle, !visible)}
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
                onClick={() => onToggleFixed(inst.handle, !inst.fixed)}
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
                onClick={() => onDeleteInstance(inst.handle)}
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
      </div>
      <ul className="assembly-tree-list">
        {mates.map((m, i) => (
          <li key={i} className="assembly-tree-mate">
            {m.kind}: {m.ref_a.part}/{m.ref_a.anchor} - {m.ref_b.part}/{m.ref_b.anchor}
          </li>
        ))}
        {mates.length === 0 && (
          <li className="assembly-tree-empty">No mates yet.</li>
        )}
      </ul>
    </div>
  )
}
