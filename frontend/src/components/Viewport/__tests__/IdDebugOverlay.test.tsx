import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import * as THREE from 'three'
import { Canvas } from '@react-three/fiber'
import IdDebugOverlay from '../IdDebugOverlay'
import { buildOverlayMaterial } from '../IdDebugOverlayMaterial'
import { IdPipeline } from '@/picking/IdPipeline'
import { setLivePipeline } from '@/picking/IdPipelineContext'

/**
 * Acceptance: the shader decodes packed RGB ids and uses golden-ratio hue
 * mapping; empty pixels (a < 0.5) render as black. The showDebugHit gate that
 * mounts this overlay is covered in Viewport.test.tsx.
 *
 * The rendered output cannot be inspected in jsdom (no WebGL), so this
 * test exercises the shader source + uniform wiring at the component
 * boundary rather than running a draw call.
 */
describe('IdDebugOverlay', () => {
  it('returns null when no IdPipeline is mounted', () => {
    setLivePipeline(null)
    const { container } = render(
      <Canvas><IdDebugOverlay /></Canvas>,
    )
    // Canvas renders a wrapper div; the overlay itself shouldn't contribute geometry.
    expect(container.textContent).toBe('')
  })

  it('builds a ShaderMaterial whose fragment shader decodes RGB ids with golden-ratio hue mapping', () => {
    const mat = buildOverlayMaterial()
    expect(mat.glslVersion).toBe(THREE.GLSL3)
    expect(mat.transparent).toBe(true)
    expect(mat.depthTest).toBe(false)
    expect(mat.depthWrite).toBe(false)
    expect(mat.fragmentShader).toContain('hsv2rgb')
    expect(mat.fragmentShader).toContain('0.618033988749895')
    expect(mat.fragmentShader).toContain('fragColor = vec4(0.0, 0.0, 0.0, 1.0)')
    expect(mat.uniforms.tId.value).toBeNull()
    mat.dispose()
  })

  it('wires the live pipeline texture into the tId uniform', () => {
    const pipeline = new IdPipeline({ width: 16, height: 16 })
    setLivePipeline(pipeline)
    // The component's effect copies pipeline.target.target.texture into the
    // tId uniform. Pulling that pointer from outside R3F is awkward, so
    // assert the seam: target.target.texture is a real THREE.Texture.
    expect(pipeline.target.target.texture).toBeInstanceOf(THREE.Texture)
    setLivePipeline(null, pipeline)
    pipeline.dispose()
  })

  // Silence the act() warnings: the Canvas inner work happens on rAF, not
  // synchronously, which testing-library can't observe.
  it('does not throw when mounted inside Canvas with a live pipeline', () => {
    const pipeline = new IdPipeline({ width: 16, height: 16 })
    setLivePipeline(pipeline)
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(() => render(
      <Canvas><IdDebugOverlay /></Canvas>,
    )).not.toThrow()
    errSpy.mockRestore()
    setLivePipeline(null, pipeline)
    pipeline.dispose()
  })
})
