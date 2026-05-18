import React, { useState } from 'react'
import { isBodyFeatureResult } from '@/types/cad'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorCallbacks } from '@/contexts/PartEditorContext'
import { RebuildButton } from '@/components/RebuildButton'
import { FeatureItemActions } from '@/components/FeatureItemActions'
import { FeatureItemEditors } from '@/components/FeatureItemEditors'
import { RollbackSlider } from '@/components/RollbackSlider'
import featureSketchIcon from '@/assets/icons/feature-sketch.svg'
import featureExtrudeIcon from '@/assets/icons/feature-extrude.svg'
import featureRevolveIcon from '@/assets/icons/feature-revolve.svg'
import featureOriginIcon from '@/assets/icons/feature-origin.svg'
import featurePlaneIcon from '@/assets/icons/feature-plane.svg'
import featureFilletIcon from '@/assets/icons/feature-fillet.svg'
import featureChamferIcon from '@/assets/icons/feature-chamfer.svg'
import featureBooleanIcon from '@/assets/icons/feature-boolean.svg'
import featureArrayIcon from '@/assets/icons/feature-array.svg'
import featureDeleteBodyIcon from '@/assets/icons/feature-delete-body.svg'
import featureHoleIcon from '@/assets/icons/feature-hole.svg'
import featureTransformIcon from '@/assets/icons/feature-transform.svg'
import featureMirrorIcon from '@/assets/icons/feature-mirror.svg'
import featureImportIcon from '@/assets/icons/icon-upload.svg'

const BUILT_IN_IDS = new Set(['Origin', 'Top', 'Front', 'Right'])

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
    case 'mirror':
      return featureMirrorIcon
    case 'import_step':
      return featureImportIcon
    default:
      return featurePlaneIcon
  }
}

interface FeatureTreeProps {
  splitPercent: number
}

export function FeatureTree({ splitPercent }: FeatureTreeProps) {
  const features = usePartEditorStore(s => s.features)
  const doc = usePartEditorStore(s => s.doc)
  const rollbackPosition = usePartEditorStore(s => s.rollbackPosition)
  const editingFeatureId = usePartEditorStore(s => s.editingFeatureId)
  const visibleFeatures = usePartEditorStore(s => s.visibleFeatures)
  const partLabels = usePartEditorStore(s => s.partLabels)
  const solveResults = usePartEditorStore(s => s.solveResults)
  const bodies = usePartEditorStore(s => s.bodies)
  const isRebuilding = usePartEditorStore(s => s.isRebuilding)
  const featureTimings = usePartEditorStore(s => s.featureTimings)
  const validation = usePartEditorStore(s => s.validation)

  const selection = useSketchEditorStore(s => s.normalSelection)
  const planeSelectionFeatureId = useSketchEditorStore(s => s.planeSelectionFeatureId)
  const onSetPlaneSelectionFeatureId = useSketchEditorStore(s => s.setPlaneSelectionFeatureId)

  const {
    onToggleSelect,
    onEnterEditSketch,
    onExitEditSketch,
    onEnterEditFeature,
    onExitEditFeature,
    onEditCommit,
    onEditCancel,
    onToggleVisibility,
    onRightClick,
    onRollbackDragStart,
    onMutation,
    onSetRollbackPosition,
    onRebuild,
  } = usePartEditorCallbacks()

  const [draggedFeatureId, setDraggedFeatureId] = useState<string | null>(null)
  const [draggedRollback, setDraggedRollback] = useState(false)
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null)

  return (
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
          <RebuildButton featureTimings={featureTimings} features={features} onClick={onRebuild} isLoading={isRebuilding} validation={validation} />
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

          const isBuiltIn = BUILT_IN_IDS.has(feature.id)

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
              <RollbackSlider
                isDragging={draggedRollback}
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
              />
            )}
            <li
              key={feature.id}
              className={`feature-item ${index >= (rollbackPosition ?? features.length) ? 'rolled-back' : ''} ${!visibleFeatures.has(feature.id) ? 'invisible' : ''} ${feature.id === editingFeatureId ? 'editing' : ''} ${selection.has(`@${feature.id}`) ? 'selected' : ''} ${draggedFeatureId === feature.id ? 'dragging' : ''} ${dropTargetIndex === index ? 'drop-target-top' : ''} ${dropTargetIndex === index + 1 ? 'drop-target-bottom' : ''}`}
              draggable={!isBuiltIn && feature.id !== editingFeatureId}
              onDragStart={(e) => {
                if (isBuiltIn) return
                setDraggedFeatureId(feature.id)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', feature.id)
              }}
              onDragOver={(e) => {
                if (draggedFeatureId) {
                  e.preventDefault()
                  e.stopPropagation()
                  if (isBuiltIn) return
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
                onToggleSelect(`@${feature.id}`)
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
                      className={`feature-name${isError ? ' feature-name-error' : ''}${feature.suppressed ? ' feature-name-suppressed' : ''}`}
                      title={errMsg}
                    >
                      {feature.label || feature.id}
                    </span>
                  )
                })()}
                <FeatureItemActions
                  featureKind={feature.kind}
                  featureId={feature.id}
                  isEditing={feature.id === editingFeatureId}
                  isBuiltIn={isBuiltIn}
                  isOrigin={feature.id === 'Origin'}
                  isVisible={visibleFeatures.has(feature.id)}
                  hasVisibility={
                    feature.kind === 'sketch' ||
                    feature.kind === 'plane' ||
                    (isBuiltIn && feature.id !== 'Origin') ||
                    feature.id === editingFeatureId
                  }
                  onEnterEditSketch={onEnterEditSketch}
                  onExitEditSketch={onExitEditSketch}
                  onEnterEditFeature={onEnterEditFeature}
                  onExitEditFeature={onExitEditFeature}
                  onEditCommit={onEditCommit}
                  onEditCancel={onEditCancel}
                  onToggleVisibility={onToggleVisibility}
                  onRightClick={onRightClick}
                />
              </div>
              <FeatureItemEditors
                feature={feature}
                editingFeatureId={editingFeatureId}
                doc={doc}
                onMutation={onMutation}
                features={features}
                partLabels={partLabels}
                planeSelectionFeatureId={planeSelectionFeatureId}
                setPlaneSelectionFeatureId={onSetPlaneSelectionFeatureId}
              />
            </li>
          </div>
        )})
      )}
      {rollbackPosition === features.length && (
        <RollbackSlider
          isDragging={draggedRollback}
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
        />
      )}
    </ul>
    </div>
  )
}
