// Two fixes for the triad's pick layer: the 1158-triangle soup must not be
// built while the layer is disabled (useRegisteredBody throws it away anyway),
// and each mounted triad must register under its own body key so a second mount
// cannot overwrite the first's registration.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import type { IdPipeline } from '@/picking'
import { IdPipelineContext } from '@/picking'
import GizmoPickLayer from '@/components/Viewport/assembly/GizmoPickLayer'
import { buildGizmoPickGeometry } from '@/utils/gizmoPickGeometry'

vi.mock('@react-three/fiber', () => ({
  useFrame: () => {},
  useThree: () => ({ camera: { isOrthographicCamera: true, zoom: 1 } }),
}))

vi.mock('@/utils/gizmoPickGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/gizmoPickGeometry')>()
  return {
    ...actual,
    // A tiny stand-in for the soup; the tests only count how often it is built.
    buildGizmoPickGeometry: vi.fn((): { positions: Float32Array; triangleToFace: Uint32Array; faceQueries: string[] } => ({
      positions: new Float32Array(0),
      triangleToFace: new Uint32Array(0),
      faceQueries: [],
    })),
  }
})

function fakePipeline() {
  const keys = new Set<string>()
  const registerPart = vi.fn((reg: { partKey: string }) => { keys.add(reg.partKey) })
  const unregisterPart = vi.fn((partKey: string) => { keys.delete(partKey) })
  const pipeline = {
    gizmoHandleLayer: { registerPart, unregisterPart },
    markDirty: vi.fn(),
  } as unknown as IdPipeline
  return { pipeline, keys, registerPart, unregisterPart }
}

function tree(pipeline: IdPipeline, children: React.ReactNode) {
  return <IdPipelineContext.Provider value={pipeline}>{children}</IdPipelineContext.Provider>
}

beforeEach(() => {
  vi.mocked(buildGizmoPickGeometry).mockClear()
})

describe('GizmoPickLayer disabled registration', () => {
  it('does not build or register the soup while disabled', () => {
    const { pipeline, keys, registerPart, unregisterPart } = fakePipeline()
    const view = render(tree(pipeline, <GizmoPickLayer origin={[0, 0, 0]} orientation={[0, 0, 0, 1]} enabled={false} />))
    for (let i = 1; i <= 10; i++) {
      view.rerender(tree(pipeline, <GizmoPickLayer origin={[i, 0, 0]} orientation={[0, 0, 0, 1]} enabled={false} />))
    }
    expect(buildGizmoPickGeometry).not.toHaveBeenCalled()
    expect(registerPart).not.toHaveBeenCalled()
    expect(view.container.firstChild).toBeNull()

    // Enabling builds and registers exactly once.
    view.rerender(tree(pipeline, <GizmoPickLayer origin={[11, 0, 0]} orientation={[0, 0, 0, 1]} enabled />))
    expect(buildGizmoPickGeometry).toHaveBeenCalledTimes(1)
    expect(registerPart).toHaveBeenCalledTimes(1)
    expect(keys.size).toBe(1)

    // Disabling again stops the build, and the registration is retired.
    view.rerender(tree(pipeline, <GizmoPickLayer origin={[12, 0, 0]} orientation={[0, 0, 0, 1]} enabled={false} />))
    expect(buildGizmoPickGeometry).toHaveBeenCalledTimes(1)
    expect(unregisterPart).toHaveBeenCalledTimes(1)
    expect(keys.size).toBe(0)
  })
})

describe('GizmoPickLayer per-instance body key', () => {
  function Two({ showSecond }: { showSecond: boolean }) {
    return (
      <>
        <GizmoPickLayer origin={[0, 0, 0]} orientation={[0, 0, 0, 1]} enabled />
        {showSecond && <GizmoPickLayer origin={[1, 0, 0]} orientation={[0, 0, 0, 1]} enabled />}
      </>
    )
  }

  it('registers each mounted triad under a distinct body key', () => {
    const { pipeline, keys, registerPart, unregisterPart } = fakePipeline()
    const view = render(tree(pipeline, <Two showSecond />))

    const registered = registerPart.mock.calls.map(c => c[0].partKey)
    expect(new Set(registered).size).toBe(2)
    expect(keys.size).toBe(2)

    // Unmounting one leaves the other's registration alone.
    view.rerender(tree(pipeline, <Two showSecond={false} />))
    expect(unregisterPart).toHaveBeenCalledTimes(1)
    expect(keys.size).toBe(1)
    expect(keys.has(registered[0])).toBe(true)
  })
})
