import type { PartFeature, Mutation } from '@/types/cad'
import { PickChip } from '@/components/sketch/PickChip'
import { usePickField } from '@/hooks/usePickField'
import { resolveBarePlaneId } from '@/kernel/solverConstants'

/**
 * The query a chip may mirror into the selection. A sketch saved before the
 * builtin planes got query ids can still carry a bare `Top`/`Front`/`Right`,
 * which both kernel resolvers still accept (`resolveSketchPlane`,
 * `resolvePlaneEarly`), so such documents remain loadable and are not migrated
 * on read. That legacy spelling is not a selection id though, and mirroring it
 * verbatim would put an unrecognized entry into normalSelection.
 */
function planeSelectionQuery(plane: string | undefined): string | null {
  if (!plane) return null
  const bare = resolveBarePlaneId(plane)
  return bare ? `@${bare}` : plane
}

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
  const planeQuery = planeSelectionQuery(featureDef?.plane)

  const planePick = usePickField(fid, 'plane', (selectionId) => {
    onMutation({ type: 'set_feature_plane', featureId: fid, plane: selectionId })
  }, {
    features,
    // Re-clicking the picked plane in the viewport toggles it out of the
    // selection; this is the only consumer that can turn that back into the
    // matching mutation.
    onUnpick: () => onMutation({ type: 'set_feature_plane', featureId: fid, plane: '' }),
  })

  return (
    <div className="plane-editor">
      <div className="feature-field-row feature-field-row--stacked">
        <span className="feature-field-label">Plane</span>
        <PickChip
          // The query, not its label: the chip mirrors its values into
          // normalSelection, so a label would highlight nothing and would never
          // match the id a viewport re-click toggles. PickChip labels it itself.
          values={planeQuery ? [planeQuery] : []}
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
