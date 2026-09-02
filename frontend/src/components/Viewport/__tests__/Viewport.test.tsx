import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import type { Feature, BodyResult } from '@/types/cad'
import Viewport from '@/components/Viewport'

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children: React.ReactNode }) => <div data-testid="canvas">{children}</div>,
  useFrame: () => {},
  useThree: () => ({ camera: {}, gl: {}, scene: {} }),
}))

vi.mock('@react-three/drei', () => ({
  OrthographicCamera: () => <div data-testid="ortho-camera" />,
  Line: () => <div data-testid="line" />,
  Text: () => <div data-testid="text" />,
  Environment: () => null,
}))

vi.mock('../../Geometry3D', () => ({
  default: () => <div data-testid="geometry-3d" />,
  __esModule: true,
}))

vi.mock('../../Geometry3D/Body3D', () => ({
  default: ({ interactive, bodyId, visible, doomed, color, transparency }: {
    interactive?: boolean; bodyId?: string; visible?: boolean
    doomed?: boolean; color?: string; transparency?: number
  }) => (
    <div
      data-testid="body-3d"
      data-interactive={interactive}
      data-body-id={bodyId}
      data-visible={String(visible)}
      data-doomed={String(!!doomed)}
      data-color={String(color)}
      data-transparency={String(transparency)}
    />
  ),
  __esModule: true,
}))

type PreviewEdgeOverlayProps = {
  items?: unknown[]
  pickItems?: unknown[]
}
const previewEdgeOverlayProps = vi.fn<(p: PreviewEdgeOverlayProps) => void>()
vi.mock('../../Geometry3D/PreviewEdgeOverlay', () => ({
  default: (props: PreviewEdgeOverlayProps) => {
    previewEdgeOverlayProps(props)
    return <div
      data-testid="preview-edge-overlay"
      data-has-pick-items={props.pickItems != null ? 'true' : 'false'}
      data-pick-item-count={String(props.pickItems?.length ?? 0)}
    />
  },
  __esModule: true,
}))

vi.mock('../../misc/CubeGizmo', () => ({
  CubeGizmoCanvas: () => <div data-testid="cube-gizmo" />,
}))

vi.mock('../../dialogs/ContextMenuDialog', () => ({
  default: () => <div data-testid="context-menu" />,
  __esModule: true,
}))

vi.mock('../OriginMarker', () => ({
  default: () => <div data-testid="origin-marker" />,
  __esModule: true,
}))

vi.mock('../ReferencePlane', () => ({
  default: () => <div data-testid="reference-plane" />,
  __esModule: true,
}))

vi.mock('../SceneController', () => ({
  default: () => <div data-testid="scene-controller" />,
  __esModule: true,
}))

vi.mock('../EnvLight', () => ({
  default: () => null,
  ENV_INTENSITY: 1.0,
  ENV_MAP_INTENSITY: 1.0,
  __esModule: true,
}))

vi.mock('../UserDefinedPlane', () => ({
  default: () => <div data-testid="user-defined-plane" />,
  __esModule: true,
}))

function makeFeature(id: string, kind: string, overrides?: Partial<Feature>): Feature {
  return { id, kind, ...overrides } as Feature
}

function makeNamedBody(id: string, createdBy: string): BodyResult {
  return {
    id,
    created_by: createdBy,
    modified_by: [],
    mesh: { vertices: [], faces: [], face_data: [], face_queries: [] },
  } as unknown as BodyResult
}

function makeBody(): Record<string, BodyResult> {
  return {
    body_ex1: {
      id: 'body_ex1',
      created_by: 'ex1',
      modified_by: [],
      mesh: { vertices: [], faces: [], face_data: [], face_queries: [] },
    } as unknown as BodyResult,
  }
}

beforeEach(() => {
  useSketchEditorStore.setState({
    closeContextMenu: () => {},
    clearNormalSelection: () => {},
    setHoveredSelectionId: () => {},
    showDebugHit: false,
  })
  usePartEditorStore.setState({
    features: [],
    bodies: {},
    pickBodies: {},
    ghostMode: false,
    rollbackPosition: null,
    visibleFeatures: new Set(),
    visibleBodies: new Set(),
    solveResults: {},
    otherSketches: {},
    partColors: {},
    partStyle: {},
    activeSketchFeatureId: null,
    doc: null,
  })
})

