import * as THREE from 'three'
import { presentFrame } from '@/components/Viewport/msaaPresenter'

// Render the current scene into a small PNG data URL for a document thumbnail.
// Shared by the part Viewport and the AssemblyViewport so both editors capture
// their preview the same way on save. The renderer is briefly downsized to a
// quarter, drawn once, then restored, and the result is capped at MAX_SIZE so
// the stored preview stays small. Returns null when the GL context, scene
// or camera is not ready (e.g. the editor mounted headless in a unit test).
const MAX_SIZE = 1024

export async function captureThumbnail(
  gl: THREE.WebGLRenderer | null,
  scene: THREE.Scene | null,
  camera: THREE.Camera | null,
): Promise<string | null> {
  if (!gl || !scene || !camera) return null

  const originalSize = gl.getSize(new THREE.Vector2())
  // A hidden or not-yet-laid-out viewport has no pixels to read; resizing it to
  // zero first would only make the pixel read fail later.
  if (originalSize.width < 1 || originalSize.height < 1) return null
  const smallWidth = Math.max(1, Math.floor(originalSize.width / 4))
  const smallHeight = Math.max(1, Math.floor(originalSize.height / 4))

  // Yield a tick so any pending React-driven scene update has committed before
  // the one-off render we read the pixels from.
  await new Promise<void>(resolve => setTimeout(resolve, 0))

  // The resize-down, render and pixel read all touch the LIVE renderer shared
  // with the on-screen Viewport, so a throw here (e.g. a WebGL context loss
  // mid-render) must still restore the original size before it propagates.
  // Otherwise the user is left staring at a permanently quarter-resolution
  // viewport for an incidental thumbnail capture. The original error is
  // rethrown after cleanup; callers (saveDoc) already catch around it.
  let dataUrl: string
  let captured = false
  // A document saved mid-section must not get a cut-open preview. Local
  // clipping is the renderer-wide switch every clipped material obeys, so
  // turning it off for the capture removes both the clip and (because the
  // stencil count of an unclipped closed solid is zero inside) the cap fill,
  // without touching any material or asking the scene to re-render.
  const previousLocalClipping = gl.localClippingEnabled
  try {
    gl.localClippingEnabled = false
    gl.setSize(smallWidth, smallHeight)
    presentFrame(gl, scene, camera)
    dataUrl = gl.domElement.toDataURL('image/png')
    captured = true
  } finally {
    gl.localClippingEnabled = previousLocalClipping
    gl.setSize(originalSize.width, originalSize.height)
    // A resize clears the drawing buffer, and the part viewport draws on demand
    // (frameloop="demand"): without a redraw the quarter-size capture would be
    // the last frame drawn and the viewport would sit blank until the next
    // unrelated change. Only after a capture that succeeded: on the error path
    // the renderer may be gone, and a second render would mask the original
    // failure. The assembly viewport (a continuous loop) only pays one extra
    // full-size draw.
    if (captured) presentFrame(gl, scene, camera)
  }

  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('Failed to load image'))
    img.src = dataUrl
  })

  const finalScale = Math.min(MAX_SIZE / img.width, MAX_SIZE / img.height, 1)
  const newWidth = Math.floor(img.width * finalScale)
  const newHeight = Math.floor(img.height * finalScale)

  const canvas = document.createElement('canvas')
  canvas.width = newWidth
  canvas.height = newHeight
  // A zero-sized viewport (hidden or not laid out yet) has nothing to read and
  // getImageData rejects a zero rectangle.
  if (newWidth === 0 || newHeight === 0) return null
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  ctx.drawImage(img, 0, 0, newWidth, newHeight)
  // A frame with no geometry at all renders as a fully transparent canvas (the
  // viewport clears to alpha 0 and shows its CSS background through it; both
  // Canvases keep `alpha` on). Storing that would replace a real thumbnail with
  // an empty tile, so an empty frame is a miss: the caller keeps whatever
  // preview it already had. A context lost between draw and read has no usable
  // pixels either, so the same miss is the right answer.
  let pixels: Uint8ClampedArray
  try {
    pixels = ctx.getImageData(0, 0, newWidth, newHeight).data
  } catch {
    return null
  }
  let hasContent = false
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] !== 0) { hasContent = true; break }
  }
  if (!hasContent) return null
  return canvas.toDataURL('image/png')
}
