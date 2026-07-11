import * as THREE from 'three'

// Render the current scene into a small PNG data URL for a document thumbnail.
// Shared by the part Viewport and the AssemblyViewport so both editors capture
// their preview the same way on save. The renderer is briefly downsized to a
// quarter, drawn once, then restored, and the result is capped at MAX_SIZE so
// the stored preview_image stays small. Returns null when the GL context, scene
// or camera is not ready (e.g. the editor mounted headless in a unit test).
const MAX_SIZE = 1024

export async function captureThumbnail(
  gl: THREE.WebGLRenderer | null,
  scene: THREE.Scene | null,
  camera: THREE.Camera | null,
): Promise<string | null> {
  if (!gl || !scene || !camera) return null

  const originalSize = gl.getSize(new THREE.Vector2())
  const smallWidth = Math.floor(originalSize.width / 4)
  const smallHeight = Math.floor(originalSize.height / 4)

  // Yield a tick so any pending React-driven scene update has committed before
  // the one-off render we read the pixels from.
  await new Promise<void>(resolve => setTimeout(resolve, 0))

  gl.setSize(smallWidth, smallHeight)
  gl.render(scene, camera)
  const dataUrl = gl.domElement.toDataURL('image/png')

  gl.setSize(originalSize.width, originalSize.height)

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
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  ctx.drawImage(img, 0, 0, newWidth, newHeight)
  return canvas.toDataURL('image/png')
}
