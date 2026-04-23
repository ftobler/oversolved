import React, { useState, useRef, useCallback, useEffect } from 'react'
import type { PartFeature, PartDoc, PlaneDef, Mutation, PendingPickField, ExtrudeDirection, ExtrudeOperation, BodyResult } from '../types/cad'
import { isBodyFeatureResult } from '../types/cad'
import { normalizeExtrudeSketch } from '../utils/yamlMutations'
import { planeLabel } from './Geometry3D/utils'
import featureSketchIcon from '../assets/icons/feature-sketch.svg'
import featureExtrudeIcon from '../assets/icons/feature-extrude.svg'
import featurePartIcon from '../assets/icons/feature-part.svg'
import featureOriginIcon from '../assets/icons/feature-origin.svg'
import featurePlaneIcon from '../assets/icons/feature-plane.svg'
import featureImportIcon from '../assets/icons/icon-upload.svg'
import contextEditIcon from '../assets/icons/context-edit.svg'
import iconDotsIcon from '../assets/icons/dots.svg'
import iconEyeIcon from '../assets/icons/icon-eye.svg'
import iconEyeOffIcon from '../assets/icons/icon-eye-off.svg'
import exitSketchIcon from '../assets/icons/exit-sketch.svg'

const BUILT_IN_IDS = new Set(['Origin', 'Top', 'Front', 'Right'])
const MIN_SPLIT_PERCENT = 20
const MAX_SPLIT_PERCENT = 80
const DEFAULT_SPLIT_PERCENT = 70

