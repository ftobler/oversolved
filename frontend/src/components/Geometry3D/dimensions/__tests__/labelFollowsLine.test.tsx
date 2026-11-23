import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import * as THREE from 'three'
import type { LineGeometry } from 'three-stdlib'
import { useSketchUiStore } from '@/stores/sketchEditorStore'
import { dimensionLineGap } from '@/utils/geometry/dimensionRenderLayout'
import { buildPlaneMatrix } from '@/picking/idRegistrationUtils'
import type { PlaneTransform } from '@/types/cad'

/**
 * A linear dimension's value reads along its dimension line: the label's text
 * block is rotated by the screen-space angle of d1 -> d2, folded so it never
 * reads upside down. Dimension types without a line (radius, diameter, angle)
 * leave the label upright. The line itself is cut around the text, with the
 * gap sized in screen pixels and converted along the line's own projected
 * direction.
 *
 * The camera is real and orthographic, framed so one world unit is one CSS
 * pixel in a flat view. The gap's factor is still the line's projected scale:
 * a tilted sketch plane foreshortens the line, so each of its screen pixels
 * spans more world and the cut grows to cover the same rendered text. The frame
 * callback is captured and driven by hand, so the per-frame pass (which the
 * real viewport runs before every paint) is covered too.
 *
 * The Line mock owns a real three-stdlib LineGeometry, and the assertions read
 * its instanceStart/instanceEnd attributes back. That is the endpoint store of
 * a Line2: a mock that exposed `attributes.position` would happily pass while
 * the app kept both halves at the full line, because `position` is only the
 * endcap template.
 */

interface LineProbe { geometry: LineGeometry; visible: boolean }

const seams = vi.hoisted(() => ({
  useThree: vi.fn(),
  frame: null as null | (() => void),
  lines: [] as LineProbe[],
  arrowheads: [] as Array<Record<string, unknown>>,
  camera: null as unknown as THREE.OrthographicCamera,
}))

vi.mock('@react-three/fiber', () => ({
  useThree: (...args: unknown[]) => seams.useThree(...args),
  useFrame: (cb: () => void) => { seams.frame = cb },
}))

vi.mock('@react-three/drei', async () => {
  const React = await import('react')
  const { LineGeometry: RealLineGeometry } = await import('three-stdlib')
  return {
    Line: ({ ref, points }: { ref?: unknown; points?: ReadonlyArray<ReadonlyArray<number>> }) => {
      if (ref && typeof ref === 'object' && 'current' in ref) {
        const geometry = new RealLineGeometry()
        geometry.setPositions((points ?? []).flatMap(p => [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0]))
        const probe: LineProbe = { geometry, visible: true }
        seams.lines.push(probe)
        ;(ref as { current: unknown }).current = probe
      }
      return null
    },
    Html: ({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) =>
      React.createElement('div', { 'data-testid': 'html', style }, children),
  }
})

vi.mock('../primitives', () => ({
  Arrowhead: (props: Record<string, unknown>) => { seams.arrowheads.push(props); return null },
  ArrowTail: () => null,
  ExtensionLine: () => null,
}))
vi.mock('@/picking/useDimensionLabelIdRegistration', () => ({
  useDimensionLabelIdRegistration: vi.fn(),
}))
vi.mock('../useDimDispatchRegistration', () => ({
  useDimDispatchRegistration: vi.fn(),
}))

import { LinearDimension } from '../Linear'
import { RadiusDimension } from '../Radial'
import { useEditorState } from '@/hooks/useEditorState'

type Dim = React.ComponentProps<typeof LinearDimension>['dim']

// Frustum equal to the 800 x 600 canvas at zoom 1, so world units are pixels
// in a flat view. Deep near/far so a tilted plane's world z stays inside it.
function frontCamera(): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(0, 800, 600, 0, -1000, 1000)
  camera.position.set(0, 0, 10)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  camera.updateProjectionMatrix()
  return camera
}

function renderLinear(dim: Dim, planeTransform?: PlaneTransform) {
  return render(<LinearDimension cid="c1" dim={dim} dimOffset={10} planeTransform={planeTransform} />)
}

