// Regression: assembly-mode vertex highlights were drawn with THREE.Points and no
// alpha mask, so the hardware point sprite rendered as a square while the part
// editor's vertex dot (VertexDots.tsx Dot) is a circleGeometry mesh. This locks
// the pointsMaterial to carry a circular alphaMap so the two editors read the same.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import AssemblySelectionHighlight, {
  getVertexDotAlphaMap,
  resetVertexDotAlphaMapForTest,
} from '@/components/Viewport/assembly/AssemblySelectionHighlight'
import type { AssemblyPickBody } from '@/utils/assemblyPick'

function body(): AssemblyPickBody {
  return {
    handle: 'B',
    bodyKey: 'B',
    faces: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      triangleToFace: new Uint32Array([0]),
      faceQueries: ['f0'],
    },
    edges: {
      segmentPositions: new Float32Array([0, 0, 0, 1, 1, 1]),
      segmentToEdge: new Uint32Array([0]),
      edgeQueries: ['e0'],
    },
    vertices: { vertices: [[9, 9, 9]], vertexQueries: ['v0'] },
    faceBoundaries: null,
  }
}

describe('AssemblySelectionHighlight vertex overlay shape', () => {
  it('gives the selected vertex overlay a circular alpha mask', () => {
    const { container } = render(
      <AssemblySelectionHighlight pickBodies={[body()]} selection={new Set(['v0'])} hovered={null} />
    )
    const mat = container.querySelector('pointsmaterial')
    expect(mat?.hasAttribute('alphamap')).toBe(true)
  })

  it('gives the hovered vertex overlay a circular alpha mask', () => {
    const { container } = render(
      <AssemblySelectionHighlight pickBodies={[body()]} selection={new Set()} hovered="v0" />
    )
    const mat = container.querySelector('pointsmaterial')
    expect(mat?.hasAttribute('alphamap')).toBe(true)
  })
})

// jsdom ships no real canvas backend (getContext('2d') returns null), so
// getImageData pixel sampling is not available here. The recording-context
// mock below follows the same pattern already used for CubeGizmo.utils.test.ts:
// hand the draw path a fake 2d context and assert on the calls it made, which
// is enough to tell a circle (arc + fill, corners never touched) from a square
// (fillRect over the whole canvas) without needing a canvas dependency.
function makeRecordingCtx() {
  const calls: Array<[string, ...unknown[]]> = []
  const rec = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]) }
  const ctx = {
    beginPath: rec('beginPath'),
    arc: rec('arc'),
    fill: rec('fill'),
    fillRect: rec('fillRect'),
    fillStyle: '',
  }
  return { ctx, calls }
}

describe('getVertexDotAlphaMap', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    resetVertexDotAlphaMapForTest()
  })

  it('bakes a circle inscribed in the canvas, not a full-square fill', () => {
    resetVertexDotAlphaMapForTest()
    const { ctx, calls } = makeRecordingCtx()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation((() => ctx) as unknown as typeof HTMLCanvasElement.prototype.getContext)

    const texture = getVertexDotAlphaMap()

    const canvas = texture.image as HTMLCanvasElement
    expect(canvas.width).toBe(32)
    expect(canvas.height).toBe(32)

    const arcCall = calls.find(c => c[0] === 'arc')
    expect(arcCall).toBeDefined()
    const [, cx, cy, radius] = arcCall as [string, number, number, number]
    // Centered in the 32x32 canvas, with a radius kept short of the half-size
    // so the circle is inscribed -- a corner at distance ~22.6 from centre
    // stays outside it, unlike a square fill which would cover the corners too.
    expect(cx).toBeCloseTo(16)
    expect(cy).toBeCloseTo(16)
    expect(radius).toBeLessThan(16)

    expect(calls.some(c => c[0] === 'fill')).toBe(true)
    expect(calls.some(c => c[0] === 'fillRect')).toBe(false)
  })

  it('memoizes: repeated calls return the exact same texture instance', () => {
    resetVertexDotAlphaMapForTest()
    const { ctx } = makeRecordingCtx()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation((() => ctx) as unknown as typeof HTMLCanvasElement.prototype.getContext)

    const first = getVertexDotAlphaMap()
    const second = getVertexDotAlphaMap()
    expect(first).toBe(second)
  })
})
