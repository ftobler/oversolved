import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import type * as THREE from 'three'
import IdDebugOverlay from '../IdDebugOverlay'
import { setLivePipeline } from '@/picking/IdPipelineContext'
import type { IdPipeline } from '@/picking/IdPipeline'
import { DEFAULT_SECTION_STATE, useSectionStore } from '@/stores/sectionStore'

/**
 * The debug overlay is mounted directly (outside a real Canvas) so its effects
 * actually run: it must render nothing without a live pipeline, wire the
 * pipeline's render-target texture into its material, and dispose that
 * material on unmount so a toggled overlay does not leak a GPU shader.
 */

const mat = vi.hoisted(() => ({
  dispose: vi.fn(),
  make: vi.fn(),
  update: vi.fn(),
}))

vi.mock('../IdDebugOverlayMaterial', () => ({
  buildOverlayMaterial: () => {
    mat.make()
    return { dispose: mat.dispose }
  },
  updateOverlayTexture: (m: unknown, t: unknown) => mat.update(m, t),
}))

function fakePipeline(texture: unknown): IdPipeline {
  return {
    isDisposed: () => false,
    getTargetRevision: () => 0,
    target: { target: { texture } },
  } as unknown as IdPipeline
}

const publish = (p: IdPipeline | null) => act(() => setLivePipeline(p))

beforeEach(() => {
  mat.dispose.mockClear()
  mat.make.mockClear()
  mat.update.mockClear()
  useSectionStore.setState({ ...DEFAULT_SECTION_STATE })
  publish(null)
})

afterEach(() => {
  cleanup()
  publish(null)
})

describe('IdDebugOverlay direct mount', () => {
  it('renders nothing when no pipeline is live', () => {
    const { container } = render(<IdDebugOverlay />)
    expect(container.firstChild).toBeNull()
  })

  it('renders the full-screen quad and wires the pipeline texture when live', () => {
    const texture = { name: 'id-target-texture' } as unknown as THREE.Texture
    publish(fakePipeline(texture))

    const { container } = render(<IdDebugOverlay />)

    expect(container.querySelector('mesh')).not.toBeNull()
    expect(mat.update).toHaveBeenCalledTimes(1)
    expect(mat.update.mock.calls[0][1]).toBe(texture)
  })

  it('passes null when the pipeline has no target texture yet', () => {
    publish(fakePipeline(undefined))
    render(<IdDebugOverlay />)
    expect(mat.update.mock.calls[0][1]).toBeNull()
  })

  it('disposes the material on unmount', () => {
    publish(fakePipeline(null))
    const { unmount } = render(<IdDebugOverlay />)
    unmount()
    expect(mat.dispose).toHaveBeenCalledTimes(1)
  })

  it('rebinds the live texture when the section swaps the render target', () => {
    const first = { name: 'first' } as unknown as THREE.Texture
    const second = { name: 'second' } as unknown as THREE.Texture
    const pipeline = {
      isDisposed: () => false,
      target: { target: { texture: first } },
      getTargetRevision: () => 0,
    } as unknown as IdPipeline
    publish(pipeline)
    render(<IdDebugOverlay />)
    expect(mat.update.mock.calls.at(-1)?.[1]).toBe(first)

    // A section toggle recreates the ID target with a stencil attachment and
    // disposes the old texture. The overlay must follow the new identity.
    act(() => {
      ;(pipeline.target.target as { texture: THREE.Texture }).texture = second
      pipeline.getTargetRevision = () => 1
      useSectionStore.setState({ ...DEFAULT_SECTION_STATE, enabled: true, resolved: true })
    })

    expect(mat.update.mock.calls.at(-1)?.[1]).toBe(second)
  })
})
