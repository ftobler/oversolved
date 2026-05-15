import React from 'react'
import type { PartFeature, Mutation, PendingPickField } from '@/types/cad'
import { PickChip } from '@/components/PickChip'

interface DeleteBodyEditorProps {
  feature: PartFeature
  onMutation: (m: Mutation) => void
  pendingPickField: PendingPickField | null
  setPendingPickField: (field: PendingPickField | null) => void
  features?: PartFeature[]
  partLabels?: Record<string, string>
}

export const DeleteBodyEditor: React.FC<DeleteBodyEditorProps> = ({
  feature, onMutation, pendingPickField, setPendingPickField, features, partLabels,
}) => {
  const db = feature.delete_body ?? { body: '' }
  const fid = feature.id
  const isPicking = (field: string) =>
    pendingPickField?.featureId === fid && pendingPickField.field === field

  return (
    <div className="feature-editor">
      <div className="feature-field-row feature-field-row--stacked">
        <span className="feature-field-label">Body</span>
        <PickChip
          values={db.body ? [db.body] : []}
          isPicking={isPicking('body')}
          onActivate={() => {
            if (isPicking('body')) setPendingPickField(null)
            else setPendingPickField({ featureId: fid, field: 'body', hostKind: 'delete_body' })
          }}
          onRemove={() => onMutation({ type: 'set_delete_body_target', featureId: fid, body: '' })}
          features={features}
          partLabels={partLabels}
        />
      </div>
    </div>
  )
}
