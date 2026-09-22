import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import * as THREE from 'three'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { toolRegistry } from '@/registry/toolRegistry'
import type { Tool } from '@/registry/toolRegistry'
import { takeDrawToolClickConsumed } from '@/components/Viewport/idDispatch/drawToolClickGuard'

/**
 * DrawPlane owns two seams: the window-level hover that projects the cursor onto
 * the sketch plane, and the mesh pointer-down that commits a drawing-tool click.
 * The commit resolves the id buffer at the click pixel rather than trusting the
 * async hover (#274: a lagging hover made edge picks flaky) and fails loud when
 * the ray never meets the plane. Both are interaction contracts, pinned here at
 * the component seam.
 *
 * The projection is mocked to state the world hit directly; the real
 * sanitizePointerEvent maps it through an identity group, so an off-plane z is
 * still exercised through the real guard.
 */

const proj = vi.hoisted(() => ({ point: null as { x: number; y: number; z: number } | null, calls: 0 }))
vi.mock('@/components/Geometry3D/dragMathPlane', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/Geometry3D/dragMathPlane')>()
  return {
    ...actual,
    projectCursorToSketchPlane: () => {
      proj.calls++
      return proj.point
        ? ({ x: proj.point.x, y: proj.point.y, z: proj.point.z } as unknown as THREE.Vector3)
        : null
    },
  }
})

const pick = vi.hoisted(() => ({ hit: null as { entityKey: string } | null, calls: 0 }))
vi.mock('@/components/Viewport/idDispatch/useIdBufferPointerDispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/Viewport/idDispatch/useIdBufferPointerDispatch')>()
  return { ...actual, resolvePickAtEvent: () => { pick.calls++; return pick.hit } }
})

const loud = vi.hoisted(() => ({ messages: [] as string[] }))
vi.mock('@/stores/stateInvariants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/stateInvariants')>()
  return { ...actual, failLoud: (message: string) => { loud.messages.push(message) } }
})

const r3f = vi.hoisted(() => ({ camera: null as unknown, canvas: null as unknown }))
vi.mock('@react-three/fiber', () => ({
  useThree: () => ({ camera: r3f.camera, gl: { domElement: r3f.canvas } }),
}))
vi.mock('@react-three/drei', () => ({ Line: () => null }))
vi.mock('@/components/Geometry3D/VertexDots', () => ({ Dot: () => null }))
vi.mock('@/components/Geometry3D/dimensions', () => ({ DashedLine: () => null }))
vi.mock('@/components/interaction/useAlignmentSnapEffect', () => ({ useAlignmentSnapEffect: () => {} }))

import { DrawPlane } from '@/components/Geometry3D/Drawing'

function makeCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600,
    toJSON() { return {} },
  })
  return c
}

const groupRef = { current: new THREE.Group() }

function move(clientX: number, clientY: number, buttons = 0): void {
  act(() => { window.dispatchEvent(new MouseEvent('pointermove', { clientX, clientY, buttons })) })
}

// A real pointerdown carrying clientX: testing-library's synthetic pointer event
// does not populate clientX under jsdom, and the commit handler reads it.
function clickDrawMesh(el: Element, clientX = 100, clientY = 100): void {
  act(() => { el.dispatchEvent(new MouseEvent('pointerdown', { clientX, clientY, bubbles: true, button: 0 })) })
}

function stubTool(id: string, onPointerDown?: Tool['handlers']['onPointerDown']): Tool {
  return {
    id: id as Tool['id'], label: id, category: 'drawing',
    activate() {}, deactivate() {},
    handlers: onPointerDown ? { onPointerDown } : {},
  }
}

beforeEach(() => {
  toolRegistry.reset()
  takeDrawToolClickConsumed()
  proj.point = null
  proj.calls = 0
  pick.hit = null
  pick.calls = 0
  loud.messages.length = 0
  r3f.camera = new THREE.OrthographicCamera(-10, 10, 10, -10, -100, 100)
  r3f.canvas = makeCanvas()
  useSketchEditorStore.setState({
    activeTool: null, activeFeatureId: 'S1', drawPoints: [], drawHover: null,
    dimensionPicks: [], dimensionCursorWorld: null, hoveredSelectionId: null,
    hoveredVertexId: null, hoveredVertexPosition: null, hoveredSnapKind: null,
    normalSelection: new Set(), isPointerDown: false,
  })
})

