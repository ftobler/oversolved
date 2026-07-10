import type { PartFeature, PlaneDef, Mutation } from '@/types/cad'
import { PickChip } from '@/components/sketch/PickChip'
import { usePickField } from '@/hooks/usePickField'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { planeLabel } from '@/components/Geometry3D/utils'
import { emitAbsoluteSelectionQuery } from '@/utils/query/selectionId'
import { ExpressionInput } from './widgets/ExpressionInput'

interface PlaneEditorProps {
  feature: PartFeature
  featureDef?: PartFeature
  onMutation: (m: Mutation) => void
  features: PartFeature[]
  partLabels: Record<string, string>
}

export function PlaneEditor({
  feature, featureDef, onMutation, features, partLabels,
}: PlaneEditorProps) {
  const def = (featureDef?.definition as PlaneDef | undefined) ?? { mode: 'offset' }
  const mode = def.mode ?? 'offset'
  const fid = feature.id
  const activePickField = useSketchEditorStore(s => s.activePickField)
  const setActivePickField = useSketchEditorStore(s => s.setActivePickField)
  // This feature renders a variable set of pick chips depending on `mode`, so a
  // single observer is keyed on the central field and dispatches to whichever
  // plane-definition field is active (one hook call, stable across renders).
  const pickingField = activePickField?.featureId === fid ? activePickField.field : null

  usePickField(fid, pickingField ?? '', (selectionId) => {
    const value = emitAbsoluteSelectionQuery(selectionId)
    onMutation({ type: 'set_plane_definition_field', featureId: fid, field: pickingField!, value })
  }, { features })

  const pickChip = (field: string, _kind: 'plane' | 'point' | 'line', value: string | undefined) => {
    const isPicking = pickingField === field
    return (
      <PickChip
        values={value && value !== 'None' ? [value] : []}
        isPicking={isPicking}
        onActivate={() => setActivePickField(isPicking ? null : { featureId: fid, field })}
        onRemove={() => onMutation({ type: 'set_plane_definition_field', featureId: fid, field, value: '' })}
        features={features}
        partLabels={partLabels}
      />
    )
  }
  const numField = (field: 'offset' | 'angle' | 'rotation', label: string, defaultVal: number) => (
    <div className="feature-field-row">
      <span className="feature-field-label">{label}</span>
      <ExpressionInput
        value={def[field] ?? defaultVal}
        ariaLabel={label}
        onChange={(v) => onMutation({ type: 'set_plane_definition_field', featureId: fid, field, value: v })}
      />
    </div>
  )

  return (
    <div className="plane-editor">
      <div className="feature-field-row">
        <span className="feature-field-label">Type</span>
        <select
          className="feature-field-select"
          value={mode}
          onChange={(e) => { e.stopPropagation(); onMutation({ type: 'set_plane_definition_field', featureId: fid, field: 'mode', value: e.target.value }) }}
          onClick={(e) => e.stopPropagation()}
        >
          <option value="offset">Offset from plane</option>
          <option value="plane_point">Plane through point</option>
          <option value="three_point">Three-point plane</option>
          <option value="line_angle">Rotate on line</option>
          <option value="edge_point">Line and point</option>
          <option value="on_face">On face</option>
        </select>
      </div>
      {mode === 'offset' && (
        <>
          <div className="feature-field-row feature-field-row--stacked">
            <span className="feature-field-label">Plane</span>
            {pickChip('plane', 'plane', planeLabel(def.plane))}
          </div>
          {numField('offset', 'Offset', 0)}
        </>
      )}
      {mode === 'plane_point' && (
        <>
          <div className="feature-field-row feature-field-row--stacked">
            <span className="feature-field-label">Plane</span>
            {pickChip('plane', 'plane', planeLabel(def.plane))}
          </div>
          <div className="feature-field-row feature-field-row--stacked">
            <span className="feature-field-label">Point</span>
            {pickChip('point', 'point', def.point)}
          </div>
        </>
      )}
      {mode === 'three_point' && (['p1', 'p2', 'p3'] as const).map((field, i) => (
        <div key={field} className="feature-field-row feature-field-row--stacked">
          <span className="feature-field-label">P{i + 1}</span>
          {pickChip(field, 'point', def[field])}
        </div>
      ))}
      {mode === 'line_angle' && (
        <>
          <div className="feature-field-row feature-field-row--stacked">
            <span className="feature-field-label">Line</span>
            {pickChip('line', 'line', def.line)}
          </div>
          {numField('angle', 'Angle', 0)}
        </>
      )}
      {mode === 'edge_point' && (
        <>
          <div className="feature-field-row feature-field-row--stacked">
            <span className="feature-field-label">Line</span>
            {pickChip('edge', 'line', def.edge)}
          </div>
          <div className="feature-field-row feature-field-row--stacked">
            <span className="feature-field-label">Point</span>
            {pickChip('point', 'point', def.point)}
          </div>
        </>
      )}
      {mode === 'on_face' && (
        <div className="feature-field-row feature-field-row--stacked">
          <span className="feature-field-label">Face</span>
          {pickChip('face', 'plane', def.face)}
        </div>
      )}
      {numField('rotation', 'Rotation', 0)}
    </div>
  )
}
