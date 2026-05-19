import type { PartFeature, Mutation } from '@/types/cad'
import { PickChip } from '@/components/PickChip'
import { useFieldPicking } from '@/hooks/useFieldPicking'
import { planeLabel } from '@/components/Geometry3D/utils'

interface PlaneSelectorProps {
  feature: PartFeature
  featureDef?: PartFeature
  onMutation: (m: Mutation) => void
  planeSelectionFeatureId: string | null
  setPlaneSelectionFeatureId: (id: string | null) => void
  features: PartFeature[]
  partLabels: Record<string, string>
}

export function PlaneSelector({
  feature, featureDef, onMutation, planeSelectionFeatureId, setPlaneSelectionFeatureId, features, partLabels,
}: PlaneSelectorProps) {
  const isPicking = planeSelectionFeatureId === feature.id

  useFieldPicking(isPicking, (selectionId) => {
    onMutation({ type: 'set_feature_plane', featureId: feature.id, plane: selectionId })
    setPlaneSelectionFeatureId(null)
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
          isPicking={isPicking}
          onActivate={() => {
            if (isPicking) {
              setPlaneSelectionFeatureId(null)
            } else {
              setPlaneSelectionFeatureId(feature.id)
            }
          }}
          onRemove={() => {
            onMutation({ type: 'set_feature_plane', featureId: feature.id, plane: '' })
            setPlaneSelectionFeatureId(null)
          }}
          features={features}
          partLabels={partLabels}
        />
      </div>
    </div>
  )
}