function textDiv(container: HTMLElement): HTMLElement {
  const wrapper = container.querySelector('[data-testid="html"]') as HTMLElement | null
  expect(wrapper, 'the Html wrapper was never rendered').not.toBeNull()
  return wrapper!.firstElementChild as HTMLElement
}

// jsdom has no layout, so the text block's box has to be supplied. 80 px of
// digits plus the block's own 5 px padding either side is 88; 17 is a 14 px
// line plus padding.
function stubTextSize(div: HTMLElement, width = 88, height = 17) {
  Object.defineProperty(div, 'offsetWidth', { configurable: true, value: width })
  Object.defineProperty(div, 'offsetHeight', { configurable: true, value: height })
}

// What the renderer would draw for a Line2: the single segment in its
// instance attributes, plus the object's visibility.
function span(probe: LineProbe) {
  const start = probe.geometry.attributes.instanceStart as THREE.InterleavedBufferAttribute
  const end = probe.geometry.attributes.instanceEnd as THREE.InterleavedBufferAttribute
  return {
    visible: probe.visible,
    p1: [start.getX(0), start.getY(0)],
    p2: [end.getX(0), end.getY(0)],
  }
}

// A sketch plane tilted about its local X, so local Y climbs into +Z and a
// front camera sees a local-Y line foreshortened by cos(tilt).
function tiltedPlane(deg: number): PlaneTransform {
  const rad = (deg * Math.PI) / 180
  const c = Math.cos(rad), s = Math.sin(rad)
  return { rotation: [1, 0, 0, 0, c, s, 0, -s, c], origin: [0, 0, 0] }
}

// World units per screen pixel measured ALONG a line, derived independently of
// the component from the real projection: the factor the cut must use. The
// isotropic scale is not this.
function alongFactor(planeTransform: PlaneTransform, a: [number, number], b: [number, number]): number {
  const matrix = buildPlaneMatrix(planeTransform)
  const p1 = new THREE.Vector3(a[0], a[1], 0).applyMatrix4(matrix).project(seams.camera)
  const p2 = new THREE.Vector3(b[0], b[1], 0).applyMatrix4(matrix).project(seams.camera)
  const px = Math.hypot((p2.x - p1.x) * 400, -(p2.y - p1.y) * 300)
  return Math.hypot(b[0] - a[0], b[1] - a[1]) / px
}

beforeEach(() => {
  seams.lines.length = 0
  seams.arrowheads.length = 0
  seams.frame = null
  seams.camera = frontCamera()
  const state = {
    camera: seams.camera,
    size: { width: 800, height: 600 },
    invalidate: vi.fn(),
  }
  seams.useThree.mockImplementation((selector: (s: typeof state) => unknown) => selector(state))
  useEditorState.setState({
    drag: null,
    dragPending: null,
    dragStartClient: null,
    isPointerDown: false,
    normalSelection: new Set(),
    hoveredConstraintEntityIds: new Set(),
  })
  useSketchUiStore.setState({ pendingDialog: null })
})

const BASE: Dim = { kind: 'dim_linear', p1: [0, 0], p2: [10, 0], normal: [0, 1], value: 10 }

