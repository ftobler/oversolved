// Ctrl+C / Ctrl+V inside a sketch, driven by the browser's native copy and
// paste events rather than navigator.clipboard: the events carry the data
// synchronously, need no permission prompt, and work on a plain-http dev
// server. A focused input or contenteditable keeps the browser's own text
// handling, so copying out of a dimension box still works.
//
// The handlers are document-level and always mounted by the part editor: with a
// sketch open the selection is copied and a clip is pasted, and outside one a
// valid clip still says which action opens a sketch. The keyboard registry
// never dispatches Ctrl+C / Ctrl+V, so it never cancels the native events.

import { useEffect, useRef } from 'react'
import type { Mutation, PartDoc, Point, SketchData } from '@/types/cad'
import type { Result } from '@/session/result'
import { isEditableTarget } from '@/hooks/commandRegistry'
import { MM_PER_LENGTH_UNIT, lengthUnitOf } from '@/utils/lengthUnit'
import { useEditorState } from '@/hooks/useEditorState'
import {
  buildSketchClip, clipBoundingBox, clipboardSelectionEntityIds, parseClip, serializeClip,
  PASTE_NEEDS_SKETCH, type SketchEntitiesClip,
} from '@/utils/clipboard/sketchClipboard'

export type ClipboardSeverity = 'info' | 'success' | 'error' | 'warning'

export interface SketchClipboardOptions {
  // The live document and solve; both update per render, so the hook keeps
  // them in a ref and the document listeners stay mounted once.
  doc: PartDoc | null
  solveResults: Record<string, SketchData>
  // The editor's one mutation sink, so a paste is one undo entry and a refusal
  // reaches the existing refusal toast through usePartDoc.
  onMutation: (m: Mutation) => Result | null
  notify: (message: string, severity?: ClipboardSeverity) => void
}

interface LastPaste {
  anchor: Point | null
  text: string
  repeats: number
}

function copyMessage(entities: number, constraints: number, fixed: number, outside: number): string {
  const entityText = `${entities} ${entities === 1 ? 'entity' : 'entities'}`
  const head = constraints > 0
    ? `Copied ${entityText} and ${constraints} ${constraints === 1 ? 'constraint' : 'constraints'}`
    : `Copied ${entityText}`
  if (fixed === 0 && outside === 0) return `${head}.`
  const broken: string[] = []
  if (fixed > 0) broken.push(`${fixed} fixed`)
  if (outside > 0) broken.push(`${outside} outside`)
  return `${head}; ${broken.join(' and ')} constraints were not copied.`
}

/** The 10 percent diagonal step a paste takes when it has no cursor anchor (or
 *  has already been pasted there), so a copy never lands exactly on its source. */
function fallbackStep(clip: SketchEntitiesClip, factor: number): Point {
  const diagonal = clipBoundingBox(clip).diagonal * factor
  return [0.1 * diagonal, -0.1 * diagonal]
}

/**
 * The translation that puts the clip's shape centre at the cursor on the sketch
 * plane, or one diagonal step away when there is no cursor. `factor` converts
 * the clip's own unit into the target document unit.
 */
export function pasteOffset(
  clip: SketchEntitiesClip,
  targetUnit: 'mm' | 'inch',
  anchor: Point | null,
): Point {
  const factor = MM_PER_LENGTH_UNIT[clip.length_unit] / MM_PER_LENGTH_UNIT[targetUnit]
  const step = fallbackStep(clip, factor)
  if (anchor === null) return step
  const center = clipBoundingBox(clip).center
  return [anchor[0] - center[0] * factor, anchor[1] - center[1] * factor]
}

/** The same anchor steps a repeated paste one more diagonal away; a moved
 *  cursor starts a fresh placement. */
