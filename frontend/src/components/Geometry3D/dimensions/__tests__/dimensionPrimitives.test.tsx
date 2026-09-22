import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'

/**
 * The screen-space primitives shared by every dimension renderer. Their whole
 * job is to turn world-space anchor points into geometry sized in pixels, so
 * each test pins the concrete points / transform that a caller's anchor
 * produces at a known camera zoom, not merely that something rendered.
 *
 * The camera mock is orthographic with zoom 2, so p2w() is 0.5 and every
 * constant pixel length is half a world unit.
 */

// Capture the frame callbacks and hand each Line a fake three Line2 so the
// per-frame pixel-size updates can be driven directly, instead of trusting the
// R3F frame loop to run under jsdom.
const frame = vi.hoisted(() => {
  const position = {
    calls: [] as unknown[][],
    setXYZ: (...args: unknown[]) => { position.calls.push(args) },
    needsUpdate: false,
  }
  return {
    callbacks: [] as Array<() => void>,
    position,
    material: {} as Record<string, number>,
    reset: () => {
      position.calls.length = 0
      position.needsUpdate = false
      for (const key of Object.keys(frame.material)) delete frame.material[key]
    },
  }
})

vi.mock('@react-three/fiber', () => ({
  useThree: () => ({ camera: { isOrthographicCamera: true, zoom: 2 } }),
  useFrame: (cb: () => void) => { frame.callbacks.push(cb) },
}))

const LineSpy = vi.fn((_props: Record<string, unknown>) => null)
vi.mock('@react-three/drei', () => ({
  Line: (props: Record<string, unknown>) => {
    LineSpy(props)
    const ref = props.ref as { current: unknown } | undefined
    if (ref) ref.current = { geometry: { attributes: { position: frame.position } }, material: frame.material }
    return null
  },
}))

import { Arrowhead, ArrowTail, ExtensionLine, DashedLine } from '../primitives'

function runLatestFrame() {
  frame.callbacks.at(-1)!()
}

beforeEach(() => {
  LineSpy.mockClear()
  frame.callbacks.length = 0
  frame.reset()
})

describe('Arrowhead', () => {
  it('places the tip at the anchor and rotates the shape toward its source', () => {
    const { container } = render(<Arrowhead tip={[10, 0]} from={[0, 0]} color="#f00" />)

    const mesh = container.querySelector('mesh')!
    expect(mesh.getAttribute('position')).toBe('10,0,0')
    // tip straight along +X from the source: atan2(0, 10) = 0.
    expect(mesh.getAttribute('rotation')).toBe('0,0,0')
  })

  it('rotates by the tip-to-source angle for a diagonal arrow', () => {
    const { container } = render(<Arrowhead tip={[1, 1]} from={[0, 0]} color="#f00" />)

    // atan2(1, 1) = PI/4, stored as a raw number in the rotation array.
    const rotation = container.querySelector('mesh')!.getAttribute('rotation')!
    expect(rotation.split(',').map(Number)).toEqual([0, 0, Math.PI / 4])
  })
})

describe('ArrowTail', () => {
  it('draws a 25px tail from the origin along dir scaled to world units', () => {
    render(<ArrowTail origin={[2, 3]} dir={[1, 0]} color="#0f0" />)

    // 25px at p2w = 0.5 -> 12.5 world units.
    expect(LineSpy.mock.calls[0][0].points).toEqual([[2, 3, 0], [14.5, 3, 0]])
  })

  it('follows a non-axis direction', () => {
    render(<ArrowTail origin={[0, 0]} dir={[0, 1]} color="#0f0" />)

    expect(LineSpy.mock.calls[0][0].points).toEqual([[0, 0, 0], [0, 12.5, 0]])
  })
})

describe('ExtensionLine', () => {
  it('starts a 10px gap off the geometry and overshoots 6px past the far end', () => {
    render(<ExtensionLine start={[0, 0]} end={[0, 100]} color="#00f" />)

    // gap 10 * 0.5 = 5, overshoot 6 * 0.5 = 3.
    expect(LineSpy.mock.calls[0][0].points).toEqual([[0, 5, 0], [0, 103, 0]])
  })

  it('clamps the gap to 40% of a short segment so a witness line stays visible', () => {
    render(<ExtensionLine start={[0, 0]} end={[0, 10]} color="#00f" />)

    // min(10 * 0.5, 10 * 0.4) = 4, overshoot 3 past the end.
    expect(LineSpy.mock.calls[0][0].points).toEqual([[0, 4, 0], [0, 13, 0]])
  })

  it('survives a zero-length segment instead of normalising by zero', () => {
    render(<ExtensionLine start={[3, 4]} end={[3, 4]} color="#00f" />)

    expect(LineSpy.mock.calls[0][0].points).toEqual([[3, 4, 0], [3, 4, 0]])
  })

  it('honours explicit pixel gap and overshoot overrides', () => {
    render(<ExtensionLine start={[0, 0]} end={[0, 100]} color="#00f" overshootPx={20} gapPx={30} />)

    // gap 30 * 0.5 = 15, overshoot 20 * 0.5 = 10.
    expect(LineSpy.mock.calls[0][0].points).toEqual([[0, 15, 0], [0, 110, 0]])
  })
})

describe('DashedLine', () => {
  it('forwards its points and dashed config and defaults the dash pixel sizes', () => {
    render(
      <DashedLine
        points={[[0, 0, 0], [5, 0, 0]]}
        color="#abc"
        lineWidth={2}
        renderOrder={7}
        onPointerOver={vi.fn()}
        onPointerOut={vi.fn()}
      />,
    )

    expect(LineSpy).toHaveBeenCalledTimes(1)
    const props = LineSpy.mock.calls[0][0]
    expect(props.points).toEqual([[0, 0, 0], [5, 0, 0]])
    expect(props.dashed).toBe(true)
    // Initial placeholder sizes; useFrame rewrites them from dashPx/gapPx.
    expect(props.dashSize).toBe(0.01)
    expect(props.gapSize).toBe(0.005)
    expect(props.color).toBe('#abc')
    expect(props.lineWidth).toBe(2)
    expect(props.renderOrder).toBe(7)
  })
})

describe('per-frame pixel sizing', () => {
  it('ArrowTail rewrites both endpoints 25px out from the origin', () => {
    render(<ArrowTail origin={[2, 3]} dir={[1, 0]} color="#0f0" />)
    runLatestFrame()

    expect(frame.position.calls).toEqual([
      [0, 2, 3, 0],
      [1, 14.5, 3, 0],
    ])
    expect(frame.position.needsUpdate).toBe(true)
  })

  it('ExtensionLine rewrites the gap and overshoot points each frame', () => {
    render(<ExtensionLine start={[0, 0]} end={[0, 100]} color="#00f" />)
    runLatestFrame()

    expect(frame.position.calls).toEqual([
      [0, 0, 5, 0],
      [1, 0, 103, 0],
    ])
  })

  it('DashedLine rewrites the dash and gap sizes in pixels', () => {
    render(<DashedLine points={[[0, 0, 0], [5, 0, 0]]} color="#abc" lineWidth={1} dashPx={8} gapPx={6} />)
    runLatestFrame()

    // 8px and 6px at p2w = 0.5.
    expect(frame.material.dashSize).toBe(4)
    expect(frame.material.gapSize).toBe(3)
  })
})
