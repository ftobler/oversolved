import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The legacy per-face rainbow debug coloring + wireframe overlay path in
 * Body3D was retired when the GPU-ID debug overlay (#265) shipped. Pin
 * that removal so a future "let's bring back the rainbow" can't slip in
 * silently and override face colors on the visible mesh.
 */
describe('Body3D legacy debug-hit path', () => {
  it('has no debugFaceColors / WireframeGeometry usage', () => {
    const src = readFileSync(
      join(__dirname, '..', 'Body3D.tsx'),
      'utf8',
    )
    expect(src).not.toMatch(/\bdebugFaceColors\b/)
    expect(src).not.toMatch(/\bWireframeGeometry\b/)
    // The face-color attribute writes faceColors directly now, not an
    // "activeColors" fallback chain.
    expect(src).not.toMatch(/\bactiveColors\b/)
  })

  it('threads no per-component showDebugHit prop', () => {
    // The live debug-hit view is the store flag read by IdDebugOverlay. Body3D
    // and Geometry3D used to declare the prop without ever reading it, so pin
    // that neither can regrow it.
    for (const file of ['Body3D.tsx', 'index.tsx']) {
      const src = readFileSync(join(__dirname, '..', file), 'utf8')
      expect(src).not.toMatch(/\bshowDebugHit\b/)
    }
  })
})