describe('DrawPlane hover projection', () => {
  it('stores the projected local point while a drawing tool is armed', () => {
    toolRegistry.register(stubTool('line'))
    useSketchEditorStore.setState({ activeTool: 'line' })
    proj.point = { x: 2, y: 3, z: 0 }
    render(<DrawPlane featureId="S1" activeFeatureId="S1" sketchGroupRef={groupRef} />)

    move(100, 100)

    expect(useSketchEditorStore.getState().drawHover).toEqual([2, 3])
  })

  it('does not write hover from a non-active sketch plane', () => {
    // Every visible sketch mounts a DrawPlane and attaches the window listener.
    // An inactive sketch projects the cursor onto ITS plane, so it must not
    // overwrite the hover the active sketch's plane owns.
    toolRegistry.register(stubTool('line'))
    useSketchEditorStore.setState({ activeTool: 'line' })
    proj.point = { x: 2, y: 3, z: 0 }
    render(<DrawPlane featureId="S1" activeFeatureId="S2" sketchGroupRef={groupRef} />)

    move(100, 100)

    expect(useSketchEditorStore.getState().drawHover).toBeNull()
  })

  it('clears the hover while a non-primary button is held', () => {
    toolRegistry.register(stubTool('line'))
    useSketchEditorStore.setState({ activeTool: 'line', drawHover: [9, 9] })
    render(<DrawPlane featureId="S1" activeFeatureId="S1" sketchGroupRef={groupRef} />)

    move(100, 100, 2)

    expect(useSketchEditorStore.getState().drawHover).toBeNull()
  })

  it('clears the hover and the dimension cursor when the ray misses the plane', () => {
    toolRegistry.register(stubTool('dimension'))
    useSketchEditorStore.setState({
      activeTool: 'dimension', drawHover: [9, 9],
      dimensionPicks: [{ kind: 'vertex' } as never], dimensionCursorWorld: [1, 1],
    })
    proj.point = null
    render(<DrawPlane featureId="S1" activeFeatureId="S1" sketchGroupRef={groupRef} />)

    move(100, 100)

    const s = useSketchEditorStore.getState()
    expect(s.drawHover).toBeNull()
    expect(s.dimensionCursorWorld).toBeNull()
  })

  it('mirrors the cursor for an open dimension placement gesture', () => {
    toolRegistry.register(stubTool('dimension'))
    useSketchEditorStore.setState({
      activeTool: 'dimension', dimensionPicks: [{ kind: 'vertex' } as never],
    })
    proj.point = { x: 7, y: 8, z: 0 }
    render(<DrawPlane featureId="S1" activeFeatureId="S1" sketchGroupRef={groupRef} />)

    move(100, 100)

    expect(useSketchEditorStore.getState().dimensionCursorWorld).toEqual([7, 8])
  })
})

describe('DrawPlane commit click', () => {
  it('resolves the project pick at the click pixel instead of the stale hover', () => {
    const onPointerDown = vi.fn()
    toolRegistry.register(stubTool('project', onPointerDown))
    useSketchEditorStore.setState({ activeTool: 'project', hoveredSelectionId: 'stale-hover' })
    pick.hit = { entityKey: 'edge@fresh' }
    proj.point = { x: 4, y: 5, z: 0 }
    const { container } = render(
      <DrawPlane featureId="S1" activeFeatureId="S1" sketchGroupRef={groupRef} />,
    )

    clickDrawMesh(container.querySelector('mesh')!)

    expect(pick.calls).toBe(1)
    expect(onPointerDown).toHaveBeenCalledTimes(1)
    const context = onPointerDown.mock.calls[0][2]
    expect(context.hoveredSelectionId).toBe('edge@fresh')
    expect(context.drawPoints).toEqual([])
    // Every drawing tool claims the click so the canvas does not also toggle
    // selection on the entity the gesture just acted on.
    expect(takeDrawToolClickConsumed()).toBe(true)
  })

  it('passes the store hover for a non-project drawing tool without resolving a pick', () => {
    const onPointerDown = vi.fn()
    toolRegistry.register(stubTool('line', onPointerDown))
    useSketchEditorStore.setState({ activeTool: 'line', hoveredSelectionId: 'entity:S1:L1' })
    proj.point = { x: 4, y: 5, z: 0 }
    const { container } = render(
      <DrawPlane featureId="S1" activeFeatureId="S1" sketchGroupRef={groupRef} />,
    )

    clickDrawMesh(container.querySelector('mesh')!)

    expect(pick.calls).toBe(0)
    expect(onPointerDown.mock.calls[0][2].hoveredSelectionId).toBe('entity:S1:L1')
  })

  it('fails loud and drops the click when the ray misses the plane', () => {
    const onPointerDown = vi.fn()
    toolRegistry.register(stubTool('line', onPointerDown))
    useSketchEditorStore.setState({ activeTool: 'line' })
    proj.point = null
    const { container } = render(
      <DrawPlane featureId="S1" activeFeatureId="S1" sketchGroupRef={groupRef} />,
    )

    clickDrawMesh(container.querySelector('mesh')!)

    expect(onPointerDown).not.toHaveBeenCalled()
    expect(takeDrawToolClickConsumed()).toBe(false)
    expect(loud.messages).toEqual([
      expect.stringContaining('cursor ray does not meet the sketch plane'),
    ])
  })

  it('fails loud and drops the click when the hit is off the sketch plane', () => {
    const onPointerDown = vi.fn()
    toolRegistry.register(stubTool('line', onPointerDown))
    useSketchEditorStore.setState({ activeTool: 'line' })
    proj.point = { x: 4, y: 5, z: 5 }  // sanitize rejects |z| > 1
    const { container } = render(
      <DrawPlane featureId="S1" activeFeatureId="S1" sketchGroupRef={groupRef} />,
    )

    clickDrawMesh(container.querySelector('mesh')!)

    expect(onPointerDown).not.toHaveBeenCalled()
    expect(loud.messages).toEqual([
      expect.stringContaining('did not sanitize to a sketch point'),
    ])
  })

  it('renders no draw plane for a non-active sketch', () => {
    toolRegistry.register(stubTool('line'))
    useSketchEditorStore.setState({ activeTool: 'line' })
    const { container } = render(
      <DrawPlane featureId="S1" activeFeatureId="S2" sketchGroupRef={groupRef} />,
    )
    expect(container.querySelector('mesh')).toBeNull()
  })
})