const sketch: Feature = makeFeature('sk1', 'sketch')
const extrude: Feature = makeFeature('ex1', 'extrude')

describe('Viewport body interactivity', () => {
  it('does not force bodies inert when no feature is active', () => {
    usePartEditorStore.setState({ features: [sketch, extrude], bodies: makeBody() })
    const { container } = render(<Viewport />)
    container.querySelectorAll('[data-testid="body-3d"]').forEach(el => {
      // Viewport leaves Body3D's `interactive` default (true) in place.
      expect(el.getAttribute('data-interactive')).not.toBe('false')
    })
  })

  it('keeps bodies interactive while a sketch is being edited so the pick (collision) pass stays live', () => {
    // User invariant: during sketch editing the collision renderpass works
    // normally so the Project tool can pick 3D body geometry. Sketch geometry
    // takes precedence over bodies via ID-buffer layer priority (z-index), not
    // by making bodies inert -- so Body3D must NOT be forced interactive=false.
    usePartEditorStore.setState({
      features: [sketch, extrude],
      bodies: makeBody(),
      activeSketchFeatureId: 'sk1',
    })
    const { container } = render(<Viewport />)
    const items = container.querySelectorAll('[data-testid="body-3d"]')
    expect(items.length).toBeGreaterThan(0)
    items.forEach(el => {
      expect(el.getAttribute('data-interactive')).not.toBe('false')
    })
  })

  it('ghostMode renders pickBodies and shows a preview edge overlay', () => {
    usePartEditorStore.setState({
      features: [sketch, extrude],
      bodies: makeBody(),
      pickBodies: makeBody(),
      ghostMode: true,
      rollbackPosition: 1,
    })
    const { getAllByTestId, getByTestId } = render(<Viewport />)
    // Only pickBodyItems rendered as Body3D, no duplicate for preview
    const items = getAllByTestId('body-3d')
    expect(items.length).toBe(1)
    // Bodies are not forced inert.
    items.forEach(el => expect(el.getAttribute('data-interactive')).not.toBe('false'))
    // Preview edge overlay is present
    expect(getByTestId('preview-edge-overlay')).toBeTruthy()
  })

  it('ghostMode passes pickBodyItems to PreviewEdgeOverlay so inherited edges are filtered out', () => {
    // Regression test: without pickItems, the pink edge overlay renders every
    // edge of every body, including those that already existed before the edit
    // (per user invariant: pink shows only the new geometry contributed by
    // the edited feature).
    previewEdgeOverlayProps.mockClear()
    usePartEditorStore.setState({
      features: [sketch, extrude],
      bodies: makeBody(),
      pickBodies: makeBody(),
      ghostMode: true,
      rollbackPosition: 1,
    })
    const { getByTestId } = render(<Viewport />)
    const overlay = getByTestId('preview-edge-overlay')
    expect(overlay.getAttribute('data-has-pick-items')).toBe('true')
    expect(Number(overlay.getAttribute('data-pick-item-count'))).toBeGreaterThan(0)
    const lastCall = previewEdgeOverlayProps.mock.calls.at(-1)?.[0]
    expect(lastCall?.pickItems).toBeDefined()
    expect(Array.isArray(lastCall?.pickItems)).toBe(true)
  })
})