describe('linear label follows its dimension line', () => {
  it('tilts a rising line counterclockwise in CSS, so the text lies along it', () => {
    const { container } = renderLinear({ ...BASE, p2: [10, 5] })

    // atan2(-5 px, 10 px) = -26.565 degrees, rounded to one decimal.
    expect(textDiv(container).style.transform).toBe('rotate(-26.6deg)')
  })

  it('tilts a falling line clockwise', () => {
    const { container } = renderLinear({ ...BASE, p2: [10, -5], normal: [0, -1] })

    expect(textDiv(container).style.transform).toBe('rotate(26.6deg)')
  })

  it('leaves a horizontal dimension upright', () => {
    const { container } = renderLinear(BASE)

    expect(textDiv(container).style.transform).toBe('rotate(0deg)')
  })

  it('recomputes the angle from the live camera in the frame pass', () => {
    const { container } = renderLinear({ ...BASE, p2: [10, 5] })
    expect(textDiv(container).style.transform).toBe('rotate(-26.6deg)')

    // Look from behind the sketch: both screen axes flip, so the same line now
    // falls to the right. No re-render happens between the orbit and the frame.
    seams.camera.position.set(0, 0, -10)
    seams.camera.up.set(0, -1, 0)
    seams.camera.lookAt(0, 0, 0)
    seams.camera.updateMatrixWorld(true)
    seams.frame?.()

    expect(textDiv(container).style.transform).toBe('rotate(26.6deg)')
  })

  it('puts the rotation on the text block, not the Html anchor', () => {
    const { container } = renderLinear({ ...BASE, p2: [10, 5] })
    const wrapper = container.querySelector('[data-testid="html"]') as HTMLElement

    expect(wrapper.style.transform).toBe('')
    expect(textDiv(container).style.transform).toContain('rotate(')
  })
})

describe('linear dimension line gap', () => {
  it('cuts the line around the text through the Line2 instance attributes', () => {
    const { container } = renderLinear({ ...BASE, p1: [0, 0], p2: [200, 0] })
    stubTextSize(textDiv(container))
    seams.frame?.()

    // One world unit per pixel at zoom 1; the same split the pure helper makes.
    const expected = dimensionLineGap([0, 10], [200, 10], [100, 10], 88 + 8, 8.5)
    expect(expected).toHaveLength(2)
    expect(span(seams.lines[0])).toEqual({ visible: true, p1: expected[0][0], p2: expected[0][1] })
    expect(span(seams.lines[1])).toEqual({ visible: true, p1: expected[1][0], p2: expected[1][1] })
    expect(span(seams.lines[0]).p2).toEqual([52, 10])
  })

  it('re-cuts the gap when the camera zooms, half the world per pixel at zoom 2', () => {
    const { container } = renderLinear({ ...BASE, p1: [0, 0], p2: [200, 0] })
    stubTextSize(textDiv(container))
    seams.frame?.()
    expect(span(seams.lines[0]).p2).toEqual([52, 10])

    seams.camera.zoom = 2
    seams.camera.updateProjectionMatrix()
    seams.frame?.()

    const expected = dimensionLineGap([0, 10], [200, 10], [100, 10], (88 + 8) / 2, 8.5 / 2)
    expect(span(seams.lines[0])).toMatchObject({ visible: true, p1: expected[0][0], p2: expected[0][1] })
    expect(span(seams.lines[1])).toMatchObject({ visible: true, p1: expected[1][0], p2: expected[1][1] })
    expect(span(seams.lines[0]).p2).toEqual([76, 10])
  })

  it('hides a half that has no drawable span instead of collapsing it', () => {
    // Text wider than the whole line: no line between the arrows.
    const { container } = renderLinear({ ...BASE, p1: [0, 0], p2: [10, 0] })
    stubTextSize(textDiv(container))
    seams.frame?.()

    for (const probe of [seams.lines[0], seams.lines[1]]) {
      const drawn = span(probe)
      expect(drawn.visible).toBe(false)
      // Never parked at a collapsed endpoint: a zero-length segment makes the
      // shader normalize a zero vector.
      expect(drawn.p1).not.toEqual(drawn.p2)
    }
  })

  it('stops an outside leader at the near edge of the text', () => {
    // Label at (65, 0), past d2: the leader would otherwise run through the
    // digits, which are 44 world units wide either side of the label here.
    const { container } = renderLinear({ ...BASE, p1: [0, 0], p2: [10, 0], pos: [60, 0] })
    stubTextSize(textDiv(container))
    seams.frame?.()

    expect(span(seams.lines[0])).toMatchObject({ visible: true, p1: [0, 0], p2: [10, 0] })
    expect(span(seams.lines[1]).visible).toBe(false)
    expect(span(seams.lines[2])).toMatchObject({ visible: true, p1: [10, 0], p2: [21, 0] })
  })

  it('hides the leader when the text reaches back over the line end', () => {
    // Label at (20, 0), 10 units past d2, while half the text is 44 units.
    const { container } = renderLinear({ ...BASE, p1: [0, 0], p2: [10, 0], pos: [15, 0] })
    stubTextSize(textDiv(container))
    seams.frame?.()

    const leader = span(seams.lines[2])
    expect(leader.visible).toBe(false)
    expect(leader.p1).not.toEqual(leader.p2)
  })
})

