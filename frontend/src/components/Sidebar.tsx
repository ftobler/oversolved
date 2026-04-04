import React, { useState } from 'react'
import type { PartFeature, PartDoc, PlaneDef, Mutation } from '../types/cad'
import { planeLabel } from './Geometry3D/utils'
import featureSketchIcon from '../assets/icons/feature-sketch.svg'
import featureExtrudeIcon from '../assets/icons/feature-extrude.svg'
import featureOriginIcon from '../assets/icons/feature-origin.svg'
import featurePlaneIcon from '../assets/icons/feature-plane.svg'

const BUILT_IN_IDS = new Set(['Origin', 'Top', 'Front', 'Right'])

export interface FieldPickState {
  featureId: string
  field: string
  kind: 'plane' | 'point' | 'line'
}

interface SidebarProps {
  features: PartFeature[]
  doc: PartDoc | null
  rollbackPosition: number | null
  visibleFeatures: Set<string>
  editingFeatureId: string | null
  selection: Set<string>
  fieldPickState: FieldPickState | null
  planeSelectionFeatureId: string | null
  onToggleSelect: (id: string) => void
  onEnterEditSketch: (featureId: string) => void
  onExitEditSketch: () => void
  onToggleVisibility: (featureId: string) => void
  onRightClick: (pos: [number, number], targetId?: string) => void
  onRollbackDragStart: (e: React.DragEvent) => void
  onRollbackDragOver: (e: React.DragEvent, featureIndex: number) => void
  onRollbackDrop: (e: React.DragEvent, featureIndex: number) => void
  onMutation: (mutation: Mutation) => void
  onSetRollbackPosition: (pos: number | null) => void
  onSetEditingFeatureId: (id: string | null) => void
  onSetFieldPickState: (state: FieldPickState | null) => void
  onSetPlaneSelectionFeatureId: (id: string | null) => void
}

