// The part-instance authoring body. Rendered inline inside the instance's tree
// row, below the pink editing header the tree draws (accept/reject/delete), so
// this component owns only the fields, mirroring the mate editor and the part
// editor's feature editors.
//
// Presentational: grounded and position edits leave through callbacks, so the
// logic (assemblyMutations.ts) stays viewport-free and unit-tested. Orientation
// stays gizmo-driven; only the translation is editable numerically here.

import { useState } from 'react'
import type { PartInstance } from '@/types/cad'

interface PartInstanceEditorProps {
  instance: PartInstance
  onSetGrounded: (grounded: boolean) => void
  onSetPosition: (pos: { tx: number; ty: number; tz: number }) => void
}

type Axis = 'tx' | 'ty' | 'tz'
const AXES: readonly Axis[] = ['tx', 'ty', 'tz']
const AXIS_LABELS: Record<Axis, string> = { tx: 'X', ty: 'Y', tz: 'Z' }

export function PartInstanceEditor({ instance, onSetGrounded, onSetPosition }: PartInstanceEditorProps) {
  // The boxes' own text, not the transform directly: a partial keystroke ("-",
  // "1.") must stay visible rather than snap back to the last committed number.
  // Resynced when a different instance is selected or its transform changes from
  // elsewhere (the gizmo), inline during render rather than in an effect.
  const [text, setText] = useState<Record<Axis, string>>(() => ({
    tx: String(instance.transform.tx),
    ty: String(instance.transform.ty),
    tz: String(instance.transform.tz),
  }))
  const [syncedFor, setSyncedFor] = useState({
    handle: instance.handle, tx: instance.transform.tx, ty: instance.transform.ty, tz: instance.transform.tz,
  })
  const t = instance.transform
  if (syncedFor.handle !== instance.handle || syncedFor.tx !== t.tx || syncedFor.ty !== t.ty || syncedFor.tz !== t.tz) {
    setSyncedFor({ handle: instance.handle, tx: t.tx, ty: t.ty, tz: t.tz })
    setText({ tx: String(t.tx), ty: String(t.ty), tz: String(t.tz) })
  }

  const commitAxis = (axis: Axis, raw: string) => {
    setText(prev => ({ ...prev, [axis]: raw }))
    const next = Number(raw)
    if (raw === '' || Number.isNaN(next)) return  // wait for a complete number
    onSetPosition({ tx: t.tx, ty: t.ty, tz: t.tz, [axis]: next })
  }

  return (
    // Clicks inside the editor must not bubble to the row's select handler.
    <div className="instance-editor" onClick={e => e.stopPropagation()}>
      <label className="instance-param">
        <input
          type="checkbox"
          checked={!!instance.fixed}
          onChange={e => onSetGrounded(e.target.checked)}
        />
        <span>Grounded</span>
      </label>
      <div className="instance-position">
        {AXES.map(axis => (
          <label key={axis} className="instance-axis">
            <span>{AXIS_LABELS[axis]}</span>
            <input
              type="number"
              aria-label={`Position ${AXIS_LABELS[axis]}`}
              value={text[axis]}
              onChange={e => commitAxis(axis, e.target.value)}
            />
          </label>
        ))}
      </div>
    </div>
  )
}
