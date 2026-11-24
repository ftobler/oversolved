import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { featureFailure } from '@/utils/core/featureFailure'
import { featureDisplayName } from '@/utils/core/displayNames'
import type { PartFeature } from '@/types/cad'
import { markNameClass } from '@/utils/core/statusMark'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { useEditorState } from '@/hooks/useEditorState'
import { usePartEditorCallbacks } from '@/contexts/PartEditorContext'
import { RebuildButton } from '@/components/rebuild/RebuildButton'
import { FeatureItemActions } from '@/components/layout/FeatureItemActions'
import { isEditableFeatureKind } from '@/components/layout/featureItemKinds'
import { hasFeatureVisibilityToggle } from '@/components/layout/featureVisibilityKinds'
import { RollbackSlider } from '@/components/layout/RollbackSlider'
import { getFeatureIcon } from '@/components/layout/featureIcons'
import { dropCueEdges, slotAt } from '@/components/layout/featureDropSlot'
import { shouldActivateDrag } from '@/utils/geometry/dragLogic'
import { BUILTIN_FEATURE_IDS } from '@/utils/builtins'
import { builtinSelectionId } from '@/components/Geometry3D/utils'
import { domHandleProps } from '@/picking'
import { usePartRelationHints } from '@/hooks/useRelationHint'
import { UnitText } from '@/components/editors/widgets/UnitLabel'

// Pixels of hold that turns a touch press into a row drag. Below it a touch is
// a scroll or a tap, never a reorder.
const TOUCH_LONG_PRESS_MS = 350
// How close to the list's top or bottom edge a drag starts scrolling it, and how
// far one animation frame moves it.
const AUTO_SCROLL_EDGE_PX = 24
const AUTO_SCROLL_STEP_PX = 8

interface FeatureDragStart {
  featureId: string
  fromIndex: number
  pointerId: number
  startX: number
  startY: number
  pointerType: string
}

// The features list is one of the part editor's floating cards now: it sizes to
// its content under a max-height and scrolls internally, with the open feature's
// editor body a separate panel on the other side of the viewport
// (FeatureEditPanel.tsx). The row keeps its `editing` highlight and swaps the
// edit button for OK / Cancel, so an edit can be ended where it began.
/** A row's text: the shared display name, except a variable, whose label is its
 *  own expression name (`width = 20`, not `variable 'width' = 20`). An
 *  unlabelled variable falls back to the kind ordinal. */
function treeRowName(feature: PartFeature, features: readonly PartFeature[]): string {
  if (feature.kind === 'variable') {
    const label = typeof feature.label === 'string' ? feature.label.trim() : ''
    return label !== '' ? label : featureDisplayName(feature, features)
  }
  return featureDisplayName(feature, features)
}

