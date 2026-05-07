import React, { useState, useRef, useCallback, useEffect } from 'react'
import type { PartFeature, PartDoc, PlaneDef, Mutation, PendingPickField, ExtrudeDirection, ExtrudeOperation, BodyResult } from '../types/cad'
import { isBodyFeatureResult } from '../types/cad'
import { normalizeExtrudeSketch, normalizeRevolveSketch } from '../utils/yamlMutations'
import { planeLabel } from './Geometry3D/utils'
import featureSketchIcon from '../assets/icons/feature-sketch.svg'
import featureExtrudeIcon from '../assets/icons/feature-extrude.svg'
import featureRevolveIcon from '../assets/icons/feature-revolve.svg'
import featurePartIcon from '../assets/icons/feature-part.svg'
import featureOriginIcon from '../assets/icons/feature-origin.svg'
import featurePlaneIcon from '../assets/icons/feature-plane.svg'
import featureFilletIcon from '../assets/icons/feature-fillet.svg'
import featureChamferIcon from '../assets/icons/feature-chamfer.svg'
import featureBooleanIcon from '../assets/icons/feature-boolean.svg'
import featureArrayIcon from '../assets/icons/feature-array.svg'
import featureDeleteBodyIcon from '../assets/icons/feature-delete-body.svg'
import featureHoleIcon from '../assets/icons/feature-hole.svg'
import featureTransformIcon from '../assets/icons/feature-transform.svg'
import featureImportIcon from '../assets/icons/icon-upload.svg'
import { FilletEditor } from './FilletEditor'
import { ChamferEditor } from './ChamferEditor'
import { BooleanEditor } from './BooleanEditor'
import { HoleEditor } from './HoleEditor'
import { TransformEditor } from './TransformEditor'
import ArrayEditor from './ArrayEditor'
import { PickChip } from './PickChip'
import { RebuildButton } from './RebuildButton'
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
  onAlignCameraToSketchPlane?: () => void
  onEnterEditFeature: (featureId: string) => void
  onExitEditFeature: () => void
  onToggleVisibility: (featureId: string) => void
  onRightClick: (pos: [number, number], targetId?: string) => void
  onRename?: (featureId: string, label: string) => void
  onRollbackDragStart: (e: React.DragEvent) => void
  onMutation: (mutation: Mutation) => void
  onSetRollbackPosition: (pos: number | null) => void
  onSetPendingPickField: (state: PendingPickField | null) => void
  onSetPlaneSelectionFeatureId: (id: string | null) => void
  onToggleBodyVisibility?: (bodyId: string) => void
  partLabels?: Record<string, string>
  visibleBodies?: Set<string>
  solveResults?: Record<string, unknown>
  bodies?: Record<string, BodyResult>
  onRebuild?: () => void
  isRebuilding?: boolean
  featureTimings: Record<string, number>
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
  onMutation,
  onSetRollbackPosition,
  onSetPendingPickField,
  onSetPlaneSelectionFeatureId,
  onToggleBodyVisibility,
  partLabels,
  visibleBodies,
  solveResults,
  bodies,
  onRebuild,
  isRebuilding,
  featureTimings,
}) => {
  const [splitPercent, setSplitPercent] = useState(DEFAULT_SPLIT_PERCENT)
  const isDraggingRef = useRef(false)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const [draggedFeatureId, setDraggedFeatureId] = useState<string | null>(null)
  const [draggedRollback, setDraggedRollback] = useState(false)
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null)

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
      case 'revolve':
        return featureRevolveIcon
      case 'origin':
        return featureOriginIcon
      case 'fillet':
        return featureFilletIcon
      case 'chamfer':
        return featureChamferIcon
      case 'boolean':
        return featureBooleanIcon
      case 'array':
        return featureArrayIcon
      case 'delete_body':
        return featureDeleteBodyIcon
      case 'hole':
        return featureHoleIcon
      case 'transform':
        return featureTransformIcon
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
      if (id.startsWith('@') && !id.includes('/')) {
        const refId = id.slice(1)
        const refFeature = features.find(f => f.id === refId)
        if (!refFeature || refFeature.kind === 'plane') return id
      }
      if (id.startsWith('face:')) return id.split(':').slice(2).join(':')
      if (id.startsWith('edge:')) return id.split(':').slice(2).join(':')
    }
    return null
  })()

  const PlaneEditor: React.FC<{ feature: PartFeature; featureDef?: PartFeature }> = ({ feature, featureDef }) => {
    const def = (featureDef?.definition as PlaneDef | undefined) ?? { mode: 'offset' }
    const mode = def.mode ?? 'offset'
    const fid = feature.id
    const isPickingField = (field: string) =>
      pendingPickField?.featureId === fid && pendingPickField.field === field
    const pickChip = (field: string, _kind: 'plane' | 'point' | 'line', value: string | undefined) => {
      const isPicking = isPickingField(field)
      return (
        <PickChip
          values={value && value !== 'None' ? [value] : []}
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
          onRemove={() => onMutation({ type: 'set_plane_definition_field', featureId: fid, field, value: '' })}
          features={features}
          partLabels={partLabels}
        />
      )
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
            <div className="feature-field-row feature-field-row--stacked">
              <span className="feature-field-label">Plane</span>
              {pickChip('plane', 'plane', planeLabel(def.plane))}
            </div>
            {numField('offset', 'Offset', 0)}
          </>
        )}
        {mode === 'plane_point' && (
          <>
            <div className="feature-field-row feature-field-row--stacked">
              <span className="feature-field-label">Plane</span>
              {pickChip('plane', 'plane', planeLabel(def.plane))}
            </div>
            <div className="feature-field-row feature-field-row--stacked">
              <span className="feature-field-label">Point</span>
              {pickChip('point', 'point', def.point)}
            </div>
          </>
        )}
        {mode === 'three_point' && (['p1', 'p2', 'p3'] as const).map((field, i) => (
          <div key={field} className="feature-field-row feature-field-row--stacked">
            <span className="feature-field-label">P{i + 1}</span>
            {pickChip(field, 'point', def[field])}
          </div>
        ))}
        {mode === 'line_angle' && (
          <>
            <div className="feature-field-row feature-field-row--stacked">
              <span className="feature-field-label">Line</span>
              {pickChip('line', 'line', def.line)}
            </div>
            {numField('angle', 'Angle', 0)}
          </>
        )}
        {mode === 'edge_point' && (
          <>
            <div className="feature-field-row feature-field-row--stacked">
              <span className="feature-field-label">Line</span>
              {pickChip('edge', 'line', def.edge)}
            </div>
            <div className="feature-field-row feature-field-row--stacked">
              <span className="feature-field-label">Point</span>
              {pickChip('point', 'point', def.point)}
            </div>
          </>
        )}
        {mode === 'on_face' && (
          <div className="feature-field-row feature-field-row--stacked">
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
        <div className="feature-field-row feature-field-row--stacked">
          <span className="feature-field-label">Profile</span>
          <PickChip
            values={profiles}
            isPicking={isPickingSketch}
            onActivate={() => {
              if (isPickingSketch) onSetPendingPickField(null)
              else onSetPendingPickField({ featureId: fid, field: 'sketch', hostKind: 'extrude' })
            }}
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

  const RevolveEditor: React.FC<{ feature: PartFeature }> = ({ feature }) => {
    const revolve = feature.revolve ?? { sketch: [], angle: 360, axis_origin: [0, 0, 0], axis_direction: [0, 0, 1] }
    const fid = feature.id
    const isPickingSketch = pendingPickField?.featureId === fid && pendingPickField.field === 'sketch'
    const isPickingAxis = pendingPickField?.featureId === fid && pendingPickField.field === 'axis'
    const profiles = normalizeRevolveSketch(revolve.sketch)

    return (
      <div className="plane-editor">
        <div className="feature-field-row feature-field-row--stacked">
          <span className="feature-field-label">Profile</span>
          <PickChip
            values={profiles}
            isPicking={isPickingSketch}
            onActivate={() => {
              if (isPickingSketch) onSetPendingPickField(null)
              else onSetPendingPickField({ featureId: fid, field: 'sketch', hostKind: 'revolve' })
            }}
            onRemove={(index) => onMutation({ type: 'remove_revolve_profile', featureId: fid, index })}
            features={features}
            partLabels={partLabels}
          />
        </div>
        <div className="feature-field-row">
          <span className="feature-field-label">Angle</span>
          <input
            type="number"
            className="feature-field-input"
            defaultValue={revolve.angle ?? 360}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              const v = parseFloat(e.target.value)
              if (!isNaN(v) && v > 0)
                onMutation({ type: 'set_revolve_angle', featureId: fid, angle: v })
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
          />
        </div>
        <div className="feature-field-row">
          <span className="feature-field-label">Operation</span>
          <select
            className="feature-field-select"
            aria-label="Operation"
            value={revolve.operation ?? 'add'}
            onChange={(e) => {
              e.stopPropagation()
              onMutation({
                type: 'set_revolve_operation',
                featureId: fid,
                operation: e.target.value as 'add' | 'cut' | 'new',
              })
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <option value="add">Add</option>
            <option value="cut">Cut</option>
            <option value="new">New</option>
          </select>
        </div>
        <div className="feature-field-row feature-field-row--stacked">
          <span className="feature-field-label">Axis</span>
          <PickChip
            values={revolve.axis && revolve.axis !== 'None' ? [revolve.axis] : []}
            isPicking={isPickingAxis}
            onActivate={() => {
              if (isPickingAxis) {
                onSetPendingPickField(null)
              } else if (selectionQuery) {
                onMutation({ type: 'set_revolve_axis', featureId: fid, axis: selectionQuery })
              } else {
                onSetPendingPickField({ featureId: fid, field: 'axis' })
              }
            }}
            onRemove={() => onMutation({ type: 'set_revolve_axis', featureId: fid, axis: '' })}
            features={features}
            partLabels={partLabels}
          />
        </div>
      </div>
    )
  }

  const PlaneSelector: React.FC<{ feature: PartFeature; featureDef?: PartFeature }> = ({ feature, featureDef }) => {
    const isPicking = planeSelectionFeatureId === feature.id
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
                onSetPlaneSelectionFeatureId(null)
              } else if (selectionQuery) {
                onMutation({ type: 'set_feature_plane', featureId: feature.id, plane: selectionQuery })
              } else {
                onSetPlaneSelectionFeatureId(feature.id)
              }
            }}
            onRemove={() => {
              onMutation({ type: 'set_feature_plane', featureId: feature.id, plane: '' })
              onSetPlaneSelectionFeatureId(null)
            }}
            features={features}
            partLabels={partLabels}
          />
        </div>
      </div>
    )
  }

  return (
    <aside className="doc-sidebar" ref={sidebarRef}>
      <div
        className="sidebar-top"
        style={{ height: `${splitPercent}%` }}
        onDragOver={(e) => {
          if (!draggedRollback) return
          e.preventDefault()
          e.stopPropagation()
        }}
        onDrop={(e) => {
          if (!draggedRollback) return
          e.preventDefault()
          e.stopPropagation()
          onSetRollbackPosition(features.length)
          setDraggedRollback(false)
          setDropTargetIndex(null)
        }}
      >
        <div className="sidebar-header">
          <span>Features</span>
          {onRebuild && (
            <RebuildButton featureTimings={featureTimings} features={features} onClick={onRebuild} isLoading={isRebuilding} />
          )}
        </div>
        <ul
          className="features-list"
          onDragOver={(e) => {
            if (!draggedRollback) return
            e.preventDefault()
            e.stopPropagation()
            const featureEls = e.currentTarget.querySelectorAll('.feature-item')
            let targetIndex = features.length
            for (let i = 0; i < featureEls.length; i++) {
              const rect = featureEls[i].getBoundingClientRect()
              if (e.clientY < rect.top + rect.height / 2) {
                targetIndex = Math.max(i, BUILT_IN_IDS.size)
                break
              }
            }
            setDropTargetIndex(targetIndex)
          }}
          onDrop={(e) => {
            if (!draggedRollback) return
            e.preventDefault()
            e.stopPropagation()
            const featureEls = e.currentTarget.querySelectorAll('.feature-item')
            let targetIndex = features.length
            for (let i = 0; i < featureEls.length; i++) {
              const rect = featureEls[i].getBoundingClientRect()
              if (e.clientY < rect.top + rect.height / 2) {
                targetIndex = Math.max(i, BUILT_IN_IDS.size)
                break
              }
            }
            onSetRollbackPosition(targetIndex)
            setDraggedRollback(false)
            setDropTargetIndex(null)
          }}
        >
        {features.length === 0 ? (
          <li className="empty">No features</li>
        ) : (
          features.map((feature, index) => {
            const handleDragOver = (e: React.DragEvent, useFeatureRect = false) => {
              if (BUILT_IN_IDS.has(feature.id)) return
              e.preventDefault()
              e.stopPropagation()
              let targetEl = e.currentTarget as Element
              if (useFeatureRect) {
                const featureEl = (e.currentTarget as Element).querySelector('.feature-item')
                if (featureEl) targetEl = featureEl
              }
              const rect = targetEl.getBoundingClientRect()
              const midY = rect.top + rect.height / 2
              const targetIndex = e.clientY < midY ? index : index + 1
              setDropTargetIndex(Math.max(targetIndex, BUILT_IN_IDS.size))
            }

            const handleDrop = (e: React.DragEvent) => {
              e.preventDefault()
              e.stopPropagation()
              if (dropTargetIndex !== null) {
                onSetRollbackPosition(dropTargetIndex)
              }
              setDraggedRollback(false)
              setDropTargetIndex(null)
            }

            return (
            <div
              key={`feature-${feature.id}`}
              onDragOver={(e) => {
                if (!draggedRollback) return
                handleDragOver(e, true)
              }}
              onDrop={(e) => {
                if (!draggedRollback) return
                handleDrop(e)
              }}
            >
              {rollbackPosition === index && (
                <li
                  className={`rollback-bar ${draggedRollback ? 'dragging' : ''}`}
                  title="Rollback"
                  draggable
                  onDragStart={(e) => {
                    setDraggedRollback(true)
                    onRollbackDragStart(e)
                  }}
                  onDragOver={(e) => {
                    if (!draggedRollback) return
                    handleDragOver(e)
                  }}
                  onDrop={(e) => {
                    if (!draggedRollback) return
                    handleDrop(e)
                  }}
                  onDragEnd={() => {
                    setDraggedRollback(false)
                    setDropTargetIndex(null)
                  }}
                ></li>
              )}
              <li
                key={feature.id}
                className={`feature-item ${index >= (rollbackPosition ?? features.length) ? 'rolled-back' : ''} ${!visibleFeatures.has(feature.id) ? 'invisible' : ''} ${feature.id === editingFeatureId ? 'editing' : ''} ${selection.has(`@${feature.id}`) ? 'selected' : ''} ${draggedFeatureId === feature.id ? 'dragging' : ''} ${dropTargetIndex === index ? 'drop-target-top' : ''} ${dropTargetIndex === index + 1 ? 'drop-target-bottom' : ''}`}
                draggable={!BUILT_IN_IDS.has(feature.id) && feature.id !== editingFeatureId}
                onDragStart={(e) => {
                  if (BUILT_IN_IDS.has(feature.id)) return
                  setDraggedFeatureId(feature.id)
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', feature.id)
                }}
                onDragOver={(e) => {
                  if (draggedFeatureId) {
                    e.preventDefault()
                    e.stopPropagation()
                    if (BUILT_IN_IDS.has(feature.id)) return
                    const rect = e.currentTarget.getBoundingClientRect()
                    const midY = rect.top + rect.height / 2
                    const targetIndex = e.clientY < midY ? index : index + 1
                    setDropTargetIndex(Math.max(targetIndex, BUILT_IN_IDS.size))
                  } else if (draggedRollback) {
                    handleDragOver(e)
                  }
                }}
                onDragEnd={() => {
                  setDraggedFeatureId(null)
                  setDropTargetIndex(null)
                }}
                onDrop={(e) => {
                  if (draggedFeatureId) {
                    e.preventDefault()
                    e.stopPropagation()
                    const fid = e.dataTransfer.getData('text/plain')
                    if (fid && dropTargetIndex !== null && !BUILT_IN_IDS.has(fid)) {
                      onMutation({ type: 'reorder_features', featureId: fid, toIndex: dropTargetIndex })
                    }
                    setDraggedFeatureId(null)
                    setDropTargetIndex(null)
                  } else if (draggedRollback) {
                    handleDrop(e)
                  }
                }}
                onClick={() => {
                  if (pendingPickField?.field === 'sketch' && feature.kind === 'sketch') {
                    const hostFeature = features.find(f => f.id === pendingPickField.featureId)
                    if (hostFeature?.kind === 'revolve') {
                      onMutation({ type: 'add_revolve_profile', featureId: pendingPickField.featureId, sketchQuery: '$' + feature.id })
                    } else {
                      onMutation({ type: 'add_extrude_profile', featureId: pendingPickField.featureId, sketchQuery: '$' + feature.id })
                    }
                  } else if ((pendingPickField?.field === 'boolean_target' || pendingPickField?.field === 'boolean_tool') && solveResults?.[feature.id] && isBodyFeatureResult(solveResults[feature.id])) {
                    const bodyResult = solveResults[feature.id] as { body_id?: string }
                    const bodyRef = bodyResult.body_id ? '@' + bodyResult.body_id : '@' + feature.id
                    if (pendingPickField.field === 'boolean_target') {
                      onMutation({ type: 'set_boolean_target', featureId: pendingPickField.featureId, target: bodyRef })
                      onSetPendingPickField(null)
                    } else {
                      onMutation({ type: 'add_boolean_tool', featureId: pendingPickField.featureId, tool: bodyRef })
                    }
                  } else if (pendingPickField?.field === 'body' && pendingPickField?.hostKind === 'transform' && solveResults?.[feature.id] && isBodyFeatureResult(solveResults[feature.id])) {
                    const bodyResult = solveResults[feature.id] as { body_id?: string }
                    const bodyRef = bodyResult.body_id ? '@' + bodyResult.body_id : '@' + feature.id
                    onMutation({ type: 'set_transform_field', featureId: pendingPickField.featureId, field: 'body', value: bodyRef })
                    onSetPendingPickField(null)
                  } else if (pendingPickField?.field === 'body' && pendingPickField?.hostKind === 'delete_body' && solveResults?.[feature.id] && isBodyFeatureResult(solveResults[feature.id])) {
                    const bodyResult = solveResults[feature.id] as { body_id?: string }
                    const bodyRef = bodyResult.body_id ? '@' + bodyResult.body_id : '@' + feature.id
                    onMutation({ type: 'set_delete_body_target', featureId: pendingPickField.featureId, body: bodyRef })
                    onSetPendingPickField(null)
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
                    const r = feature.kind === 'extrude' || feature.kind === 'revolve' || feature.kind === 'fillet' || feature.kind === 'chamfer' || feature.kind === 'boolean' || feature.kind === 'array' || feature.kind === 'hole' || feature.kind === 'transform' ? solveResults?.[feature.id] : undefined
                    const bodyResult = r && isBodyFeatureResult(r) ? r : undefined
                    const hasMeshError = bodyResult?.body_id
                      ? bodies?.[bodyResult.body_id]?.mesh_error : undefined
                    const isError = !!r && ((r as { status?: string }).status !== 'ok' || !!hasMeshError)
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
                    {feature.kind === 'revolve' && feature.id !== editingFeatureId && (
                      <button
                        className="feature-edit-btn"
                        onClick={(e) => { e.stopPropagation(); onEnterEditFeature(feature.id) }}
                        title="Edit revolve"
                      >
                        <img src={contextEditIcon} alt="Edit" />
                      </button>
                    )}
                    {feature.kind === 'revolve' && feature.id === editingFeatureId && (
                      <button
                        className="exit-feature-btn"
                        onClick={(e) => { e.stopPropagation(); onExitEditFeature() }}
                        title="Exit revolve editor"
                      >
                        <span className="material-icons-outlined">close</span>
                      </button>
                    )}
                    {feature.kind === 'fillet' && feature.id !== editingFeatureId && (
                      <button
                        className="feature-edit-btn"
                        onClick={(e) => { e.stopPropagation(); onEnterEditFeature(feature.id) }}
                        title="Edit fillet"
                      >
                        <img src={contextEditIcon} alt="Edit" />
                      </button>
                    )}
                    {feature.kind === 'fillet' && feature.id === editingFeatureId && (
                      <button
                        className="exit-feature-btn"
                        onClick={(e) => { e.stopPropagation(); onExitEditFeature() }}
                        title="Exit fillet editor"
                      >
                        <span className="material-icons-outlined">close</span>
                      </button>
                    )}
                    {feature.kind === 'chamfer' && feature.id !== editingFeatureId && (
                      <button
                        className="feature-edit-btn"
                        onClick={(e) => { e.stopPropagation(); onEnterEditFeature(feature.id) }}
                        title="Edit chamfer"
                      >
                        <img src={contextEditIcon} alt="Edit" />
                      </button>
                    )}
                    {feature.kind === 'chamfer' && feature.id === editingFeatureId && (
                      <button
                        className="exit-feature-btn"
                        onClick={(e) => { e.stopPropagation(); onExitEditFeature() }}
                        title="Exit chamfer editor"
                      >
                        <span className="material-icons-outlined">close</span>
                      </button>
                    )}
                    {feature.kind === 'boolean' && feature.id !== editingFeatureId && (
                      <button
                        className="feature-edit-btn"
                        onClick={(e) => { e.stopPropagation(); onEnterEditFeature(feature.id) }}
                        title="Edit boolean"
                      >
                        <img src={contextEditIcon} alt="Edit" />
                      </button>
                    )}
                    {feature.kind === 'boolean' && feature.id === editingFeatureId && (
                      <button
                        className="exit-feature-btn"
                        onClick={(e) => { e.stopPropagation(); onExitEditFeature() }}
                        title="Exit boolean editor"
                      >
                        <span className="material-icons-outlined">close</span>
                      </button>
                    )}
                    {feature.kind === 'array' && feature.id !== editingFeatureId && (
                      <button
                        className="feature-edit-btn"
                        onClick={(e) => { e.stopPropagation(); onEnterEditFeature(feature.id) }}
                        title="Edit array"
                      >
                        <img src={contextEditIcon} alt="Edit" />
                      </button>
                    )}
                    {feature.kind === 'array' && feature.id === editingFeatureId && (
                      <button
                        className="exit-feature-btn"
                        onClick={(e) => { e.stopPropagation(); onExitEditFeature() }}
                        title="Exit array editor"
                      >
                        <span className="material-icons-outlined">close</span>
                      </button>
                    )}
                    {feature.kind === 'delete_body' && feature.id !== editingFeatureId && (
                      <button
                        className="feature-edit-btn"
                        onClick={(e) => { e.stopPropagation(); onEnterEditFeature(feature.id) }}
                        title="Edit delete body"
                      >
                        <img src={contextEditIcon} alt="Edit" />
                      </button>
                    )}
                    {feature.kind === 'delete_body' && feature.id === editingFeatureId && (
                      <button
                        className="exit-feature-btn"
                        onClick={(e) => { e.stopPropagation(); onExitEditFeature() }}
                        title="Exit delete body editor"
                      >
                        <span className="material-icons-outlined">close</span>
                      </button>
                    )}
                    {feature.kind === 'hole' && feature.id !== editingFeatureId && (
                      <button
                        className="feature-edit-btn"
                        onClick={(e) => { e.stopPropagation(); onEnterEditFeature(feature.id) }}
                        title="Edit hole"
                      >
                        <img src={contextEditIcon} alt="Edit" />
                      </button>
                    )}
                    {feature.kind === 'hole' && feature.id === editingFeatureId && (
                      <button
                        className="exit-feature-btn"
                        onClick={(e) => { e.stopPropagation(); onExitEditFeature() }}
                        title="Exit hole editor"
                      >
                        <span className="material-icons-outlined">close</span>
                      </button>
                    )}
                    {feature.kind === 'transform' && feature.id !== editingFeatureId && (
                      <button
                        className="feature-edit-btn"
                        onClick={(e) => { e.stopPropagation(); onEnterEditFeature(feature.id) }}
                        title="Edit transform"
                      >
                        <img src={contextEditIcon} alt="Edit" />
                      </button>
                    )}
                    {feature.kind === 'transform' && feature.id === editingFeatureId && (
                      <button
                        className="exit-feature-btn"
                        onClick={(e) => { e.stopPropagation(); onExitEditFeature() }}
                        title="Exit transform editor"
                      >
                        <span className="material-icons-outlined">close</span>
                      </button>
                    )}
                    {feature.kind === 'extrude' && feature.id === editingFeatureId && (
                      <button
                        className="exit-feature-btn"
                        onClick={(e) => { e.stopPropagation(); onExitEditFeature() }}
                        title="Exit extrude editor"
                      >
                        <span className="material-icons-outlined">close</span>
                      </button>
                    )}
                    {feature.kind === 'sketch' && feature.id === editingFeatureId && (
                      <>
                        <button
                          className="exit-feature-btn"
                          onClick={(e) => { e.stopPropagation(); onExitEditSketch() }}
                          title="Exit sketch"
                        >
                          <img src={exitSketchIcon} alt="Exit" />
                        </button>
                      </>
                    )}
                    {feature.kind === 'plane' && !BUILT_IN_IDS.has(feature.id) && feature.id === editingFeatureId && (
                      <button
                        className="exit-feature-btn"
                        onClick={(e) => { e.stopPropagation(); onExitEditFeature() }}
                        title="Exit plane editor"
                      >
                        <span className="material-icons-outlined">close</span>
                      </button>
                    )}
                    {feature.kind === 'plane' && !BUILT_IN_IDS.has(feature.id) && feature.id === editingFeatureId && (
                      <span className="feature-visibility-placeholder" />
                    )}
                    {(feature.kind === 'sketch' || feature.kind === 'plane' || (BUILT_IN_IDS.has(feature.id) && feature.id !== 'Origin')) && feature.id !== editingFeatureId && (
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
                    {(feature.kind === 'extrude' || feature.kind === 'revolve' || feature.kind === 'fillet' || feature.kind === 'chamfer' || feature.kind === 'boolean' || feature.kind === 'array' || feature.kind === 'delete_body' || feature.kind === 'import_step') && (
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
                {feature.kind === 'revolve' && editingFeatureId === feature.id && (
                  <RevolveEditor feature={feature} />
                )}
                {feature.kind === 'import_step' && feature.id === editingFeatureId && (
                  <div className="plane-editor">
                    <div className="feature-field-row">
                      <span className="feature-field-label">File</span>
                      <span className="feature-field-value">{feature.file_id ?? '—'}</span>
                    </div>
                  </div>
                )}
                {feature.kind === 'fillet' && editingFeatureId === feature.id && (
                  <FilletEditor
                    feature={feature}
                    onMutation={onMutation}
                    pendingPickField={pendingPickField}
                    setPendingPickField={onSetPendingPickField}
                    features={features}
                    partLabels={partLabels}
                  />
                )}
                {feature.kind === 'chamfer' && editingFeatureId === feature.id && (
                  <ChamferEditor
                    feature={feature}
                    onMutation={onMutation}
                    pendingPickField={pendingPickField}
                    setPendingPickField={onSetPendingPickField}
                    features={features}
                    partLabels={partLabels}
                  />
                )}
                {feature.kind === 'boolean' && editingFeatureId === feature.id && (
                  <BooleanEditor
                    feature={feature}
                    onMutation={onMutation}
                    pendingPickField={pendingPickField}
                    setPendingPickField={onSetPendingPickField}
                    features={features}
                    partLabels={partLabels}
                  />
                )}
                {feature.kind === 'array' && editingFeatureId === feature.id && (
                  <ArrayEditor
                    feature={feature}
                    onMutation={onMutation}
                  />
                )}
                {feature.kind === 'delete_body' && editingFeatureId === feature.id && (
                  <div className="feature-editor">
                    <div className="feature-field-row feature-field-row--stacked">
                      <span className="feature-field-label">Body</span>
                      <PickChip
                        values={feature.delete_body?.body && feature.delete_body?.body !== 'None' ? [feature.delete_body.body] : []}
                        isPicking={pendingPickField?.featureId === feature.id && pendingPickField?.field === 'body'}
                        onActivate={() => {
                          if (pendingPickField?.featureId === feature.id && pendingPickField?.field === 'body') {
                            onSetPendingPickField(null)
                          } else {
                            onSetPendingPickField({ featureId: feature.id, field: 'body', hostKind: 'delete_body' })
                          }
                        }}
                        onRemove={() => onMutation({ type: 'set_delete_body_target', featureId: feature.id, body: '' })}
                        features={features}
                        partLabels={partLabels}
                      />
                    </div>
                  </div>
                )}
                {feature.kind === 'hole' && editingFeatureId === feature.id && (
                  <HoleEditor
                    feature={feature}
                    onMutation={onMutation}
                    pendingPickField={pendingPickField}
                    setPendingPickField={onSetPendingPickField}
                    features={features}
                    partLabels={partLabels}
                  />
                )}
                {feature.kind === 'transform' && editingFeatureId === feature.id && (
                  <TransformEditor
                    feature={feature}
                    onMutation={onMutation}
                    pendingPickField={pendingPickField}
                    setPendingPickField={onSetPendingPickField}
                    features={features}
                    partLabels={partLabels}
                  />
                )}
              </li>
            </div>
          )})
        )}
        {rollbackPosition === features.length && (
          <li
            className={`rollback-bar ${draggedRollback ? 'dragging' : ''}`}
            title="Rollback"
            draggable
            onDragStart={(e) => {
              setDraggedRollback(true)
              onRollbackDragStart(e)
            }}
            onDragOver={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setDropTargetIndex(features.length)
            }}
            onDrop={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onSetRollbackPosition(features.length)
              setDraggedRollback(false)
              setDropTargetIndex(null)
            }}
            onDragEnd={() => {
              setDraggedRollback(false)
              setDropTargetIndex(null)
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
            Object.entries(bodies || {}).map(([bodyId], index) => {
              const isHidden = visibleBodies ? !visibleBodies.has(bodyId) : false
              const partLabel = partLabels?.[bodyId] ?? `part ${index + 1}`
              return (
                <li
                  key={bodyId}
                  className={`part-item ${selection.has(`@${bodyId}`) ? 'selected' : ''}`}
                  onClick={() => {
                    if (pendingPickField?.field === 'boolean_target') {
                      onMutation({ type: 'set_boolean_target', featureId: pendingPickField.featureId, target: '@' + bodyId })
                      onSetPendingPickField(null)
                    } else if (pendingPickField?.field === 'boolean_tool') {
                      onMutation({ type: 'add_boolean_tool', featureId: pendingPickField.featureId, tool: '@' + bodyId })
                    } else if (pendingPickField?.field === 'body' && pendingPickField?.hostKind === 'transform') {
                      onMutation({ type: 'set_transform_field', featureId: pendingPickField.featureId, field: 'body', value: '@' + bodyId })
                      onSetPendingPickField(null)
                    } else if (pendingPickField?.field === 'body' && pendingPickField?.hostKind === 'delete_body') {
                      onMutation({ type: 'set_delete_body_target', featureId: pendingPickField.featureId, body: '@' + bodyId })
                      onSetPendingPickField(null)
                    } else {
                      onToggleSelect(`@${bodyId}`)
                    }
                  }}
                >
                  <img className="part-icon" src={featurePartIcon} alt="" />
                  <span className="part-name">{partLabel}</span>
                  {onToggleBodyVisibility && (
                    <button
                      className="part-visibility-btn"
                      onClick={(e) => { e.stopPropagation(); onToggleBodyVisibility(bodyId) }}
                      title={isHidden ? 'Show' : 'Hide'}
                    >
                      <img src={isHidden ? iconEyeOffIcon : iconEyeIcon} alt={isHidden ? 'Hidden' : 'Visible'} />
                    </button>
                  )}
                  <button
                    className="part-context-btn"
                    onClick={(e) => { e.stopPropagation(); onRightClick([e.clientX, e.clientY], `body:${bodyId}`) }}
                    title="More options"
                  >
                    <img src={iconDotsIcon} alt="Options" />
                  </button>
                </li>
              )
            })
          )}
        </ul>
      </div>
    </aside>
  )
}
