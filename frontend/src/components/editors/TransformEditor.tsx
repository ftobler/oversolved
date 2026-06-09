import type { PartFeature, Mutation } from '@/types/cad'
import { PickChip } from '@/components/sketch/PickChip'
import { usePickField } from '@/hooks/useFieldPicking'

interface TransformEditorProps {
  feature: PartFeature
  onMutation: (m: Mutation) => void
  features?: PartFeature[]
  partLabels?: Record<string, string>
}

function resolveTransformQuery(selectionId: string): string {
  if (selectionId.startsWith('face:')) {
    return selectionId.split(':').slice(2).join(':')
  }
  if (selectionId.startsWith('entity:')) {
    return '@' + selectionId.split(':').slice(1).join('/')
  }
  if (selectionId.startsWith('vertex:')) {
    return '@' + selectionId.split(':').slice(1).join('/')
  }
  return selectionId
}

export function TransformEditor({ feature, onMutation, features, partLabels }: TransformEditorProps) {
  const transform = feature.transform ?? { body: '', operation: 'new', translation: [0, 0, 0], rotation_angle: 0, scale: 1 }
  const fid = feature.id
  const bodyPick = usePickField(fid, 'body', (selectionId) => {
    onMutation({ type: 'set_transform_field', featureId: fid, field: 'body', value: selectionId })
  })

  const axisPick = usePickField(fid, 'rotation_axis', (selectionId) => {
    onMutation({ type: 'set_transform_field', featureId: fid, field: 'rotation_axis', value: resolveTransformQuery(selectionId) })
  })

  const originPick = usePickField(fid, 'scale_center_from', (selectionId) => {
    onMutation({ type: 'set_transform_field', featureId: fid, field: 'scale_center_from', value: resolveTransformQuery(selectionId) })
  })

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
          isPicking={bodyPick.isPicking}
          onActivate={bodyPick.toggle}
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
            isPicking={axisPick.isPicking}
            onActivate={axisPick.toggle}
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
          isPicking={originPick.isPicking}
          onActivate={originPick.toggle}
          onRemove={() => onMutation({ type: 'set_transform_field', featureId: fid, field: 'scale_center_from', value: '' })}
          features={features}
          partLabels={partLabels}
        />
      </div>
    </div>
  )
}