describe('gap follows the projected along-line scale', () => {
  // A local-Y line 300 long, offset to sit on local x = 10.
  const TILT_DIM: Dim = { kind: 'dim_linear', p1: [0, 0], p2: [0, 300], normal: [1, 0], value: 300 }

  it('cuts the full rendered text width when the sketch plane is tilted', () => {
    const plane = tiltedPlane(45)
    const { container } = renderLinear(TILT_DIM, plane)
    stubTextSize(textDiv(container))
    seams.frame?.()

    // A 45 degree plane foreshortens the line: one world unit is 0.707 px, so
    // one px along the line is 1.414 world. The old isotropic factor (1 here)
    // cut 96 world where the text covers 136.
    const factor = alongFactor(plane, [10, 0], [10, 300])
    expect(factor).toBeCloseTo(Math.SQRT2, 6)
    const expected = dimensionLineGap([10, 0], [10, 300], [10, 150], (88 + 8) * factor, 8.5)
    expect(expected).toHaveLength(2)

    const first = span(seams.lines[0])
    const second = span(seams.lines[1])
    expect(first.visible).toBe(true)
    expect(second.visible).toBe(true)
    // The endpoint store is a Float32Array, so compare at its precision.
    expect(first.p2[0]).toBeCloseTo(expected[0][1][0], 4)
    expect(first.p2[1]).toBeCloseTo(expected[0][1][1], 4)
    expect(second.p1[0]).toBeCloseTo(expected[1][0][0], 4)
    expect(second.p1[1]).toBeCloseTo(expected[1][0][1], 4)

    // In screen pixels the inside ends are exactly the rendered text block
    // (88 px of digits plus the 8 px padding).
    const innerWorld = Math.hypot(second.p1[0] - first.p2[0], second.p1[1] - first.p2[1])
    expect(innerWorld / factor).toBeCloseTo(96, 3)
  })

  it('hides the middle, keeping the arrows, when the view is nearly edge-on', () => {
    const plane = tiltedPlane(80)
    const { container } = renderLinear(TILT_DIM, plane)
    stubTextSize(textDiv(container))
    seams.frame?.()

    // The line projects to only ~52 px for 300 world units, so the 96 px text
    // covers more than the whole line.
    expect(span(seams.lines[0]).visible).toBe(false)
    expect(span(seams.lines[1]).visible).toBe(false)
    expect(seams.arrowheads).toHaveLength(2)
  })
})

describe('zero-length dimension', () => {
  it('mounts with no Line2 at all for a zero axis distance', () => {
    // point_distance_x with both points coincident: d1 === d2.
    const { container } = renderLinear({ ...BASE, p1: [5, 5], p2: [5, 5], value: 0, dimKind: 'point_distance_x' })
    stubTextSize(textDiv(container))
    seams.frame?.()

    expect(seams.lines).toHaveLength(0)
  })

  it('creates no leader either when the label is dragged off the point', () => {
    const { container } = renderLinear({
      ...BASE, p1: [5, 5], p2: [5, 5], value: 0, dimKind: 'point_distance_x', pos: [10, 0],
    })
    stubTextSize(textDiv(container))
    seams.frame?.()

    // A point has no line direction to lead along.
    expect(seams.lines).toHaveLength(0)
  })
})

describe('dimension types without a line stay upright', () => {
  it('leaves a radius label unrotated', () => {
    const { container } = render(
      <RadiusDimension cid="c1" dim={{ kind: 'dim_radius', p1: [0, 0], p2: [10, 0], value: 10 }} />,
    )

    expect(textDiv(container).style.transform).toBe('')
  })
})