export function FeatureTree() {
  const features = usePartEditorStore(s => s.features)
  const doc = usePartEditorStore(s => s.doc)
  const rollbackPosition = useEditorState(s => s.rollbackPosition)
  const editingFeatureId = useEditorState(s => s.editingFeatureId)
  const visibleFeatures = usePartEditorStore(s => s.visibleFeatures)
  const solveResults = usePartEditorStore(s => s.solveResults)
  const parts = usePartEditorStore(s => s.parts)
  const isRebuilding = usePartEditorStore(s => s.isRebuilding)
  const featureTimings = usePartEditorStore(s => s.featureTimings)
  const validation = usePartEditorStore(s => s.validation)

  const selection = useSketchEditorStore(s => s.normalSelection)
  // The relation hint the selection drives. One derivation shared with every
  // viewport body, so a marked row and the tinted faces can never disagree.
  const relatedIds = usePartRelationHints().tree

  const {
    onToggleSelect,
    onEnterEditSketch,
    onEnterEditFeature,
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
  const [featureDrag, setFeatureDrag] = useState<FeatureDragStart | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  // The row the gesture started on: pointer capture is taken there, so the
  // browser keeps sending the gesture to the tree even off the row.
  const dragRowRef = useRef<HTMLElement | null>(null)
  // The click that follows a reorder release must not also select the row. The
  // flag is consumed by that click (same task as the release) and cleared on a
  // timer just after, so a click the browser delivers elsewhere cannot eat a
  // later one; any new press clears it too.
  const suppressRowClickRef = useRef(false)
  // The drag effect must not re-subscribe (and drop a pending touch hold) every
  // time a solve or a rebuild re-renders the tree.
  const onMutationRef = useRef(onMutation)
  useEffect(() => { onMutationRef.current = onMutation }, [onMutation])

  // null means "end of stack" (edit exit resets to null), and out-of-order
  // deletes can leave a stale position past the end until the owner clamps it.
  // Normalize here so the bar is always drawn at exactly one place.
  const effectiveRollback = Math.min(rollbackPosition ?? features.length, features.length)
  // While a feature is edited the rollback is pinned to just after it (the
  // solver invariant depends on that), so the bar must not be draggable.
  const rollbackDraggable = editingFeatureId === null

  // Which slot the bar would land in for a cursor at `clientY`. Shared with the
  // feature drag, so a row and the bar can never disagree about a position.
  const rollbackTargetAt = useCallback((clientY: number) => {
    const featureEls = listRef.current?.querySelectorAll('.feature-item') ?? []
    const rects = Array.from(featureEls, el => el.getBoundingClientRect())
    return slotAt(rects, clientY, BUILTIN_FEATURE_IDS.size)
  }, [])

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

  // Feature rows drag on pointer events too, for the same swallowed-release
  // reason and because a native drop only existed where a row's `dragover` had
  // been prevented: the gaps, the rollback bar and the empty tail refused the
  // drop while the cue kept promising it. The slot comes from the row rects
  // (`slotAt`), so every pointer position over the list names one.
  useEffect(() => {
    if (featureDrag === null) return
    const gesture = {
      ...featureDrag,
      active: false,
      timer: null as number | null,
      blocker: null as ((e: TouchEvent) => void) | null,
      frame: null as number | null,
      scrollDir: 0 as -1 | 0 | 1,
      lastX: featureDrag.startX,
      lastY: featureDrag.startY,
    }

    const rowRects = () => Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('.feature-item') ?? [],
      el => el.getBoundingClientRect(),
    )
    // The list's own rect is the cancel boundary: the header above it and the
    // Parts card below are outside. The empty tail stays inside, because the
    // list is the flexible card body.
    const pointerInsideList = (clientX: number, clientY: number) => {
      const rect = listRef.current?.getBoundingClientRect()
      if (!rect) return true
      return clientX >= rect.left && clientX <= rect.right
        && clientY >= rect.top && clientY <= rect.bottom
    }
    const slotFromPointer = (clientX: number, clientY: number) => (
      pointerInsideList(clientX, clientY)
        ? slotAt(rowRects(), clientY, BUILTIN_FEATURE_IDS.size)
        : null
    )
    const ownsPointer = (e: PointerEvent) => e.pointerId === gesture.pointerId
    const updateCue = (clientX: number, clientY: number) => setDropTargetIndex(slotFromPointer(clientX, clientY))

    const finish = () => {
      const wasActive = gesture.active
      gesture.active = false
      gesture.scrollDir = 0
      if (gesture.timer !== null) window.clearTimeout(gesture.timer)
      if (gesture.blocker !== null) window.removeEventListener('touchmove', gesture.blocker)
      if (gesture.frame !== null) cancelAnimationFrame(gesture.frame)
      const row = dragRowRef.current
      if (row?.hasPointerCapture?.(gesture.pointerId)) row.releasePointerCapture(gesture.pointerId)
      // The release's click is dispatched in the same task as pointerup. Clear
      // the flag on the next task so that click is still suppressed, while a
      // later click delivered elsewhere (a built-in row, the edited row) is not
      // eaten.
      if (wasActive) window.setTimeout(() => { suppressRowClickRef.current = false }, 0)
      setDraggedFeatureId(null)
      setDropTargetIndex(null)
      setFeatureDrag(null)
    }

    // Native DnD scrolled a long list near its edges; a gesture that can only
    // reach the visible rows would strand the features past them.
    const step = () => {
      gesture.frame = null
      const list = listRef.current
      if (!gesture.active || gesture.scrollDir === 0 || !list) return
      list.scrollTop += gesture.scrollDir * AUTO_SCROLL_STEP_PX
      updateCue(gesture.lastX, gesture.lastY)
      gesture.frame = requestAnimationFrame(step)
    }
    const updateAutoScroll = (clientX: number, clientY: number) => {
      const rect = listRef.current?.getBoundingClientRect()
      let dir: -1 | 0 | 1 = 0
      if (rect && pointerInsideList(clientX, clientY)) {
        if (clientY < rect.top + AUTO_SCROLL_EDGE_PX) dir = -1
        else if (clientY > rect.bottom - AUTO_SCROLL_EDGE_PX) dir = 1
      }
      gesture.scrollDir = dir
      if (dir !== 0 && gesture.frame === null) gesture.frame = requestAnimationFrame(step)
    }

    const activate = () => {
      if (gesture.active) return
      gesture.active = true
      gesture.timer = null
      if (gesture.pointerType === 'touch') {
        // A browser fixes touch-action when the gesture starts, so setting it
        // now cannot stop a scroll that is already armed; a non-passive
        // touchmove blocker can. Only the activated hold blocks, so a quick
        // swipe still scrolls the list.
        gesture.blocker = (event: TouchEvent) => event.preventDefault()
        window.addEventListener('touchmove', gesture.blocker, { passive: false })
      }
      const row = dragRowRef.current
      // jsdom has no pointer capture; the window listeners carry the gesture
      // there. In a browser the capture is what delivers the release when the
      // pointer is let go outside the window.
      if (row && typeof row.setPointerCapture === 'function') row.setPointerCapture(gesture.pointerId)
      suppressRowClickRef.current = true
      setDraggedFeatureId(gesture.featureId)
      updateCue(gesture.lastX, gesture.lastY)
      updateAutoScroll(gesture.lastX, gesture.lastY)
    }

    const onMove = (e: PointerEvent) => {
      if (!ownsPointer(e)) return
      gesture.lastX = e.clientX
      gesture.lastY = e.clientY
      if (!gesture.active) {
        if (!shouldActivateDrag([gesture.startX, gesture.startY], [e.clientX, e.clientY])) return
        // A finger that travels before the hold is a scroll, not a reorder.
        if (gesture.pointerType === 'touch') {
          finish()
          return
        }
        activate()
        return
      }
      updateCue(e.clientX, e.clientY)
      updateAutoScroll(e.clientX, e.clientY)
    }

    const onUp = (e: PointerEvent) => {
      if (!ownsPointer(e)) return
      const active = gesture.active
      const slot = active ? slotFromPointer(e.clientX, e.clientY) : null
      const { featureId, fromIndex } = gesture
      finish()
      // A release outside the list cancels. Its own slot and the one right
      // below it are where the feature already is.
      if (slot === null || slot === fromIndex || slot === fromIndex + 1) return
      onMutationRef.current({ type: 'reorder_features', featureId, toIndex: slot })
    }

    const onCancel = (e: PointerEvent) => {
      if (ownsPointer(e)) finish()
    }
    const onLostCapture = (e: PointerEvent) => {
      // A capture lost before the release means the pointer went somewhere the
      // page cannot see; that is a cancel, never a commit.
      if (ownsPointer(e) && gesture.active) finish()
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      finish()
    }

    if (gesture.pointerType === 'touch') gesture.timer = window.setTimeout(activate, TOUCH_LONG_PRESS_MS)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('lostpointercapture', onLostCapture)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      if (gesture.timer !== null) window.clearTimeout(gesture.timer)
      if (gesture.blocker !== null) window.removeEventListener('touchmove', gesture.blocker)
      if (gesture.frame !== null) cancelAnimationFrame(gesture.frame)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('lostpointercapture', onLostCapture)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [featureDrag])

  // Enter/Space on a focused row selects it, mirroring the row's click. Only the
  // row itself reacts: a key event bubbling from an action button inside the row
  // must not re-select the feature.
  const rowKeyDown = (e: ReactKeyboardEvent<HTMLLIElement>, select: () => void) => {
    if (e.target !== e.currentTarget) return
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    e.stopPropagation()
    select()
  }

  // The open editor is its own card now, so the edited row can sit outside the
  // list's scroll window. Pull it back into view when an edit starts; `nearest`
  // leaves an already-visible row where it is.
  useEffect(() => {
    if (editingFeatureId === null) return
    const row = listRef.current?.querySelector<HTMLElement>('.feature-item.editing')
    // jsdom (the unit tests) has no scrollIntoView; browsers all do.
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' })
  }, [editingFeatureId])

  // A face picked in the viewport can name a row above the list's scroll window.
  // Pull the first related row into view so the feedback is not off screen, but
  // only when the relation content changes: a re-solve while a row is selected
  // must not steal the scroll from the row being edited. `nearest` leaves a
  // visible row where it is.
  const relatedKey = useMemo(() => [...relatedIds].sort().join('\n'), [relatedIds])
  useEffect(() => {
    if (relatedKey === '' || editingFeatureId !== null) return
    const row = listRef.current?.querySelector<HTMLElement>('.feature-item.related')
    if (row && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' })
  }, [relatedKey, editingFeatureId])

  // The insertion line the live drag promises. Slot `features.length` has no
  // row below it, so its line is drawn on the last row's bottom; at the bar's
  // slot the line is drawn on the side the feature will actually land.
  const draggedIndex = draggedFeatureId === null
    ? -1
    : features.findIndex(f => f.id === draggedFeatureId)
  const cue = dropTargetIndex === null
    ? { top: null, bottom: null }
    : dropCueEdges(dropTargetIndex, features.length, effectiveRollback, draggedIndex)

  return (
    <div className="sidebar-top glass-panel">
      <div className="sidebar-header">
        <span>Features</span>
        {onRebuild && (
          <RebuildButton featureTimings={featureTimings} features={features} onClick={onRebuild} isLoading={isRebuilding} validation={validation} />
        )}
      </div>
      <ul className="features-list" ref={listRef} role="listbox" aria-label="Features">
      {doc && features.length === 0 ? (
        <li className="empty" role="presentation">No features</li>
      ) : (
        features.map((feature, index) => {
          const isBuiltIn = BUILTIN_FEATURE_IDS.has(feature.id)
          const selectionId = isBuiltIn ? builtinSelectionId(feature.id) : `@${feature.id}`
          // No kind gate: the kernel reports a failure the same way for every
          // kind, so the tree asks the same question for every kind
          // (utils/core/featureFailure.ts). The row and the open editor show
          // this one mark.
          const mark = featureFailure(feature.id, solveResults, parts)
          // A suppressed feature is not drawn, but its eye shows the stored
          // visibility, so the row does not read as hidden while the flag is on.
          const eyeShowsVisible = feature.suppressed === true
            ? feature.visible !== false
            : visibleFeatures.has(feature.id)

          return (
          <Fragment key={`feature-${feature.id}`}>
            {effectiveRollback === index && (
              <RollbackSlider
                isDragging={draggedRollback}
                enabled={rollbackDraggable}
                position={effectiveRollback}
                min={BUILTIN_FEATURE_IDS.size}
                max={features.length}
                onGrab={() => {
                  if (featureDrag === null) setDraggedRollback(true)
                }}
                onSetPosition={onSetRollbackPosition}
              />
            )}
            <li
              className={`feature-item ${!isBuiltIn && feature.id !== editingFeatureId ? 'draggable' : ''} ${index >= effectiveRollback ? 'rolled-back' : ''} ${eyeShowsVisible ? '' : 'invisible'} ${feature.id === editingFeatureId ? 'editing' : ''} ${selection.has(selectionId) ? 'selected' : ''} ${relatedIds.has(selectionId) ? 'related' : ''} ${draggedFeatureId === feature.id ? 'dragging' : ''} ${cue.top === index ? 'drop-target-top' : ''} ${cue.bottom === index ? 'drop-target-bottom' : ''}`}
              role="option"
              tabIndex={0}
              aria-selected={selection.has(selectionId)}
              onPointerDown={(e) => {
                // A new press ends whatever the last release left behind: the
                // suppression applies only to the click the drag itself made.
                suppressRowClickRef.current = false
                if (isBuiltIn || feature.id === editingFeatureId) return
                if (e.button !== 0 || e.isPrimary === false) return
                if (featureDrag !== null || draggedRollback) return
                // The action cluster keeps its own clicks: a press that starts
                // on the eye, edit, OK, Cancel or menu button is not a grab.
                if (e.target instanceof Element && e.target.closest('.feature-item-actions')) return
                dragRowRef.current = e.currentTarget
                setFeatureDrag({
                  featureId: feature.id,
                  fromIndex: index,
                  pointerId: e.pointerId,
                  startX: e.clientX,
                  startY: e.clientY,
                  pointerType: e.pointerType || 'mouse',
                })
              }}
              onDragStart={(e) => {
                // The icon is a draggable image by default; a native drag would
                // cancel the pointer gesture before it starts.
                e.preventDefault()
              }}
              onClick={() => {
                if (suppressRowClickRef.current) {
                  suppressRowClickRef.current = false  // the drag's release, not a select
                  return
                }
                onToggleSelect(selectionId)
              }}
              onKeyDown={(e) => rowKeyDown(e, () => onToggleSelect(selectionId))}
              onDoubleClick={(e) => {
                // A double-click in the action cluster is two button presses,
                // not an edit request: after Cancel closes the row the second
                // press can land on the returned edit button.
                if (e.target instanceof Element && e.target.closest('.feature-item-actions')) return
                if (isBuiltIn) return  // Origin/planes are not editable here
                // A double-click on the row already being edited would stack a
                // second editor session on the same feature. The Edit button
                // already hides while editing; the tree must match that guard.
                if (feature.id === editingFeatureId) return
                // Suppressed rows have no solved geometry to edit; their pencil
                // is disabled, and this gesture must not bypass it.
                if (feature.suppressed === true) return
                if (feature.kind === 'sketch') {
                  onEnterEditSketch(feature.id)
                } else if (isEditableFeatureKind(feature.kind)) {
                  onEnterEditFeature(feature.id)
                }
              }}
              {...domHandleProps(`tree:feature:${feature.id}`)}
            >
              <div className="feature-item-title">
                <img
                  src={getFeatureIcon(feature.kind)}
                  alt={feature.kind || 'feature'}
                  className="feature-icon"
                />
                {(() => {
                  // Variables surface their solved value inline: `width = 100`
                  // and `angle = 45 deg` when the variable carries a unit hint.
                  // The store holds results as `unknown`, hence the cast.
                  const varValue = feature.kind === 'variable' && !mark.failed
                    ? (solveResults?.[feature.id] as { value?: number } | undefined)?.value : undefined
                  const varUnit = feature.kind === 'variable' ? feature.variable?.unit : undefined
                  return (
                    <span
                      className={`feature-name${markNameClass(mark)}${feature.suppressed ? ' feature-name-suppressed' : ''}`}
                      title={mark.message || undefined}
                    >
                      {isBuiltIn ? (feature.label || feature.id) : treeRowName(feature, features)}
                      {varValue !== undefined ? ` = ${varValue}` : ''}
                      {/* The stored display hint, drawn as the same muted unit the
                          editors use. It is a free-form document string, not a
                          quantity: only a feature field knows what it measures. */}
                      {varValue !== undefined && varUnit ? <>{' '}<UnitText label={varUnit} /></> : null}
                    </span>
                  )
                })()}
                <FeatureItemActions
                  featureKind={feature.kind}
                  featureId={feature.id}
                  isEditing={feature.id === editingFeatureId}
                  isBuiltIn={isBuiltIn}
                  isOrigin={feature.id === 'Origin'}
                  isVisible={eyeShowsVisible}
                  hasVisibility={hasFeatureVisibilityToggle(feature.kind)}
                  isSuppressed={feature.suppressed === true}
                  onEnterEditSketch={onEnterEditSketch}
                  onEnterEditFeature={onEnterEditFeature}
                  onEditCommit={onEditCommit}
                  onEditCancel={onEditCancel}
                  onToggleVisibility={onToggleVisibility}
                  onRightClick={onRightClick}
                />
              </div>
            </li>
          </Fragment>
        )})
      )}
      {effectiveRollback === features.length && (
        <RollbackSlider
          isDragging={draggedRollback}
          enabled={rollbackDraggable}
          position={effectiveRollback}
          min={BUILTIN_FEATURE_IDS.size}
          max={features.length}
          onGrab={() => {
            if (featureDrag === null) setDraggedRollback(true)
          }}
          onSetPosition={onSetRollbackPosition}
        />
      )}
    </ul>
    </div>
  )
}
