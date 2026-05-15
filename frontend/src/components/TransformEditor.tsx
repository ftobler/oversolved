import type { PartFeature, Mutation, PendingPickField } from '@/types/cad'
import { PickChip } from '@/components/PickChip'

interface TransformEditorProps {
  feature: PartFeature
  onMutation: (m: Mutation) => void
  pendingPickField: PendingPickField | null
  setPendingPickField: (field: PendingPickField | null) => void
  features?: PartFeature[]
  partLabels?: Record<string, string>
}

export function TransformEditor({ feature, onMutation, pendingPickField, setPendingPickField, features, partLabels }: TransformEditorProps) {
  const transform = feature.transform ?? { body: '', operation: 'new', translation: [0, 0, 0], rotation_angle: 0, scale: 1 }
  const fid = feature.id

  const isPicking = (field: string) => pendingPickField?.featureId === fid && pendingPickField.field === field

  const numField = (label: string, value: number | undefined, onBlur: (v: number) => void) => (
    <div className="feature-field-row">
      <span className="feature-field-label">{label}</span>
      <input
        type="number"
        className="feature-field-input"
        defaultValue={value ?? 0}
        onClick={(e) => e.stopPropagation()}
        onBlur={(e) => {
          const v = parseFloat(e.target.value)
          if (!isNaN(v)) onBlur(v)
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
      />
    </div>
  )

  return (
    <div className="plane-editor">
      <div className="feature-field-row feature-field-row--stacked">
        <span className="feature-field-label">Body</span>
        <PickChip
          values={transform.body ? [transform.body] : []}
          isPicking={isPicking('body')}
          onActivate={() => {
            if (isPicking('body')) setPendingPickField(null)
            else setPendingPickField({ featureId: fid, field: 'body', hostKind: 'transform' })
          }}
          onRemove={() => onMutation({ type: 'set_transform_field', featureId: fid, field: 'body', value: '' })}
          features={features}
          partLabels={partLabels}
        />
      </div>
      <div className="feature-field-row">
        <span className="feature-field-label">Operation</span>
        <select
          className="feature-field-select"
          value={transform.operation ?? 'new'}
          onChange={(e) => {
            e.stopPropagation()
            onMutation({ type: 'set_transform_field', featureId: fid, field: 'operation', value: e.target.value })
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <option value="new">New</option>
          <option value="replace">Replace</option>
        </select>
      </div>

      <div className="feature-field-row">
        <span className="feature-field-label">Translation</span>
      </div>
      {numField('X', transform.translation?.[0], (v) => {
        const t = transform.translation ?? [0, 0, 0]
        onMutation({ type: 'set_transform_field', featureId: fid, field: 'translation', value: [v, t[1], t[2]] })
      })}
      {numField('Y', transform.translation?.[1], (v) => {
        const t = transform.translation ?? [0, 0, 0]
        onMutation({ type: 'set_transform_field', featureId: fid, field: 'translation', value: [t[0], v, t[2]] })
      })}
      {numField('Z', transform.translation?.[2], (v) => {
        const t = transform.translation ?? [0, 0, 0]
        onMutation({ type: 'set_transform_field', featureId: fid, field: 'translation', value: [t[0], t[1], v] })
      })}

      <div className="feature-field-row">
        <span className="feature-field-label">Rotation</span>
      </div>
      {numField('Angle (deg)', transform.rotation_angle, (v) => {
        onMutation({ type: 'set_transform_field', featureId: fid, field: 'rotation_angle', value: v })
      })}
      <div className="feature-field-row feature-field-row--stacked">
        <span className="feature-field-label">Axis</span>
          <PickChip
            values={transform.rotation_axis ? [transform.rotation_axis] : []}
            isPicking={isPicking('rotation_axis')}
            onActivate={() => {
              if (isPicking('rotation_axis')) setPendingPickField(null)
              else setPendingPickField({ featureId: fid, field: 'rotation_axis', hostKind: 'transform' })
            }}
            onRemove={() => onMutation({ type: 'set_transform_field', featureId: fid, field: 'rotation_axis', value: '' })}
            features={features}
            partLabels={partLabels}
          />
      </div>

      <div className="feature-field-row">
        <span className="feature-field-label">Scale</span>
      </div>
      {numField('Factor', transform.scale, (v) => {
        onMutation({ type: 'set_transform_field', featureId: fid, field: 'scale', value: v })
      })}
      <div className="feature-field-row feature-field-row--stacked">
        <span className="feature-field-label">Origin</span>
        <PickChip
          values={transform.scale_center_from ? [transform.scale_center_from] : []}
          isPicking={isPicking('scale_center_from')}
          onActivate={() => {
            if (isPicking('scale_center_from')) setPendingPickField(null)
            else setPendingPickField({ featureId: fid, field: 'scale_center_from', hostKind: 'transform' })
          }}
          onRemove={() => onMutation({ type: 'set_transform_field', featureId: fid, field: 'scale_center_from', value: '' })}
          features={features}
          partLabels={partLabels}
        />
      </div>
    </div>
  )
}
