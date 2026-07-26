// Single source of truth for the viewport camera's initial pose. The Canvas
// (Viewport.tsx) creates the orthographic camera from INITIAL_CAMERA exactly
// once. After that, framing is content-driven (fitToContent); nothing returns
// to this fixed pose, so this only sets the orientation/zoom seen for the
// first frame before geometry arrives.
export const INITIAL_ZOOM = 80

// near/far are the orthographic clipping planes, measured along the view axis
// from the camera plane: negative near means "keep what is behind the camera",
// and it has to be negative. fitToContent frames by zoom and lateral slide
// only, never by dollying, so the camera stays at its initial ~103-unit
// standoff however big the model is; content is centred on the camera target,
// which puts half of it behind the camera plane. A near of -10 sliced the front
// off anything deeper than ~226 units while zoom happily framed the whole
// thing.
//
// These are only the first-frame values. Widening them here is not the way to
// support large models - the range is not free (see CLIP_PAD_FACTOR in
// cameraController), so fitToContent resizes both planes to the measured
// content instead. This range is kept modest and symmetric to match.
export const INITIAL_CAMERA = { position: [20, 20, 100] as [number, number, number], zoom: INITIAL_ZOOM, near: -500, far: 500 }