describe('Viewport delete_body ghost preview', () => {
  const ex2: Feature = makeFeature('ex2', 'extrude')
  const del: Feature = makeFeature('db1', 'delete_body')
  const twoBodies = () => ({
    body_ex1: makeNamedBody('body_ex1', 'ex1'),
    body_ex2: makeNamedBody('body_ex2', 'ex2'),
  })
  const visibleOf = (bodies: Record<string, BodyResult>) => new Set(Object.keys(bodies))

  const ghostAttr = (container: HTMLElement, attr: string) =>
    Object.fromEntries(
      [...container.querySelectorAll('[data-testid="body-3d"]')]
        .map(el => [el.getAttribute('data-body-id'), el.getAttribute(attr)])
    )

  const renderDeleteOfEx2 = () => {
    const preview = { body_ex1: makeNamedBody('body_ex1', 'ex1') }
    usePartEditorStore.setState({
      features: [sketch, extrude, ex2, del],
      bodies: preview,
      pickBodies: twoBodies(),
      visibleBodies: visibleOf(preview),
      ghostMode: true,
      rollbackPosition: 4,
    })
    return render(<Viewport />).container
  }

  it('marks the ghost of the body being deleted instead of hiding it', () => {
    const container = renderDeleteOfEx2()
    expect(ghostAttr(container, 'data-doomed')).toEqual({ body_ex1: 'false', body_ex2: 'true' })
    expect(ghostAttr(container, 'data-visible')).toEqual({ body_ex1: 'true', body_ex2: 'true' })
  })

  it('leaves the survivor its own partColors and partStyle', () => {
    // The removal look must override exactly one body, never the whole layer.
    const preview = { body_ex1: makeNamedBody('body_ex1', 'ex1') }
    usePartEditorStore.setState({
      features: [sketch, extrude, ex2, del],
      bodies: preview,
      pickBodies: twoBodies(),
      visibleBodies: visibleOf(preview),
      ghostMode: true,
      rollbackPosition: 4,
      partColors: { body_ex1: '#123456', body_ex2: '#654321' },
      partStyle: { body_ex1: { transparency: 0.25 } },
    })
    const { container } = render(<Viewport />)
    expect(ghostAttr(container, 'data-color')).toEqual({ body_ex1: '#123456', body_ex2: '#654321' })
    expect(ghostAttr(container, 'data-transparency')).toEqual({ body_ex1: '0.25', body_ex2: '0' })
    // Body3D itself, not the Viewport, turns the mark into the doomed look.
    expect(ghostAttr(container, 'data-doomed')).toEqual({ body_ex1: 'false', body_ex2: 'true' })
  })

  it('does not resurrect a doomed body the user hid', () => {
    const preview = { body_ex1: makeNamedBody('body_ex1', 'ex1') }
    usePartEditorStore.setState({
      features: [sketch, extrude, ex2, del],
      bodies: preview,
      pickBodies: twoBodies(),
      visibleBodies: visibleOf(preview),
      ghostMode: true,
      rollbackPosition: 4,
      partStyle: { body_ex2: { visible: false } },
    })
    const { container } = render(<Viewport />)
    expect(ghostAttr(container, 'data-visible')).toEqual({ body_ex1: 'true', body_ex2: 'false' })
    expect(ghostAttr(container, 'data-doomed')).toEqual({ body_ex1: 'false', body_ex2: 'true' })
  })

  it('marks both ghosts when the delete empties the body store', () => {
    // Regression: the ghost layer falls back to "show everything" once the
    // preview holds no body at all, so the removal cannot ride on visibleBodies
    // and the mark has to carry it.
    usePartEditorStore.setState({
      features: [sketch, extrude, ex2, del],
      bodies: {},
      pickBodies: twoBodies(),
      visibleBodies: undefined,
      ghostMode: true,
      rollbackPosition: 4,
    })
    const { container } = render(<Viewport />)
    expect(ghostAttr(container, 'data-doomed')).toEqual({ body_ex1: 'true', body_ex2: 'true' })
  })
})

describe('Viewport overlay stacking pen', () => {
  it('isolates the viewport root so drei Html overlays cannot outrank dialogs', () => {
    // Regression: every `<Html>` drei portals beside the canvas (constraint
    // tiles, dimension labels) carries a z-index drei interpolates over its
    // default range, up to ~16.8 million. With no stacking context around them
    // they outrank the app's dialog overlays (9999) and paint over an open
    // dialog.
    const { container } = render(<Viewport />)
    const root = container.firstElementChild as HTMLElement
    expect(root.style.isolation).toBe('isolate')
  })
})
