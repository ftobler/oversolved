// Single source of truth for the viewport camera's initial pose. The Canvas
// (Viewport.tsx) creates the orthographic camera from INITIAL_CAMERA exactly
// once. After that, framing is content-driven (fitToContent); nothing returns
// to this fixed pose, so this only sets the orientation/zoom seen for the
// first frame before geometry arrives.
export const INITIAL_POSITION: [number, number, number] = [20, 20, 100]
export const INITIAL_ZOOM = 80

// near/far are the orthographic clipping planes.
export const INITIAL_CAMERA = { position: INITIAL_POSITION, zoom: INITIAL_ZOOM, near: -10, far: 1000 }
