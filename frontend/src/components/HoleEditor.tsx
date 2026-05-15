import type { PartFeature, Mutation, PendingPickField } from '@/types/cad'
import { PickChip } from '@/components/PickChip'

interface HoleEditorProps {
  feature: PartFeature
  onMutation: (m: Mutation) => void
  pendingPickField: PendingPickField | null
  setPendingPickField: (field: PendingPickField | null) => void
  features?: PartFeature[]
  partLabels?: Record<string, string>
}

export function HoleEditor({ feature, onMutation, pendingPickField, setPendingPickField, features, partLabels }: HoleEditorProps) {
  const hole = feature.hole ?? { sketch: '', diameter: 10, depth_mode: 'blind', depth: 20, direction: 'normal' }
  const fid = feature.id
  const isPickingSketch = pendingPickField?.featureId === fid && pendingPickField?.field === 'sketch'

  return (
    <div className="plane-editor">
      <div className="feature-field-row feature-field-row--stacked">
        <span className="feature-field-label">Sketch</span>
        <PickChip
          values={hole.sketch ? [hole.sketch] : []}
          isPicking={isPickingSketch}
          onActivate={() => {
            if (isPickingSketch) setPendingPickField(null)
            else setPendingPickField({ featureId: fid, field: 'sketch', hostKind: 'hole' })
          }}
          onRemove={() => onMutation({ type: 'set_hole_sketch', featureId: fid, sketch: '' })}
          features={features}
          partLabels={partLabels}
        />
      </div>
      <div className="feature-field-row">
        <span className="feature-field-label">Diameter</span>
        <input
          type="number"
          className="feature-field-input"
          defaultValue={hole.diameter}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            const v = parseFloat(e.target.value)
            if (!isNaN(v) && v > 0)
              onMutation({ type: 'set_hole_diameter', featureId: fid, diameter: v })
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
        />
        <span className="feature-field-unit">mm</span>
      </div>
      <div className="feature-field-row">
        <span className="feature-field-label">Depth mode</span>
        <select
          className="feature-field-select"
          value={hole.depth_mode}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onMutation({ type: 'set_hole_depth_mode', featureId: fid, depthMode: e.target.value as 'blind' | 'through_all' })}
        >
          <option value="blind">Blind</option>
          <option value="through_all">Through All</option>
        </select>
      </div>
      {hole.depth_mode === 'blind' && (
        <div className="feature-field-row">
          <span className="feature-field-label">Depth</span>
          <input
            type="number"
            className="feature-field-input"
            defaultValue={hole.depth}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              const v = parseFloat(e.target.value)
              if (!isNaN(v) && v > 0)
                onMutation({ type: 'set_hole_depth', featureId: fid, depth: v })
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
          />
          <span className="feature-field-unit">mm</span>
        </div>
      )}
      <div className="feature-field-row">
        <span className="feature-field-label">Direction</span>
        <select
          className="feature-field-select"
          value={hole.direction}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onMutation({ type: 'set_hole_direction', featureId: fid, direction: e.target.value as 'normal' | 'reverse' })}
        >
          <option value="normal">Normal</option>
          <option value="reverse">Reverse</option>
        </select>
      </div>
    </div>
  )
}
