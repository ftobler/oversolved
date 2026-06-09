import type { PartFeature, Mutation } from '@/types/cad'
import { PickChip } from '@/components/sketch/PickChip'
import { usePickField } from '@/hooks/useFieldPicking'
import { planeLabel } from '@/components/Geometry3D/utils'

interface PlaneSelectorProps {
  feature: PartFeature
  featureDef?: PartFeature
  onMutation: (m: Mutation) => void
  features: PartFeature[]
  partLabels: Record<string, string>
}

export function PlaneSelector({
  feature, featureDef, onMutation, features, partLabels,
}: PlaneSelectorProps) {
  const fid = feature.id

  const planePick = usePickField(fid, 'plane', (selectionId) => {
    const plane = selectionId.startsWith('face:')
      ? selectionId.split(':').slice(2).join(':')
      : selectionId
    onMutation({ type: 'set_feature_plane', featureId: fid, plane })
  })

  return (
    <div className="plane-editor">
      <div className="feature-field-row feature-field-row--stacked">
        <span className="feature-field-label">Plane</span>
        <PickChip
          values={(() => {
            const label = planeLabel(featureDef?.plane)
            return label && label !== 'None' ? [label] : []
          })()}
          isPicking={planePick.isPicking}
          onActivate={planePick.toggle}
          onRemove={() => onMutation({ type: 'set_feature_plane', featureId: fid, plane: '' })}
          features={features}
          partLabels={partLabels}
        />
      </div>
    </div>
  )
}
