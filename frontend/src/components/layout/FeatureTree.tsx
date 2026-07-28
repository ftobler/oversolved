import { useCallback, useEffect, useRef, useState } from 'react'
import { featureFailure } from '@/utils/core/featureFailure'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorCallbacks } from '@/contexts/PartEditorContext'
import { RebuildButton } from '@/components/rebuild/RebuildButton'
import { FeatureItemActions } from '@/components/layout/FeatureItemActions'
import { FeatureItemEditors } from '@/components/layout/FeatureItemEditors'
import { RollbackSlider } from '@/components/layout/RollbackSlider'
import { getFeatureIcon } from '@/components/layout/featureIcons'
import { builtinSelectionId } from '@/components/Geometry3D/utils'

const BUILT_IN_IDS = new Set(['Origin', 'Top', 'Front', 'Right'])

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
    onMutation,
    onSetRollbackPosition,
    onRebuild,
  } = usePartEditorCallbacks()

  const [draggedFeatureId, setDraggedFeatureId] = useState<string | null>(null)
  const [draggedRollback, setDraggedRollback] = useState(false)
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null)
  const listRef = useRef<HTMLUListElement>(null)

  // null means "end of stack" (edit exit resets to null), and out-of-order
  // deletes can leave a stale position past the end until the owner clamps it.
  // Normalize here so the bar is always drawn at exactly one place.
  const effectiveRollback = Math.min(rollbackPosition ?? features.length, features.length)
  // While a feature is edited the rollback is pinned to just after it (the
  // solver invariant depends on that), so the bar must not be draggable.
  const rollbackDraggable = editingFeatureId === null

  // Which slot the bar would land in for a cursor at `clientY`: the first
  // feature whose upper half the cursor is in, clamped past the built-ins
  // (the bar can never be parked above Origin/Top/Front/Right).
  const rollbackTargetAt = useCallback((clientY: number) => {
    const featureEls = listRef.current?.querySelectorAll('.feature-item') ?? []
    for (let i = 0; i < featureEls.length; i++) {
      const rect = featureEls[i].getBoundingClientRect()
      if (clientY < rect.top + rect.height / 2) {
        return Math.max(i, BUILT_IN_IDS.size)
      }
    }
    return features.length
  }, [features.length])

  // The rollback bar drags on raw pointer events instead of HTML5 drag-and-drop.
  // Native DnD only completes a drop if the browser processed a preventDefault'd
  // `dragover` at the moment the button is released; applying a finished rebuild
  // stalls the main thread right past that moment, so the release was swallowed
  // and the bar could not be let go while a rebuild ran. Pointer events queue up
  // instead of being discarded, so the release always arrives.
  useEffect(() => {
    if (!draggedRollback) return
    const stop = () => {
      setDraggedRollback(false)
      setDropTargetIndex(null)
    }
    const onMove = (e: PointerEvent) => setDropTargetIndex(rollbackTargetAt(e.clientY))
    const onUp = (e: PointerEvent) => {
      // A click that never left the bar's own slot is not an edit: committing it
      // would dirty the document and re-solve for nothing.
      const target = rollbackTargetAt(e.clientY)
      if (target !== effectiveRollback) onSetRollbackPosition(target)
      stop()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stop()  // abandon the drag, leave the bar where it was
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', stop)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', stop)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [draggedRollback, rollbackTargetAt, onSetRollbackPosition, effectiveRollback])

  return (
    <div
      className="sidebar-top"
      style={{ height: `${splitPercent}%` }}
    >
      <div className="sidebar-header">
        <span>Features</span>
        {onRebuild && (
          <RebuildButton featureTimings={featureTimings} features={features} onClick={onRebuild} isLoading={isRebuilding} validation={validation} />
        )}
      </div>
      <ul className="features-list" ref={listRef}>
      {features.length === 0 ? (
        <li className="empty">No features</li>
      ) : (
        features.map((feature, index) => {
          const isBuiltIn = BUILT_IN_IDS.has(feature.id)

          return (
          <div key={`feature-${feature.id}`}>
            {effectiveRollback === index && (
              <RollbackSlider
                isDragging={draggedRollback}
                enabled={rollbackDraggable}
                onGrab={() => setDraggedRollback(true)}
              />
            )}
            <li
              key={feature.id}
              className={`feature-item ${index >= effectiveRollback ? 'rolled-back' : ''} ${!visibleFeatures.has(feature.id) ? 'invisible' : ''} ${feature.id === editingFeatureId ? 'editing' : ''} ${selection.has(isBuiltIn ? builtinSelectionId(feature.id) : `@${feature.id}`) ? 'selected' : ''} ${draggedFeatureId === feature.id ? 'dragging' : ''} ${dropTargetIndex === index ? 'drop-target-top' : ''} ${dropTargetIndex === index + 1 ? 'drop-target-bottom' : ''}`}
              draggable={!isBuiltIn && feature.id !== editingFeatureId}
              onDragStart={(e) => {
                if (isBuiltIn) return
                setDraggedFeatureId(feature.id)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', feature.id)
              }}
              onDragOver={(e) => {
                if (!draggedFeatureId || isBuiltIn) return
                e.preventDefault()
                e.stopPropagation()
                const rect = e.currentTarget.getBoundingClientRect()
                const midY = rect.top + rect.height / 2
                const targetIndex = e.clientY < midY ? index : index + 1
                setDropTargetIndex(Math.max(targetIndex, BUILT_IN_IDS.size))
              }}
              onDragEnd={() => {
                setDraggedFeatureId(null)
                setDropTargetIndex(null)
              }}
              onDrop={(e) => {
                if (!draggedFeatureId) return
                e.preventDefault()
                e.stopPropagation()
                const fid = e.dataTransfer.getData('text/plain')
                if (fid && dropTargetIndex !== null && !BUILT_IN_IDS.has(fid)) {
                  onMutation({ type: 'reorder_features', featureId: fid, toIndex: dropTargetIndex })
                }
                setDraggedFeatureId(null)
                setDropTargetIndex(null)
              }}
              onClick={() => {
                onToggleSelect(isBuiltIn ? builtinSelectionId(feature.id) : `@${feature.id}`)
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
                  // No kind gate: the kernel reports a failure the same way for
                  // every kind, so the tree asks the same question for every
                  // kind (utils/core/featureFailure.ts).
                  const { failed, message } = featureFailure(feature.id, solveResults, bodies)
                  // Variables surface their solved value inline: `width = 100`.
                  // The store holds results as `unknown`, hence the cast.
                  const varValue = feature.kind === 'variable' && !failed
                    ? (solveResults?.[feature.id] as { value?: number } | undefined)?.value : undefined
                  return (
                    <span
                      className={`feature-name${failed ? ' feature-name-error' : ''}${feature.suppressed ? ' feature-name-suppressed' : ''}`}
                      title={message}
                    >
                      {feature.label || feature.id}
                      {varValue !== undefined ? ` = ${varValue}` : ''}
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
              />
            </li>
          </div>
        )})
      )}
      {effectiveRollback === features.length && (
        <RollbackSlider
          isDragging={draggedRollback}
          enabled={rollbackDraggable}
          onGrab={() => setDraggedRollback(true)}
        />
      )}
    </ul>
    </div>
  )
}