function addStep(offset: Point, clip: SketchEntitiesClip, targetUnit: 'mm' | 'inch', repeats: number): Point {
  if (repeats === 0) return offset
  const factor = MM_PER_LENGTH_UNIT[clip.length_unit] / MM_PER_LENGTH_UNIT[targetUnit]
  const step = fallbackStep(clip, factor)
  return [offset[0] + step[0] * repeats, offset[1] + step[1] * repeats]
}

/**
 * Mount the native copy and paste handlers for the sketch clipboard. The part
 * editor calls this once; a sketch need not be open, because a paste must still
 * explain what to do with a clip when it is not.
 */
export function useSketchClipboard(options: SketchClipboardOptions): void {
  const live = useRef(options)
  const lastPaste = useRef<LastPaste | null>(null)

  useEffect(() => {
    live.current = options
  })

  useEffect(() => {
    const onCopy = (event: Event): void => {
      if (isEditableTarget(event)) return
      const { doc, solveResults, notify } = live.current
      const editor = useEditorState.getState()
      const featureId = editor.activeFeatureId
      if (doc === null || featureId === null) return
      const sketch = doc.features?.find(f => f.id === featureId)
      if (sketch?.kind !== 'sketch') return
      const selected = clipboardSelectionEntityIds(editor.normalSelection, sketch)
      if (selected.length === 0) return

      const built = buildSketchClip(sketch, selected, {
        solved: solveResults[featureId]?.solved,
        lengthUnit: lengthUnitOf(doc.length_unit),
      })
      if ('reason' in built) {
        event.preventDefault()
        notify(built.reason, 'error')
        return
      }
      const text = serializeClip(built.clip)
      const data = (event as ClipboardEvent).clipboardData
      if (data === null || data === undefined) {
        notify('This browser did not provide a clipboard for the copy.', 'error')
        return
      }
      data.setData('text/plain', text)
      event.preventDefault()
      notify(copyMessage(
        built.clip.entities.length,
        built.clip.constraints.length,
        built.broken.fixed,
        built.broken.outside,
      ), 'info')
    }

    const onPaste = (event: Event): void => {
      if (isEditableTarget(event)) return
      const text = (event as ClipboardEvent).clipboardData?.getData('text/plain') ?? ''
      if (text.trim().length === 0) return
      const parsed = parseClip(text)
      const { doc, onMutation, notify } = live.current
      const featureId = useEditorState.getState().activeFeatureId
      if ('reason' in parsed) {
        // Random text that is not a clip is the browser's business unless the
        // user is in a sketch, where a paste is meant for the sketch.
        if (featureId !== null) {
          event.preventDefault()
          notify(parsed.reason, 'error')
        }
        return
      }
      event.preventDefault()
      if (doc === null || featureId === null) {
        notify(PASTE_NEEDS_SKETCH, 'error')
        return
      }
      const sketch = doc.features?.find(f => f.id === featureId)
      if (sketch?.kind !== 'sketch') {
        notify(PASTE_NEEDS_SKETCH, 'error')
        return
      }

      const targetUnit = lengthUnitOf(doc.length_unit)
      const anchor = useEditorState.getState().drawHover
      const previous = lastPaste.current
      const samePlace = previous !== null && previous.text === text
        && (previous.anchor === null && anchor === null
          || previous.anchor !== null && anchor !== null
            && previous.anchor[0] === anchor[0] && previous.anchor[1] === anchor[1])
      const repeats = samePlace ? previous.repeats + 1 : 0
      const offset = addStep(pasteOffset(parsed, targetUnit, anchor), parsed, targetUnit, repeats)
      const result = onMutation({ type: 'paste_sketch_entities', featureId, clip: parsed, offset })
      if (result === null || !result.ok) return
      lastPaste.current = { anchor, text, repeats }
      const selected = new Set(result.createdIds.map(id => `entity:${featureId}:${id}`))
      useEditorState.getState().setNormalSelection(selected)
    }

    document.addEventListener('copy', onCopy)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('copy', onCopy)
      document.removeEventListener('paste', onPaste)
    }
  }, [])
}
