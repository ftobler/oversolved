// Single source of truth for the viewport camera's initial pose. The Canvas
// (Viewport.tsx) creates the orthographic camera from INITIAL_CAMERA exactly
// once; the Reset Viewport action (SceneController.tsx) returns to the same
// pose. Keep these in one place so the two never drift apart.
export const INITIAL_POSITION: [number, number, number] = [20, 20, 100]
export const INITIAL_ZOOM = 200

// near/far are the orthographic clipping planes.
export const INITIAL_CAMERA = { position: INITIAL_POSITION, zoom: INITIAL_ZOOM, near: -10, far: 1000 }
