// Guards the viewport label font: the warm-up, the per-label Suspense
// boundaries, and the fact that every <Text> site shares ONE font constant so
// their suspend keys cannot drift apart.
//
// These defects are invisible to a test that mocks drei's <Text> away, which is
// what the rest of the viewport suite does, so this file deliberately renders
// the REAL drei Text against the REAL suspend-react cache.
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
import { Suspense, type ReactNode } from 'react'
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
    // labelFont.ts calls this at module scope to point troika's own fallback
    // at the vendored font; inert here, but it must exist or the import throws.
    configureTextBuilder: () => {},
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
  // Billboard only orients a group at the camera; passing children straight
  // through keeps AngleDial's readout observable without a real R3F store.
  return {
    Text,
    Line: () => null,
    Billboard: ({ children }: { children?: ReactNode }) => <>{children}</>,
  }
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
    const { preloadViewportLabelFont, LABEL_FONT } = await import('@/components/Viewport/labelFont')
    const { Text } = await import('@react-three/drei')

    preloadViewportLabelFont()
    expect(fontRequests).toHaveLength(1)
    act(() => { releaseFont?.() })
    await settle()

    // The load-bearing assertion. A real drei <Text> looks the entry up under
    // ['troika-text', font, characters]; if the warm-up had filled any other
    // key this render would suspend and show the fallback instead. It also
    // proves the warm-up issues no second font request.
    //
    // `font` is passed explicitly, and that is the whole point rather than a
    // detail: a bare <Text> keys on ['troika-text', undefined, undefined] and
    // would fall back here even though the warm-up ran, because it asked for a
    // different font than the one the app renders with.
    const { container } = render(
      <Suspense fallback={<div data-testid="fallback" />}>
        <Text font={LABEL_FONT}>Front</Text>
      </Suspense>
    )
    await settle()

    expect(container.querySelector('[data-testid="fallback"]')).toBeNull()
    expect(container.querySelector('primitive')).not.toBeNull()
    expect(fontRequests).toHaveLength(1)
  })

  it('suspends a cold <Text>, which is the flicker the warm-up removes', async () => {
    const { LABEL_FONT } = await import('@/components/Viewport/labelFont')
    const { Text } = await import('@react-three/drei')

    // Control for the test above: with the cache cold the very same render
    // falls back, so the assertion there is testing the warm-up and not some
    // unconditional property of the renderer. Same props as that test on
    // purpose -- a control that keyed on a different font would prove nothing
    // about the entry the warm-up fills.
    const { container } = render(
      <Suspense fallback={<div data-testid="fallback" />}>
        <Text font={LABEL_FONT}>Front</Text>
      </Suspense>
    )
    await settle()

    expect(container.querySelector('[data-testid="fallback"]')).not.toBeNull()
  })

  it('asks for the font before any plane is toggled visible', async () => {
    const { preloadViewportLabelFont } = await import('@/components/Viewport/labelFont')
    const { PlaneLabel } = await import('@/components/Viewport/PlaneVisual')

    preloadViewportLabelFont()
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
    const { preloadViewportLabelFont } = await import('@/components/Viewport/labelFont')

    preloadViewportLabelFont()
    preloadViewportLabelFont()

    expect(fontRequests).toHaveLength(1)
  })
})

