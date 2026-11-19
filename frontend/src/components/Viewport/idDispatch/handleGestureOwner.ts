import { FEATURE_HANDLE_LAYER_NAME } from '@/picking'

/**
 * Ownership of one pointer gesture, held by the object the press landed on.
 *
 * A press on a feature handle arrow makes the whole gesture the handle's: the
 * release click must not resolve the RELEASE pixel. During a drag the arrow
 * moves away from the press pixel (and unregisters its own ID geometry while
 * active), so that pixel resolves to whatever face, edge or vertex is under
 * the cursor. Toggling it would pick an element the user never aimed at, and
 * an open feature's pick chip would consume the pick on top of it. The same
 * reason keeps hover off during the drag: lighting up a face the arrow passes
 * over promises a pick that cannot happen.
 *
 * The rule is keyed on the PRESS LAYER, not on the store's `drag`, because the
 * section-plane handle keeps its drag in local state and dispatches through
 * this same layer. A `drag`-keyed guard would silently miss it.
 *
 * Sketch vertex / edge and dimension-label drags arrive through the same
 * dispatcher adapters and have the same release-pixel problem when the dragged
 * element ends up under the cursor. They are covered by the second half of the
 * rule: the press armed a drag (the adapter set `dragPending`) and that drag
 * actually activated (the store's `drag` went live). Only the click half
 * applies to them: DragTool reads `hoveredVertexId` / `hoveredSnapKind` while
 * dragging, so hover must keep resolving.
 */
export interface HandleGestureOwner {
  // Begin a gesture. `layer` is the press hit's layer, or null for a miss.
  press(layer: string | null): void
  // Record whether the press armed a drag (the adapter set `dragPending`).
  noteDragArmed(armed: boolean): void
  // Record that the armed drag activated: the store's `drag` went non-null.
  noteDragActivated(): void
  // Feed a pointer move's button mask; a stranded move drops ownership.
  move(buttons: number): void
  // Whether hover must stay frozen for this move (a handle drag is live).
  suppressHover(): boolean
  // Whether the gesture still belongs to the handle press. The dispatcher keys
  // the pressed arrow's hover on this, so a stranded-release reset drops both
  // together.
  ownsHandle(): boolean
  // Read-and-clear the click verdict: does this gesture own the release click?
  takeClick(): boolean
}

export function createHandleGestureOwner(): HandleGestureOwner {
  let pressedOnHandle = false
  let dragArmed = false
  let dragActivated = false
  let hoverFrozen = false

  const reset = (): void => {
    pressedOnHandle = false
    dragArmed = false
    dragActivated = false
    hoverFrozen = false
  }

  return {
    press(layer: string | null): void {
      // The press is the gesture's start, so a flag stranded by a gesture whose
      // release happened outside the window can never leak into this one.
      reset()
      pressedOnHandle = layer === FEATURE_HANDLE_LAYER_NAME
    },

    noteDragArmed(armed: boolean): void {
      dragArmed = armed
    },

    noteDragActivated(): void {
      // Without the arming check, an unrelated live drag (a second pointer
      // pressing elsewhere) would hand this gesture's click to the other one.
      if (dragArmed) dragActivated = true
    },

    move(buttons: number): void {
      // No button held means the release was never seen: no click is coming, so
      // drop all ownership and let hover resume instead of freezing it until
      // the next press. This covers an armed sketch drag as well as a handle.
      if ((buttons & 1) === 0) {
        reset()
        return
      }
      if (!pressedOnHandle) return
      // The handle's own hover is what keeps the arrow painted hot and
      // labelled, so this does not clear hover; it only stops new resolves.
      hoverFrozen = true
    },

    suppressHover(): boolean {
      return hoverFrozen
    },

    ownsHandle(): boolean {
      return pressedOnHandle
    },

    takeClick(): boolean {
      const owns = pressedOnHandle || dragActivated
      reset()
      return owns
    },
  }
}
