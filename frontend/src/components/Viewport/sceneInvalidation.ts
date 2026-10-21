// The part viewport draws on demand (`frameloop="demand"` on its Canvas,
// Viewport/index.tsx): a frame is drawn when something that feeds the scene
// changed, not once per display refresh. Two of the three routes are already
// covered by R3F itself. The reconciler requests a frame for every scene
// instance it creates, updates or reveals, and TurntableControls requests
// one on every camera change (its change listener calls invalidate).
//
// What neither can see are the app stores. Their writes reach the scene
// through React renders that may or may not change an instance's props -- a
// hover highlight read three components down, a band selection, a drag
// preview -- and a store write with no matching prop change would otherwise
// leave the drawn frame stale until the next unrelated change.
//
// Subscribing to the stores is the one net that catches every such write: the
// stores only change when the user did something or a solve landed, which is
// exactly when a frame is wanted. This module uses no React or R3F API, so the
// policy is unit-tested against the real stores.
//
// A caution for future frame code: a store write from inside a `useFrame`
// callback would ask for the next frame from inside one (R3F turns an
// invalidate issued mid-frame into two more frames), so the loop could never
// settle. Frame callbacks must keep their writes in per-instance painter state
// (Body3D's VertexInstancePainter is the pattern), not in these stores.
import { editorState } from '@/stores/editorState'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSketchUiStore } from '@/stores/sketchEditorStore'
import { useViewOptionsStore } from '@/stores/viewOptionsStore'

// Structural so one list can hold stores with different state shapes.
interface SceneStore {
  subscribe: (listener: () => void) => () => void
}

// Every store that can change what the scene draws. `useSketchEditorStore` is
// not a fourth entry: it is `editorState` under its historical name
// (sketchEditorStore.ts). The view options are one more: shading, edges,
// brightness, zebra and curvature all change the image, and the assembly
// viewport shares them on a Canvas of its own.
const SCENE_STORES: readonly SceneStore[] = [
  usePartEditorStore,
  editorState,
  useSketchUiStore,
  useViewOptionsStore,
]

/**
 * Ask `invalidate` for a frame on every change in the scene-feeding stores.
 * Returns one unsubscribe for all of them.
 */
export function subscribeSceneInvalidation(invalidate: () => void): () => void {
  const unsubscribes = SCENE_STORES.map(store => store.subscribe(() => invalidate()))
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe()
  }
}
