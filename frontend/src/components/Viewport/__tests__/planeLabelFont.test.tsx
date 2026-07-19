// Guards the plane-label font warm-up. The defect it covers is invisible to a
// test that mocks drei's <Text> away, which is what the rest of the viewport
// suite does, so this file deliberately renders the REAL drei Text against the
// REAL suspend-react cache.
//
// Two mocks are unavoidable and neither touches the mechanism under test:
//   - `troika-three-text`, so the suite never reaches the jsdelivr CDN. The
//     stub still routes through preloadFont's (options, callback) contract,
//     which is the call drei itself makes.
//   - `@react-three/fiber`'s hooks, because there is no WebGL context in jsdom
//     and therefore no Canvas to host a real R3F store.
// drei is imported from its ESM subpath: bare `@react-three/drei` resolves to
// the CJS bundle under vitest, which closes over the real fiber module and so
// escapes the hook mock. `index.js` re-exports this exact component file.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { Suspense } from 'react'
import { clear } from 'suspend-react'

const fontRequests: unknown[] = []
let releaseFont: (() => void) | null = null

vi.mock('troika-three-text', async () => {
  const THREE = await import('three')
  // drei's <Text> constructs one of these; only sync/dispose are ever called
  // off the render path, and neither needs a GPU.
  class TroikaTextStub extends THREE.Mesh {
    sync(callback?: () => void) { callback?.() }
    dispose() {}
  }
  return {
    Text: TroikaTextStub,
    // Held open until a test releases it, so "is the cache warm?" is observable
    // as a render outcome rather than a timing race.
    preloadFont: (options: unknown, callback: () => void) => {
      fontRequests.push(options)
      releaseFont = callback
    },
  }
})

vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  useThree: (selector?: (state: unknown) => unknown) => {
    const state = { camera: { zoom: 1 }, invalidate: () => {} }
    return selector ? selector(state) : state
  },
}))

vi.mock('@react-three/drei', async () => {
  const { Text } = await import('@react-three/drei/core/Text.js')
  return { Text, Line: () => null }
})

async function settle() {
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  clear()  // suspend-react's globalCache is module-level and never evicted
  fontRequests.length = 0
  releaseFont = null
})

describe('plane label font preload', () => {
  it('warms the exact cache entry drei <Text> suspends on', async () => {
    const { preloadPlaneLabelFont } = await import('@/components/Viewport/PlaneVisual')
    const { Text } = await import('@react-three/drei')

    preloadPlaneLabelFont()
    expect(fontRequests).toHaveLength(1)
    act(() => { releaseFont?.() })
    await settle()

    // The load-bearing assertion. A real drei <Text> looks the entry up under
    // ['troika-text', font, characters]; if the warm-up had filled any other
    // key this render would suspend and show the fallback instead. It also
    // proves the warm-up issues no second font request.
    const { container } = render(
      <Suspense fallback={<div data-testid="fallback" />}>
        <Text>Front</Text>
      </Suspense>
    )
    await settle()

    expect(container.querySelector('[data-testid="fallback"]')).toBeNull()
    expect(container.querySelector('primitive')).not.toBeNull()
    expect(fontRequests).toHaveLength(1)
  })

  it('suspends a cold <Text>, which is the flicker the warm-up removes', async () => {
    const { Text } = await import('@react-three/drei')

    // Control for the test above: with the cache cold the very same render
    // falls back, so the assertion there is testing the warm-up and not some
    // unconditional property of the renderer.
    const { container } = render(
      <Suspense fallback={<div data-testid="fallback" />}>
        <Text>Front</Text>
      </Suspense>
    )
    await settle()

    expect(container.querySelector('[data-testid="fallback"]')).not.toBeNull()
  })

  it('asks for the font before any plane is toggled visible', async () => {
    const { preloadPlaneLabelFont, PlaneLabel } = await import('@/components/Viewport/PlaneVisual')

    preloadPlaneLabelFont()
    const requestsAtStartup = fontRequests.length
    act(() => { releaseFont?.() })
    await settle()

    // Mounting a label is the "unhide the plane" moment. The font must already
    // have been asked for, and mounting must not trigger a fresh fetch.
    render(<PlaneLabel x={0} y={0}>Front</PlaneLabel>)
    await settle()

    expect(requestsAtStartup).toBe(1)
    expect(fontRequests).toHaveLength(1)
  })

  it('is idempotent, so a second viewport mount refetches nothing', async () => {
    const { preloadPlaneLabelFont } = await import('@/components/Viewport/PlaneVisual')

    preloadPlaneLabelFont()
    preloadPlaneLabelFont()

    expect(fontRequests).toHaveLength(1)
  })
})
