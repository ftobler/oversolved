// The part-instance authoring body. Rendered inline inside the instance's tree
// row, below the pink editing header the tree draws (accept/reject/delete), so
// this component owns only the fields, mirroring the mate editor and the part
// editor's feature editors.
//
// Presentational: grounded, position and rotation edits leave through
// callbacks, so the logic (assemblyMutations.ts) stays viewport-free and
// unit-tested.
//
// The rotation row is the ONLY orientation control a grounded part has: the
// triad gizmo is refused for a `fixed` instance (isManipulable,
// partManipulation.ts), so a part grounded at the wrong angle would otherwise
// be stuck there forever, with the whole assembly mated onto a frame nobody can
// aim. Degrees, extrinsic XYZ (quatFromEulerXyz), matching the mate editor's
// angle unit.

import { useState } from 'react'
import type { PartInstance } from '@/types/cad'
import { instanceRotation, type EulerDeg } from '@/utils/assemblyMutations'

interface PartInstanceEditorProps {
  instance: PartInstance
  onSetGrounded: (grounded: boolean) => void
  onSetPosition: (pos: { tx: number; ty: number; tz: number }) => void
  onSetRotation: (euler: EulerDeg) => void
}

type Axis = 'tx' | 'ty' | 'tz'
const AXES: readonly Axis[] = ['tx', 'ty', 'tz']
const AXIS_LABELS: Record<Axis, string> = { tx: 'X', ty: 'Y', tz: 'Z' }

type RotAxis = 'rx' | 'ry' | 'rz'
const ROT_AXES: readonly RotAxis[] = ['rx', 'ry', 'rz']
const ROT_LABELS: Record<RotAxis, string> = { rx: 'RX', ry: 'RY', rz: 'RZ' }

/** Degrees are round-tripped through a quaternion, so 90 can come back 89.999...
 *  3 decimals is far below anything visible and keeps the boxes readable. */
function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}

export function PartInstanceEditor({
  instance, onSetGrounded, onSetPosition, onSetRotation,
}: PartInstanceEditorProps) {
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

  // Rotation carries the same dirty-text discipline, but keys the resync on the
  // QUATERNION rather than on the degrees, because degrees are derived: the
  // stored quaternion is the only thing that says whether the orientation
  // actually changed. `rotSyncedFor` holds the quaternion last OBSERVED from
  // props -- not one predicted from our own commit. Predicting is what breaks
  // when the parent stores something other than the exact quaternion sent
  // (a rejected edit, a bake, a clamp): the boxes would silently snap back to a
  // number the user never typed.
  const [rotText, setRotText] = useState<Record<RotAxis, string>>(() => {
    const r = instanceRotation(instance)
    return { rx: String(round3(r.rx)), ry: String(round3(r.ry)), rz: String(round3(r.rz)) }
  })
  const [rotSyncedFor, setRotSyncedFor] = useState({
    handle: instance.handle, qx: t.qx, qy: t.qy, qz: t.qz, qw: t.qw,
  })
  if (
    rotSyncedFor.handle !== instance.handle ||
    rotSyncedFor.qx !== t.qx || rotSyncedFor.qy !== t.qy ||
    rotSyncedFor.qz !== t.qz || rotSyncedFor.qw !== t.qw
  ) {
    const r = instanceRotation(instance)
    setRotSyncedFor({ handle: instance.handle, qx: t.qx, qy: t.qy, qz: t.qz, qw: t.qw })
    setRotText({ rx: String(round3(r.rx)), ry: String(round3(r.ry)), rz: String(round3(r.rz)) })
  }

  const commitRot = (axis: RotAxis, raw: string) => {
    const nextText = { ...rotText, [axis]: raw }
    setRotText(nextText)
    if (raw === '' || Number.isNaN(Number(raw))) return  // wait for a complete number
    // The other two axes come from what is TYPED, not from the stored
    // quaternion: at gimbal lock the readback is a different (equivalent)
    // triple, and feeding it back would rewrite angles the user did not touch.
    onSetRotation({
      rx: Number(nextText.rx) || 0,
      ry: Number(nextText.ry) || 0,
      rz: Number(nextText.rz) || 0,
    })
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
      <div className="instance-position">
        {ROT_AXES.map(axis => (
          <label key={axis} className="instance-axis">
            <span>{ROT_LABELS[axis]}&deg;</span>
            <input
              type="number"
              aria-label={`Rotation ${ROT_LABELS[axis]}`}
              value={rotText[axis]}
              onChange={e => commitRot(axis, e.target.value)}
            />
          </label>
        ))}
      </div>
    </div>
  )
}