interface SidebarProps {
  features: PartFeature[]
  doc: PartDoc | null
  rollbackPosition: number | null
  visibleFeatures: Set<string>
  editingFeatureId: string | null
  selection: Set<string>
  pendingPickField: PendingPickField | null
  planeSelectionFeatureId: string | null
  onToggleSelect: (id: string) => void
  onEnterEditSketch: (featureId: string) => void
  onExitEditSketch: () => void
  onEnterEditFeature: (featureId: string) => void
  onExitEditFeature: () => void
  onToggleVisibility: (featureId: string) => void
  onRightClick: (pos: [number, number], targetId?: string) => void
  onRename?: (featureId: string, label: string) => void
  onRollbackDragStart: (e: React.DragEvent) => void
  onRollbackDragOver: (e: React.DragEvent, featureIndex: number) => void
  onRollbackDrop: (e: React.DragEvent, featureIndex: number) => void
  onMutation: (mutation: Mutation) => void
  onSetRollbackPosition: (pos: number | null) => void
  onSetPendingPickField: (state: PendingPickField | null) => void
  onSetPlaneSelectionFeatureId: (id: string | null) => void
  onToggleBodyVisibility?: (bodyId: string) => void
  visibleBodies?: Set<string>
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
  pendingPickField,
  planeSelectionFeatureId,
  onToggleSelect,
  onEnterEditSketch,
  onExitEditSketch,
  onEnterEditFeature,
  onExitEditFeature,
  onToggleVisibility,
  onRightClick,
  onRollbackDragStart,
  onRollbackDragOver,
  onRollbackDrop,
  onMutation,
  onSetRollbackPosition,
  onSetPendingPickField,
  onSetPlaneSelectionFeatureId,
  onToggleBodyVisibility,
  visibleBodies,
  solveResults,
  bodies,
}) => {
  const [splitPercent, setSplitPercent] = useState(DEFAULT_SPLIT_PERCENT)
  const isDraggingRef = useRef(false)
  const sidebarRef = useRef<HTMLElement>(null)

  const handleMouseDown = useCallback(() => {
    isDraggingRef.current = true
  }, [])

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDraggingRef.current || !sidebarRef.current) return
    const rect = sidebarRef.current.getBoundingClientRect()
    const newPercent = ((e.clientY - rect.top) / rect.height) * 100
    setSplitPercent(Math.max(MIN_SPLIT_PERCENT, Math.min(MAX_SPLIT_PERCENT, newPercent)))
  }, [])

  const handleMouseUp = useCallback(() => {
    isDraggingRef.current = false
  }, [])

  useEffect(() => {
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [handleMouseMove, handleMouseUp])

  const getFeatureIcon = (kind: string | undefined) => {
    const lowerKind = kind?.toLowerCase()
    switch (lowerKind) {
      case 'sketch':
        return featureSketchIcon
      case 'extrude':
        return featureExtrudeIcon
      case 'origin':
        return featureOriginIcon
      case 'import_step':
        return featureImportIcon
      default:
        return featurePlaneIcon
    }
  }

  // Extract the first usable query string from the current selection.
  // Ancestry queries (?...) and direct refs (@...) are used as-is.
  // face:/edge: prefixed IDs (from 2D topology surfaces) are stripped to their query.
  const selectionQuery = (() => {
    for (const id of selection) {
      if (id.startsWith('?')) return id
      if (id.startsWith('@') && !id.includes('/')) return id
      if (id.startsWith('face:')) return id.split(':').slice(2).join(':')
      if (id.startsWith('edge:')) return id.split(':').slice(2).join(':')
    }
    return null
  })()

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

  const ListPickChip: React.FC<{ values: string[]; isPicking: boolean; onActivate: () => void; onRemove: (index: number) => void }> = ({ values, isPicking, onActivate, onRemove }) => {
    const isEmpty = values.length === 0
    return (
      <div
        className={`feature-pick-chip feature-pick-chip-list ${isEmpty ? 'empty' : ''} ${isPicking ? 'picking' : ''}`}
        onClick={(e) => { e.stopPropagation(); onActivate() }}
      >
        {values.map((v, i) => (
          <div key={i} className="feature-pick-chip-item">
            <span className="feature-pick-chip-item-text">{v}</span>
            <button
              className="feature-pick-chip-item-remove"
              onClick={(e) => { e.stopPropagation(); onRemove(i) }}
              title="Remove"
            >×</button>
          </div>
        ))}
      </div>
    )
  }

  const PlaneEditor: React.FC<{ feature: PartFeature; featureDef?: PartFeature }> = ({ feature, featureDef }) => {
    const def = (featureDef?.definition as PlaneDef | undefined) ?? { mode: 'offset' }
    const mode = def.mode ?? 'offset'
    const fid = feature.id
    const isPickingField = (field: string) =>
      pendingPickField?.featureId === fid && pendingPickField.field === field
    const pickChip = (field: string, _kind: 'plane' | 'point' | 'line', value: string | undefined) => {
      const isPicking = isPickingField(field)
      return <PickChip
        value={value}
        isPicking={isPicking}
        onActivate={() => {
          if (isPicking) {
            onSetPendingPickField(null)
          } else if (selectionQuery) {
            onMutation({ type: 'set_plane_definition_field', featureId: fid, field, value: selectionQuery })
          } else {
            onSetPendingPickField({ featureId: fid, field })
          }
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
            <option value="on_face">On face</option>
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
        {mode === 'on_face' && (
          <div className="feature-field-row">
            <span className="feature-field-label">Face</span>
            {pickChip('face', 'plane', def.face)}
          </div>
        )}
        {numField('rotation', 'Rotation', 0)}
      </div>
    )
  }

  const ExtrudeEditor: React.FC<{ feature: PartFeature }> = ({ feature }) => {
    const extrude = feature.extrude ?? { sketch: [], distance: 10, direction: 'normal' }
    const fid = feature.id
    const isPickingSketch = pendingPickField?.featureId === fid && pendingPickField.field === 'sketch'
    const profiles = normalizeExtrudeSketch(extrude.sketch)

    return (
      <div className="plane-editor">
        <div className="feature-field-row">
          <span className="feature-field-label">Profile</span>
          <ListPickChip
            values={profiles}
            isPicking={isPickingSketch}
            onActivate={() => {
              if (isPickingSketch) onSetPendingPickField(null)
              else onSetPendingPickField({ featureId: fid, field: 'sketch' })
            }}
            onRemove={(index) => onMutation({ type: 'remove_extrude_profile', featureId: fid, index })}
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
          <span className="feature-field-label">Operation</span>
          <select
            className="feature-field-select"
            aria-label="Operation"
            value={extrude.operation ?? 'add'}
            onChange={(e) => {
              e.stopPropagation()
              onMutation({
                type: 'set_extrude_operation',
                featureId: fid,
                operation: e.target.value as ExtrudeOperation,
              })
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <option value="add">Add</option>
            <option value="cut">Cut</option>
            <option value="new">New</option>
          </select>
        </div>
        <div className="feature-field-row">
          <span className="feature-field-label">Direction</span>
          <select
            className="feature-field-select"
            aria-label="Direction"
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
              if (isPicking) {
                onSetPlaneSelectionFeatureId(null)
              } else if (selectionQuery) {
                onMutation({ type: 'set_feature_plane', featureId: feature.id, plane: selectionQuery })
              } else {
                onSetPlaneSelectionFeatureId(feature.id)
              }
            }}
            onClear={() => {
              onMutation({ type: 'set_feature_plane', featureId: feature.id, plane: '' })
              onSetPlaneSelectionFeatureId(null)
            }}
          />
        </div>
      </div>
    )
  }

  return (
    <aside className="doc-sidebar" ref={sidebarRef}>
      <div className="sidebar-top" style={{ height: `${splitPercent}%` }}>
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
                  if (pendingPickField?.field === 'sketch' && feature.kind === 'sketch') {
                    onMutation({ type: 'add_extrude_profile', featureId: pendingPickField.featureId, sketchQuery: '$' + feature.id })
                  } else {
                    onToggleSelect(`@${feature.id}`)
                  }
                }}
                onDoubleClick={() => feature.kind === 'sketch' ? onEnterEditSketch(feature.id) : undefined}
                style={{ flexWrap: 'wrap' }}
              >
                <div className="feature-item-title">
                  <img
                    src={getFeatureIcon(feature.kind)}
                    alt={feature.kind || 'feature'}
                    className="feature-icon"
                  />
                  {(() => {
                    const r = feature.kind === 'extrude' ? solveResults?.[feature.id] : undefined
                    const bodyResult = r && isBodyFeatureResult(r) ? r : undefined
                    const hasBody = bodyResult && bodyResult.body_id
                      && bodies?.[bodyResult.body_id]?.mesh != null
                    const isError = !!r && ((r as { status?: string }).status !== 'ok' || !hasBody)
                    const errMsg: string = bodyResult?.exception
                      ?? (bodyResult?.body_id ? bodies?.[bodyResult.body_id]?.mesh_error : undefined)
                      ?? ''
                    return (
                      <span
                        className={`feature-name${isError ? ' feature-name-error' : ''}`}
                        title={errMsg}
                      >
                        {feature.label || feature.id}
                      </span>
                    )
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
                        onClick={(e) => { e.stopPropagation(); onEnterEditFeature(feature.id) }}
                        title="Edit plane"
                      >
                        <img src={contextEditIcon} alt="Edit" />
                      </button>
                    )}
                    {feature.kind === 'extrude' && feature.id !== editingFeatureId && (
                      <button
                        className="feature-edit-btn"
                        onClick={(e) => { e.stopPropagation(); onEnterEditFeature(feature.id) }}
                        title="Edit extrude"
                      >
                        <img src={contextEditIcon} alt="Edit" />
                      </button>
                    )}
                    {feature.kind === 'extrude' && feature.id === editingFeatureId && (
                      <button
                        className="exit-sketch-btn"
                        onClick={(e) => { e.stopPropagation(); onExitEditFeature() }}
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
                        onClick={(e) => { e.stopPropagation(); onExitEditFeature() }}
                        title="Exit plane editor"
                      >
                        <span className="material-icons-outlined">close</span>
                      </button>
                    )}
                    {(feature.kind === 'sketch' || feature.kind === 'plane') && feature.id !== editingFeatureId && (
                      <button
                        className="feature-visibility-btn"
                        onClick={(e) => { e.stopPropagation(); onToggleVisibility(feature.id) }}
                        title={visibleFeatures.has(feature.id) ? 'Hide' : 'Show'}
                      >
                        <img src={visibleFeatures.has(feature.id) ? iconEyeIcon : iconEyeOffIcon} alt={visibleFeatures.has(feature.id) ? 'Visible' : 'Hidden'} />
                      </button>
                    )}
                    {(feature.kind === 'sketch' && feature.id === editingFeatureId) && (
                      <button
                        className="feature-visibility-btn disabled"
                        title="Visible while editing"
                        disabled
                      >
                        <img src={iconEyeIcon} alt="Visible" />
                      </button>
                    )}
                    {(feature.kind === 'extrude' || feature.kind === 'import_step') && (
                      <span className="feature-visibility-placeholder" />
                    )}
                    {(feature.kind === 'sketch' || feature.kind === 'plane') && feature.id === editingFeatureId && (
                      <span className="feature-visibility-placeholder" />
                    )}
                    {BUILT_IN_IDS.has(feature.id) && (
                      <span className="feature-visibility-placeholder" />
                    )}
                    {!BUILT_IN_IDS.has(feature.id) && (
                      <button
                        className="feature-context-btn"
                        onClick={(e) => { e.stopPropagation(); onRightClick([e.clientX, e.clientY], feature.id) }}
                        title="More options"
                      >
                        <img src={iconDotsIcon} alt="Options" />
                      </button>
                    )}
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
                {feature.kind === 'import_step' && feature.id === editingFeatureId && (
                  <div className="plane-editor">
                    <div className="feature-field-row">
                      <span className="feature-field-label">File</span>
                      <span className="feature-field-value">{feature.file_id ?? '—'}</span>
                    </div>
                  </div>
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
      </div>
      <div
        className="resize-handle"
        onMouseDown={handleMouseDown}
        title="Drag to resize"
      />
      <div className="sidebar-bottom" style={{ height: `${100 - splitPercent}%` }}>
        <div className="sidebar-header">Parts</div>
        <ul className="parts-list">
          {Object.keys(bodies || {}).length === 0 ? (
            <li className="empty">No parts</li>
          ) : (
            Object.entries(bodies || {}).map(([bodyId]) => {
              const isHidden = visibleBodies ? !visibleBodies.has(bodyId) : false
              return (
                <li
                  key={bodyId}
                  className={`part-item ${selection.has(`@${bodyId}`) ? 'selected' : ''}`}
                  onClick={() => onToggleSelect(`@${bodyId}`)}
                >
                  <img className="part-icon" src={featurePartIcon} alt="" />
                  <span className="part-name">{bodyId}</span>
                  {onToggleBodyVisibility && (
                    <button
                      className="part-visibility-btn"
                      onClick={(e) => { e.stopPropagation(); onToggleBodyVisibility(bodyId) }}
                      title={isHidden ? 'Show' : 'Hide'}
                    >
                      <img src={isHidden ? iconEyeIcon : iconEyeOffIcon} alt={isHidden ? 'Visible' : 'Hidden'} />
                    </button>
                  )}
                </li>
              )
            })
          )}
        </ul>
      </div>
    </aside>
  )
}
