import React, { useState } from 'react'
import type { PartFeature, PartDoc, PlaneDef, Mutation, FieldPickState, ExtrudeDirection, BodyResult } from '../types/cad'
import { isBodyFeatureResult } from '../types/cad'
import { planeLabel } from './Geometry3D/utils'
import featureSketchIcon from '../assets/icons/feature-sketch.svg'
import featureExtrudeIcon from '../assets/icons/feature-extrude.svg'
import featureOriginIcon from '../assets/icons/feature-origin.svg'
import featurePlaneIcon from '../assets/icons/feature-plane.svg'
import contextEditIcon from '../assets/icons/context-edit.svg'
import iconEyeIcon from '../assets/icons/icon-eye.svg'
import iconEyeOffIcon from '../assets/icons/icon-eye-off.svg'
import exitSketchIcon from '../assets/icons/exit-sketch.svg'

const BUILT_IN_IDS = new Set(['Origin', 'Top', 'Front', 'Right'])

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
  solveResults?: Record<string, unknown>
  bodies?: Record<string, BodyResult>
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
  solveResults,
  bodies,
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

  const PickChip: React.FC<{ value: string | undefined; isPicking: boolean; onActivate: () => void; onClear: () => void }> = ({ value, isPicking, onActivate, onClear }) => {
    const isEmpty = !value || value === 'None'
    return (
      <div
        className={`feature-pick-chip ${isEmpty ? 'empty' : ''} ${isPicking ? 'picking' : ''}`}
        onClick={(e) => { e.stopPropagation(); onActivate() }}
      >
        {!isEmpty && (
          <div className="feature-pick-chip-item">
            <span className="feature-pick-chip-item-text">{value}</span>
            <button
              className="feature-pick-chip-item-remove"
              onClick={(e) => { e.stopPropagation(); onClear() }}
              title="Clear selection"
            >×</button>
          </div>
        )}
      </div>
    )
  }

  const PlaneEditor: React.FC<{ feature: PartFeature; featureDef?: PartFeature }> = ({ feature, featureDef }) => {
    const def = (featureDef?.definition as PlaneDef | undefined) ?? { mode: 'offset' }
    const mode = def.mode ?? 'offset'
    const fid = feature.id
    const isPickingKind = (field: string, kind: 'plane' | 'point' | 'line') =>
      fieldPickState?.featureId === fid && fieldPickState.field === field && fieldPickState.kind === kind
    const pickChip = (field: string, kind: 'plane' | 'point' | 'line', value: string | undefined) => {
      const isPicking = isPickingKind(field, kind)
      return <PickChip
        value={value}
        isPicking={isPicking}
        onActivate={() => {
          if (isPicking) onSetFieldPickState(null)
          else onSetFieldPickState({ featureId: fid, field, kind })
        }}
        onClear={() => onMutation({ type: 'set_plane_definition_field', featureId: fid, field, value: '' })}
      />
    }
    const numField = (field: 'offset' | 'angle' | 'rotation', label: string, defaultVal: number) => (
      <div className="feature-field-row">
        <span className="feature-field-label">{label}</span>
        <input
          type="number"
          className="feature-field-input"
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

    return (
      <div className="plane-editor">
        <div className="feature-field-row">
          <span className="feature-field-label">Type</span>
          <select
            className="feature-field-select"
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
            <div className="feature-field-row">
              <span className="feature-field-label">Plane</span>
              {pickChip('plane', 'plane', planeLabel(def.plane))}
            </div>
            {numField('offset', 'Offset', 0)}
          </>
        )}
        {mode === 'plane_point' && (
          <>
            <div className="feature-field-row">
              <span className="feature-field-label">Plane</span>
              {pickChip('plane', 'plane', planeLabel(def.plane))}
            </div>
            <div className="feature-field-row">
              <span className="feature-field-label">Point</span>
              {pickChip('point', 'point', def.point)}
            </div>
          </>
        )}
        {mode === 'three_point' && (['p1', 'p2', 'p3'] as const).map((field, i) => (
          <div key={field} className="feature-field-row">
            <span className="feature-field-label">P{i + 1}</span>
            {pickChip(field, 'point', def[field])}
          </div>
        ))}
        {mode === 'line_angle' && (
          <>
            <div className="feature-field-row">
              <span className="feature-field-label">Line</span>
              {pickChip('line', 'line', def.line)}
            </div>
            {numField('angle', 'Angle', 0)}
          </>
        )}
        {mode === 'edge_point' && (
          <>
            <div className="feature-field-row">
              <span className="feature-field-label">Line</span>
              {pickChip('edge', 'line', def.edge)}
            </div>
            <div className="feature-field-row">
              <span className="feature-field-label">Point</span>
              {pickChip('point', 'point', def.point)}
            </div>
          </>
        )}
        {numField('rotation', 'Rotation', 0)}
      </div>
    )
  }

  const ExtrudeEditor: React.FC<{ feature: PartFeature }> = ({ feature }) => {
    const extrude = feature.extrude ?? { sketch: '', distance: 10, direction: 'normal' }
    const fid = feature.id
    const isPickingSketch = fieldPickState?.featureId === fid
      && fieldPickState.field === 'sketch'
      && fieldPickState.kind === 'sketch'

    return (
      <div className="plane-editor">
        <div className="feature-field-row">
          <span className="feature-field-label">Sketch</span>
          <PickChip
            value={extrude.sketch || undefined}
            isPicking={isPickingSketch}
            onActivate={() => {
              if (isPickingSketch) onSetFieldPickState(null)
              else onSetFieldPickState({ featureId: fid, field: 'sketch', kind: 'sketch' })
            }}
            onClear={() => onMutation({ type: 'set_extrude_sketch', featureId: fid, sketchQuery: '' })}
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
                onMutation({ type: 'set_extrude_distance', featureId: fid, distance: v })
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
          />
        </div>
        <div className="feature-field-row">
          <span className="feature-field-label">Direction</span>
          <select
            className="feature-field-select"
            value={extrude.direction ?? 'normal'}
            onChange={(e) => {
              e.stopPropagation()
              onMutation({
                type: 'set_extrude_direction',
                featureId: fid,
                direction: e.target.value as ExtrudeDirection,
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

  const PlaneSelector: React.FC<{ feature: PartFeature; featureDef?: PartFeature }> = ({ feature, featureDef }) => {
    const isPicking = planeSelectionFeatureId === feature.id
    return (
      <div className="plane-editor">
        <div className="feature-field-row">
          <span className="feature-field-label">Plane</span>
          <PickChip
            value={planeLabel(featureDef?.plane)}
            isPicking={isPicking}
            onActivate={() => {
              if (isPicking) onSetPlaneSelectionFeatureId(null)
              else onSetPlaneSelectionFeatureId(feature.id)
            }}
            onClear={() => onSetPlaneSelectionFeatureId(null)}
          />
        </div>
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
                onClick={() => {
                  if (fieldPickState?.kind === 'sketch' && feature.kind === 'sketch') {
                    onMutation({ type: 'set_extrude_sketch', featureId: fieldPickState.featureId, sketchQuery: '$' + feature.id })
                    onSetFieldPickState(null)
                  } else {
                    onToggleSelect(`@${feature.id}`)
                  }
                }}
                onDoubleClick={() => feature.kind === 'sketch' ? onEnterEditSketch(feature.id) : undefined}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onRightClick([e.clientX, e.clientY], feature.id) }}
                style={{ flexWrap: 'wrap' }}
              >
                <div className="feature-item-title">
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
                  {feature.kind === 'extrude' && (() => {
                    const r = solveResults?.[feature.id]
                    const bodyResult = r && isBodyFeatureResult(r) ? r : undefined
                    const hasBody = bodyResult && bodyResult.body_id
                      && bodies?.[bodyResult.body_id]?.mesh != null
                    const dot = !r ? 'grey'
                      : (r as { status?: string }).status !== 'ok' ? 'red'
                      : hasBody ? 'green'
                      : 'orange'
                    const errMsg: string = bodyResult?.exception
                      ?? (bodyResult?.body_id ? bodies?.[bodyResult.body_id]?.mesh_error : undefined)
                      ?? ''
                    return <span className={`feature-status-dot ${dot}`} title={errMsg} />
                  })()}
                  <div className="feature-item-actions">
                    {feature.kind === 'sketch' && feature.id !== editingFeatureId && (
                      <button
                        className="feature-edit-btn"
                        onClick={() => onEnterEditSketch(feature.id)}
                        title="Edit sketch"
                      >
                        <img src={contextEditIcon} alt="Edit" />
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
                        <img src={contextEditIcon} alt="Edit" />
                      </button>
                    )}
                    {feature.kind === 'extrude' && feature.id !== editingFeatureId && (
                      <button
                        className="feature-edit-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          onSetEditingFeatureId(feature.id)
                        }}
                        title="Edit extrude"
                      >
                        <img src={contextEditIcon} alt="Edit" />
                      </button>
                    )}
                    {feature.kind === 'extrude' && feature.id === editingFeatureId && (
                      <button
                        className="exit-sketch-btn"
                        onClick={(e) => { e.stopPropagation(); onSetEditingFeatureId(null); onSetFieldPickState(null) }}
                        title="Exit extrude editor"
                      >
                        <span className="material-icons-outlined">close</span>
                      </button>
                    )}
                    {feature.kind === 'sketch' && feature.id === editingFeatureId && (
                      <button
                        className="exit-sketch-btn"
                        onClick={(e) => { e.stopPropagation(); onExitEditSketch() }}
                        title="Exit sketch"
                      >
                        <img src={exitSketchIcon} alt="Exit" />
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
                      <img src={visibleFeatures.has(feature.id) ? iconEyeIcon : iconEyeOffIcon} alt={visibleFeatures.has(feature.id) ? 'Visible' : 'Hidden'} />
                    </button>
                  </div>
                </div>
                {feature.kind === 'plane' && !BUILT_IN_IDS.has(feature.id) && feature.id === editingFeatureId && (
                  <PlaneEditor feature={feature} featureDef={doc?.features?.find(f => f.id === feature.id)} />
                )}
                {feature.kind === 'sketch' && feature.id === editingFeatureId && (
                  <PlaneSelector feature={feature} featureDef={doc?.features?.find(f => f.id === feature.id)} />
                )}
                {feature.kind === 'extrude' && editingFeatureId === feature.id && (
                  <ExtrudeEditor feature={feature} />
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