export const Sidebar: React.FC<SidebarProps> = ({
  features,
  doc,
  rollbackPosition,
  visibleFeatures,
  editingFeatureId,
  selection,
  fieldPickState,
  planeSelectionFeatureId,
  onToggleSelect,
  onEnterEditSketch,
  onExitEditSketch,
  onToggleVisibility,
  onRightClick,
  onRollbackDragStart,
  onRollbackDragOver,
  onRollbackDrop,
  onMutation,
  onSetRollbackPosition,
  onSetEditingFeatureId,
  onSetFieldPickState,
  onSetPlaneSelectionFeatureId,
}) => {
  const [renamingFeatureId, setRenamingFeatureId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const commitRename = (feature: PartFeature) => {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== (feature.label || feature.id)) {
      onMutation({ type: 'rename_feature', featureId: feature.id, label: trimmed })
    }
    setRenamingFeatureId(null)
  }

  const getFeatureIcon = (kind: string | undefined) => {
    const lowerKind = kind?.toLowerCase()
    switch (lowerKind) {
      case 'sketch':
        return featureSketchIcon
      case 'extrude':
        return featureExtrudeIcon
      case 'origin':
        return featureOriginIcon
      default:
        return featurePlaneIcon
    }
  }

  const PlaneEditor: React.FC<{ feature: PartFeature; featureDef?: PartFeature }> = ({ feature, featureDef }) => {
    const def = (featureDef?.definition as PlaneDef | undefined) ?? { mode: 'offset' }
    const mode = def.mode ?? 'offset'
    const fid = feature.id
    const isPickingKind = (field: string, kind: 'plane' | 'point' | 'line') =>
      fieldPickState?.featureId === fid && fieldPickState.field === field && fieldPickState.kind === kind
    const pickBtn = (field: string, kind: 'plane' | 'point' | 'line', label: string) =>
      isPickingKind(field, kind)
        ? <button className="feature-plane-btn active" onClick={(e) => { e.stopPropagation(); onSetFieldPickState(null) }}>Cancel</button>
        : <button className="feature-plane-btn" onClick={(e) => { e.stopPropagation(); onSetFieldPickState({ featureId: fid, field, kind }) }}>{label}</button>
    const numField = (field: 'offset' | 'angle' | 'rotation', label: string, defaultVal: number) => (
      <div className="plane-editor-row">
        <span className="plane-editor-label">{label}:</span>
        <input
          type="number"
          className="plane-editor-input"
          defaultValue={def[field] ?? defaultVal}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            const v = parseFloat(e.target.value)
            if (!isNaN(v)) onMutation({ type: 'set_plane_definition_field', featureId: fid, field, value: v })
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur() } e.stopPropagation() }}
        />
      </div>
    )
    const refPlaneRow = (
      <div className="plane-editor-row">
        <span className="plane-editor-label">Plane:</span>
        <span className="plane-editor-value">{planeLabel(def.plane)}</span>
        {pickBtn('plane', 'plane', 'Pick')}
      </div>
    )

    return (
      <div className="plane-editor">
        <div className="plane-editor-row">
          <span className="plane-editor-label">Type:</span>
          <select
            className="plane-editor-select"
            value={mode}
            onChange={(e) => { e.stopPropagation(); onMutation({ type: 'set_plane_definition_field', featureId: fid, field: 'mode', value: e.target.value }) }}
            onClick={(e) => e.stopPropagation()}
          >
            <option value="offset">Offset from plane</option>
            <option value="plane_point">Plane through point</option>
            <option value="three_point">Three-point plane</option>
            <option value="line_angle">Rotate on line</option>
            <option value="edge_point">Line and point</option>
          </select>
        </div>
        {mode === 'offset' && (
          <>
            {refPlaneRow}
            {numField('offset', 'Offset', 0)}
          </>
        )}
        {mode === 'plane_point' && (
          <>
            {refPlaneRow}
            <div className="plane-editor-row">
              <span className="plane-editor-label">Point:</span>
              <span className="plane-editor-value">{def.point ?? 'None'}</span>
              {pickBtn('point', 'point', 'Pick')}
            </div>
          </>
        )}
        {mode === 'three_point' && (['p1', 'p2', 'p3'] as const).map((field, i) => (
          <div key={field} className="plane-editor-row">
            <span className="plane-editor-label">P{i + 1}:</span>
            <span className="plane-editor-value">{def[field] ?? 'None'}</span>
            {pickBtn(field, 'point', 'Pick')}
          </div>
        ))}
        {mode === 'line_angle' && (
          <>
            <div className="plane-editor-row">
              <span className="plane-editor-label">Line:</span>
              <span className="plane-editor-value">{def.line ?? 'None'}</span>
              {pickBtn('line', 'line', 'Pick')}
            </div>
            {numField('angle', 'Angle', 0)}
          </>
        )}
        {mode === 'edge_point' && (
          <>
            <div className="plane-editor-row">
              <span className="plane-editor-label">Line:</span>
              <span className="plane-editor-value">{def.edge ?? 'None'}</span>
              {pickBtn('edge', 'line', 'Pick')}
            </div>
            <div className="plane-editor-row">
              <span className="plane-editor-label">Point:</span>
              <span className="plane-editor-value">{def.point ?? 'None'}</span>
              {pickBtn('point', 'point', 'Pick')}
            </div>
          </>
        )}
        {numField('rotation', 'Rotation', 0)}
      </div>
    )
  }

  const PlaneSelector: React.FC<{ feature: PartFeature; featureDef?: PartFeature }> = ({ feature, featureDef }) => {
    const isPicking = planeSelectionFeatureId === feature.id
    return (
      <div className="feature-plane-selector">
        <span className="feature-plane-label">Plane: {planeLabel(featureDef?.plane)}</span>
        {isPicking ? (
          <div className="feature-plane-picking">
            <span className="feature-plane-hint">Click a plane or face...</span>
            <button
              className="feature-plane-btn"
              onClick={(e) => { e.stopPropagation(); onSetPlaneSelectionFeatureId(null) }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            className="feature-plane-btn"
            onClick={(e) => { e.stopPropagation(); onSetPlaneSelectionFeatureId(feature.id) }}
          >
            Change
          </button>
        )}
      </div>
    )
  }

  return (
    <aside className="doc-sidebar">
      <div className="sidebar-header">Features</div>
      <ul className="features-list">
        {features.length === 0 ? (
          <li className="empty">No features</li>
        ) : (
          features.map((feature, index) => (
            <div key={`feature-${feature.id}`}>
              {rollbackPosition === index && (
                <li
                  className="rollback-bar"
                  title="Rollback"
                  draggable
                  onDragStart={onRollbackDragStart}
                  onDragOver={(e) => onRollbackDragOver(e, index)}
                  onDrop={(e) => onRollbackDrop(e, index)}
                ></li>
              )}
              <li
                key={feature.id}
                className={`feature-item ${index >= (rollbackPosition ?? features.length) ? 'rolled-back' : ''} ${!visibleFeatures.has(feature.id) ? 'invisible' : ''} ${feature.id === editingFeatureId ? 'editing' : ''} ${selection.has(`@${feature.id}`) ? 'selected' : ''}`}
                onDragOver={(e) => onRollbackDragOver(e, index)}
                onDrop={(e) => onRollbackDrop(e, index)}
                onClick={() => onToggleSelect(`@${feature.id}`)}
                onDoubleClick={() => feature.kind === 'sketch' ? onEnterEditSketch(feature.id) : undefined}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onRightClick([e.clientX, e.clientY], feature.id) }}
                style={{ flexWrap: 'wrap' }}
              >
                <img
                  src={getFeatureIcon(feature.kind)}
                  alt={feature.kind || 'feature'}
                  className="feature-icon"
                />
                {renamingFeatureId === feature.id ? (
                  <input
                    className="feature-name-input"
                    value={renameValue}
                    autoFocus
                    onClick={e => e.stopPropagation()}
                    onChange={e => setRenameValue(e.target.value)}
                    onBlur={() => commitRename(feature)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.currentTarget.blur() }
                      if (e.key === 'Escape') { setRenamingFeatureId(null) }
                      e.stopPropagation()
                    }}
                  />
                ) : (
                  <span
                    className="feature-name"
                    onClick={e => {
                      e.stopPropagation()
                      setRenamingFeatureId(feature.id)
                      setRenameValue(feature.label || feature.id)
                    }}
                  >
                    {feature.label || feature.id}
                  </span>
                )}
                {feature.kind === 'sketch' && feature.id !== editingFeatureId && (
                  <button
                    className="feature-edit-btn"
                    onClick={() => onEnterEditSketch(feature.id)}
                    title="Edit sketch"
                  >
                    <span className="material-icons-outlined">edit</span>
                  </button>
                )}
                {feature.kind === 'sketch' && feature.id === editingFeatureId && (
                  <button
                    className="exit-sketch-btn"
                    onClick={(e) => { e.stopPropagation(); onExitEditSketch() }}
                    title="Exit sketch"
                  >
                    <span className="material-icons-outlined">close</span>
                  </button>
                )}
                {feature.kind === 'plane' && !BUILT_IN_IDS.has(feature.id) && feature.id !== editingFeatureId && (
                  <button
                    className="feature-edit-btn"
                    onClick={(e) => {
                      e.stopPropagation()
                      const idx = features.findIndex(f => f.id === feature.id)
                      if (idx >= 0) onSetRollbackPosition(idx + 1)
                      onSetEditingFeatureId(feature.id)
                    }}
                    title="Edit plane"
                  >
                    <span className="material-icons-outlined">edit</span>
                  </button>
                )}
                {feature.kind === 'plane' && !BUILT_IN_IDS.has(feature.id) && feature.id === editingFeatureId && (
                  <button
                    className="exit-sketch-btn"
                    onClick={(e) => { e.stopPropagation(); onSetEditingFeatureId(null); onSetFieldPickState(null) }}
                    title="Exit plane editor"
                  >
                    <span className="material-icons-outlined">close</span>
                  </button>
                )}
                <button
                  className="feature-visibility-btn"
                  onClick={(e) => { e.stopPropagation(); onToggleVisibility(feature.id) }}
                  title={visibleFeatures.has(feature.id) ? 'Hide' : 'Show'}
                >
                  <span className="material-icons-outlined">
                    {visibleFeatures.has(feature.id) ? 'visibility' : 'visibility_off'}
                  </span>
                </button>
                {feature.kind === 'plane' && !BUILT_IN_IDS.has(feature.id) && feature.id === editingFeatureId && (
                  <PlaneEditor feature={feature} featureDef={doc?.features?.find(f => f.id === feature.id)} />
                )}
                {feature.kind === 'sketch' && feature.id === editingFeatureId && (
                  <PlaneSelector feature={feature} featureDef={doc?.features?.find(f => f.id === feature.id)} />
                )}
              </li>
            </div>
          ))
        )}
        {rollbackPosition === features.length && (
          <li
            className="rollback-bar"
            title="Rollback"
            draggable
            onDragStart={onRollbackDragStart}
            onDragOver={(e) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
            }}
            onDrop={(e) => {
              e.preventDefault()
              onSetRollbackPosition(features.length)
            }}
          ></li>
        )}
      </ul>
    </aside>
  )
}
