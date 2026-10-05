// The latch warn is the only channel a lost ID layer's picking gets (the
// pipeline has no useNotify), so it must fire in a production build too; the
// per-frame "render failed" warn stays dev-gated because it repeats on every
// failing frame. vitest cannot flip import.meta.env.DEV, so isDevBuild is
// mocked to the production answer.
import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'

const devGate = vi.hoisted(() => ({ value: false }))

vi.mock('@/kernel/isDevBuild', () => ({ isDevBuild: () => devGate.value }))

import { IdPipeline } from '../IdPipeline'

function registerOneFace(p: IdPipeline, bodyKey: string): void {
  p.faceLayer.registerBody({
    bodyKey,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    triangleToFace: new Uint32Array([0]),
    faceQueries: ['face@q'],
  })
}

function failingRenderer(failScene: THREE.Scene): THREE.WebGLRenderer {
  return {
    getRenderTarget: () => null,
    setRenderTarget: () => {},
    autoClear: true,
    getClearColor: () => {},
    getClearAlpha: () => 0,
    setClearColor: () => {},
    clear: () => {},
    clearDepth: () => {},
    render: (scene: THREE.Scene) => {
      if (scene === failScene) throw new Error('layer render exploded')
    },
  } as unknown as THREE.WebGLRenderer
}

describe('IdPipeline production diagnostics', () => {
  it('warns at the latch transition even in a production build', () => {
    devGate.value = false
    const p = new IdPipeline({ width: 32, height: 32 })
    registerOneFace(p, 'b1')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const renderer = failingRenderer(p.faceLayer.scene)
    const camera = new THREE.Camera()
    try {
      // Two consecutive failures trip LAYER_FAILURE_LATCH_THRESHOLD.
      p.markDirty()
      p.render(renderer, camera)
      p.markDirty()
      p.render(renderer, camera)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('latched out'), expect.any(Error))
    } finally {
      warn.mockRestore()
      p.dispose()
    }
  })

  it('keeps the per-frame render-failure warn dev-only', () => {
    devGate.value = false
    const p = new IdPipeline({ width: 32, height: 32 })
    registerOneFace(p, 'b1')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      p.markDirty()
      p.render(failingRenderer(p.faceLayer.scene), new THREE.Camera())
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('render failed'))
    } finally {
      warn.mockRestore()
      p.dispose()
    }
  })
})