describe('plane label Suspense boundary', () => {
  it('keeps sibling scene content mounted while the label font is still loading', async () => {
    const { PlaneLabel } = await import('@/components/Viewport/PlaneVisual')

    // The scene as R3F builds it: one Canvas-wide boundary around everything.
    // Before Fix B a suspending label re-entered THIS fallback, which is what
    // made the whole viewport blank on the first unhide.
    const { container } = render(
      <Suspense fallback={<div data-testid="canvas-fallback" />}>
        <mesh data-testid="plane-surface" />
        <PlaneLabel x={0} y={0}>Front</PlaneLabel>
      </Suspense>
    )
    await settle()

    // Font deliberately still unresolved: the label is suspended right now.
    expect(releaseFont).not.toBeNull()
    expect(container.querySelector('[data-testid="canvas-fallback"]')).toBeNull()
    expect(container.querySelector('[data-testid="plane-surface"]')).not.toBeNull()

    // ...and the label arrives later without disturbing the plane.
    act(() => { releaseFont?.() })
    await settle()

    expect(container.querySelector('[data-testid="plane-surface"]')).not.toBeNull()
    expect(container.querySelector('primitive')).not.toBeNull()
  })

  it('does not blank an already-mounted scene when a second label appears', async () => {
    const { PlaneLabel } = await import('@/components/Viewport/PlaneVisual')

    // Toggling a plane visible adds a label to a live scene. The assertion that
    // matters is that the Canvas-wide boundary never re-enters its fallback
    // after the initial mount: that re-entry is what R3F turns into
    // hideInstance() on every object in the scene, i.e. the full-viewport flash.
    function Scene({ showLabel }: { showLabel: boolean }) {
      return (
        <Suspense fallback={<div data-testid="canvas-fallback" />}>
          <mesh data-testid="plane-surface" />
          {showLabel && <PlaneLabel x={0} y={0}>Front</PlaneLabel>}
        </Suspense>
      )
    }

    const { container, rerender } = render(<Scene showLabel={false} />)
    await settle()
    const surfaceBeforeToggle = container.querySelector('[data-testid="plane-surface"]')
    expect(surfaceBeforeToggle).not.toBeNull()

    rerender(<Scene showLabel />)
    await settle()

    expect(container.querySelector('[data-testid="canvas-fallback"]')).toBeNull()
    // Same DOM node, not a remount: the outer boundary never tore the scene
    // down and rebuilt it.
    expect(container.querySelector('[data-testid="plane-surface"]')).toBe(surfaceBeforeToggle)
  })
})

describe('AngleDial readout font', () => {
  // The dial mounts mid-gesture, on the first frame of a rotation-ring drag.
  // That is the worst possible moment to suspend the Canvas, and for a while it
  // could only ever have worked by accident: AngleDial passed no `font` at all
  // and had no boundary, so it stayed warm purely because drei's suspend key
  // happened to match the plane label's (both `undefined`). Naming a font for
  // the labels without naming the same one here would have split the keys.
  async function renderDial(showDial: boolean) {
    const { default: AngleDial } = await import('@/components/Viewport/assembly/AngleDial')
    const { GIZMO_AXES } = await import('@/utils/gizmoPickGeometry')
    return (
      <Suspense fallback={<div data-testid="canvas-fallback" />}>
        <mesh data-testid="scene-body" />
        {showDial && (
          <AngleDial def={GIZMO_AXES[0]} datum={0} swing={0.5} snapped={false} snapArmed />
        )}
      </Suspense>
    )
  }

  it('reuses the plane label warm-up, so a drag never refetches the font', async () => {
    const { preloadViewportLabelFont } = await import('@/components/Viewport/labelFont')

    preloadViewportLabelFont()
    act(() => { releaseFont?.() })
    await settle()

    // The regression assertion. One warm-up was issued, for the plane labels;
    // if AngleDial's <Text> resolved a different suspend key it would suspend
    // into the fallback here and ask troika for a second font.
    const { container } = render(await renderDial(true))
    await settle()

    expect(container.querySelector('[data-testid="canvas-fallback"]')).toBeNull()
    expect(container.querySelector('primitive')).not.toBeNull()
    expect(fontRequests).toHaveLength(1)
  })

  it('keeps the scene mounted if its font is somehow still cold', async () => {
    // Defence in depth for the case the warm-up never ran (an entry point that
    // forgets it, a future key change). The dial's own boundary has to absorb
    // the suspend so the drag it is annotating stays on screen.
    const { container } = render(await renderDial(true))
    await settle()

    expect(releaseFont).not.toBeNull()  // font deliberately unresolved
    expect(container.querySelector('[data-testid="canvas-fallback"]')).toBeNull()
    expect(container.querySelector('[data-testid="scene-body"]')).not.toBeNull()
  })

  it('does not blank a live scene when the dial appears mid-drag', async () => {
    const cold = await renderDial(false)
    const { container, rerender } = render(cold)
    await settle()
    const bodyBeforeDrag = container.querySelector('[data-testid="scene-body"]')

    rerender(await renderDial(true))
    await settle()

    expect(container.querySelector('[data-testid="canvas-fallback"]')).toBeNull()
    // Same node: the Canvas-wide boundary never re-entered its fallback, which
    // is what R3F turns into hideInstance() on every object in the scene.
    expect(container.querySelector('[data-testid="scene-body"]')).toBe(bodyBeforeDrag)
  })
})
