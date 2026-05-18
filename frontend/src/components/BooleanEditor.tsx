import { useState } from 'react'
import type { PartFeature, Mutation } from '@/types/cad'
import { PickChip } from '@/components/PickChip'
import { useFieldPicking } from '@/hooks/useFieldPicking'

function resolveBodyRef(id: string): string {
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

interface BooleanEditorProps {
  feature: PartFeature
  onMutation: (m: Mutation) => void
  features?: PartFeature[]
  partLabels?: Record<string, string>
}

export function BooleanEditor({ feature, onMutation, features, partLabels }: BooleanEditorProps) {
  const bool = feature.boolean ?? { operation: 'union', target: '', tools: [] }
  const fid = feature.id
  const [isPickingTarget, setIsPickingTarget] = useState(false)
  const [isPickingTool, setIsPickingTool] = useState(false)

  useFieldPicking(isPickingTarget, (selectionId) => {
    onMutation({ type: 'set_boolean_field', featureId: fid, field: 'target', value: resolveBodyRef(selectionId) })
    setIsPickingTarget(false)
  })

  useFieldPicking(isPickingTool, (selectionId) => {
    onMutation({ type: 'add_boolean_tool', featureId: fid, tool: resolveBodyRef(selectionId) })
  })

  return (
    <div className="plane-editor">
      <div className="feature-field-row">
        <span className="feature-field-label">Operation</span>
        <select
          className="feature-field-select"
          aria-label="Boolean operation"
          value={bool.operation}
          onChange={(e) => {
            e.stopPropagation()
            onMutation({ type: 'set_boolean_field', featureId: fid, field: 'operation', value: e.target.value })
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <option value="union">Union</option>
          <option value="subtract">Subtract</option>
          <option value="intersect">Intersect</option>
        </select>
      </div>
      <div className="feature-field-row feature-field-row--stacked">
        <span className="feature-field-label">Target</span>
        <PickChip
          values={bool.target ? [bool.target] : []}
          isPicking={isPickingTarget}
          onActivate={() => setIsPickingTarget(!isPickingTarget)}
          onRemove={() => onMutation({ type: 'set_boolean_field', featureId: fid, field: 'target', value: '' })}
          emptyText="(pick target)"
          features={features}
          partLabels={partLabels}
        />
      </div>
      <div className="feature-field-row feature-field-row--stacked">
        <span className="feature-field-label">Tools</span>
        <PickChip
          values={bool.tools}
          isPicking={isPickingTool}
          onActivate={() => setIsPickingTool(!isPickingTool)}
          onRemove={(index) => onMutation({ type: 'remove_boolean_tool', featureId: fid, tool: bool.tools[index] })}
          onReorder={(from, to) => onMutation({ type: 'reorder_pick_field', featureId: fid, field: 'tools', fromIndex: from, toIndex: to })}
          features={features}
          partLabels={partLabels}
        />
      </div>
      <div className="feature-field-row">
        <span className="feature-field-label">Keep tools</span>
        <input
          type="checkbox"
          checked={bool.keep_tools ?? false}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            onMutation({ type: 'set_boolean_field', featureId: fid, field: 'keep_tools', value: e.target.checked })
          }}
        />
      </div>
    </div>
  )
}