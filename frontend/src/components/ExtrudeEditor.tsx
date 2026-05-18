import { useState } from 'react'
import type { PartFeature, Mutation } from '@/types/cad'
import { PickChip } from '@/components/PickChip'
import { useFieldPicking } from '@/hooks/useFieldPicking'
import { normalizeExtrudeSketch } from '@/utils/yamlMutations'

interface ExtrudeEditorProps {
  feature: PartFeature
  onMutation: (m: Mutation) => void
  features?: PartFeature[]
  partLabels?: Record<string, string>
}

function resolveMergeRef(id: string): string {
  let bodyRef = id
  if (id.startsWith('body:')) {
    bodyRef = '@' + id.slice(5)
  } else if (id.startsWith('?')) {
    bodyRef = '@body_' + id.slice(1).split('/')[0]
  } else if (id.startsWith('@') && id.includes('/')) {
    bodyRef = '@' + id.slice(1).split('/')[0]
  }
  if (bodyRef.startsWith('@') && !bodyRef.startsWith('@body_')) {
    bodyRef = '@body_' + bodyRef.slice(1)
  }
  return bodyRef
}

export function ExtrudeEditor({
  feature, onMutation, features, partLabels,
}: ExtrudeEditorProps) {
  const extrude = feature.extrude ?? { sketch: [], distance: 10, direction: 'normal' }
  const fid = feature.id
  const [isPickingSketch, setIsPickingSketch] = useState(false)
  const [isPickingMergeTarget, setIsPickingMergeTarget] = useState(false)
  const profiles = normalizeExtrudeSketch(extrude.sketch)
  const showMergeTarget = extrude.operation !== 'new'

  useFieldPicking(isPickingSketch, (selectionId) => {
    const sketchQuery = selectionId.startsWith('face:')
      ? selectionId.split(':').slice(2).join(':')
      : selectionId
    onMutation({ type: 'add_extrude_profile', featureId: fid, sketchQuery })
  })

  useFieldPicking(isPickingMergeTarget, (selectionId) => {
    onMutation({ type: 'set_extrude_field', featureId: fid, field: 'merge_target', value: resolveMergeRef(selectionId) })
    setIsPickingMergeTarget(false)
  })

  return (
    <div className="plane-editor">
      <div className="feature-field-row feature-field-row--stacked">
        <span className="feature-field-label">Profile</span>
        <PickChip
          values={profiles}
          isPicking={isPickingSketch}
          onActivate={() => setIsPickingSketch(!isPickingSketch)}
          onRemove={(index) => onMutation({ type: 'remove_extrude_profile', featureId: fid, index })}
          features={features}
          partLabels={partLabels}
        />
      </div>
      <div className="feature-field-row">
        <span className="feature-field-label">Distance</span>
        <input
          type="number"
          className="feature-field-input"
          defaultValue={extrude.distance ?? 10}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            const v = parseFloat(e.target.value)
            if (!isNaN(v) && v > 0)
              onMutation({ type: 'set_extrude_field', featureId: fid, field: 'distance', value: v })
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
        />
      </div>
      <div className="feature-field-row">
        <span className="feature-field-label">Operation</span>
        <select
          className="feature-field-select"
          aria-label="Operation"
          value={extrude.operation ?? 'add'}
          onChange={(e) => {
            e.stopPropagation()
            onMutation({
              type: 'set_extrude_field',
              featureId: fid,
              field: 'operation',
              value: e.target.value,
            })
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <option value="add">Add</option>
          <option value="cut">Cut</option>
          <option value="new">New</option>
        </select>
      </div>
      {showMergeTarget && (
        <div className="feature-field-row feature-field-row--stacked">
          <span className="feature-field-label">Merge Target</span>
          <PickChip
            values={extrude.merge_target ? [extrude.merge_target] : []}
            isPicking={isPickingMergeTarget}
            onActivate={() => setIsPickingMergeTarget(!isPickingMergeTarget)}
            onRemove={() => onMutation({ type: 'set_extrude_field', featureId: fid, field: 'merge_target', value: undefined })}
            emptyText="(all bodies)"
            features={features}
            partLabels={partLabels}
          />
        </div>
      )}
      <div className="feature-field-row">
        <span className="feature-field-label">Direction</span>
        <select
          className="feature-field-select"
          aria-label="Direction"
          value={extrude.direction ?? 'normal'}
          onChange={(e) => {
            e.stopPropagation()
            onMutation({
              type: 'set_extrude_field',
              featureId: fid,
              field: 'direction',
              value: e.target.value,
            })
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <option value="normal">Normal</option>
          <option value="reverse">Reverse</option>
          <option value="symmetric">Symmetric</option>
        </select>
      </div>
    </div>
  )
}
