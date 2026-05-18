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

vi.mock('../Geometry3D', () => ({
  default: () => <div data-testid="geometry-3d" />,
  __esModule: true,
}))

vi.mock('../Geometry3D/Body3D', () => ({
  default: ({ interactive }: { interactive?: boolean }) => (
    <div data-testid="body-3d" data-interactive={interactive} />
  ),
  __esModule: true,
}))

type PreviewEdgeOverlayProps = {
  items?: unknown[]
  pickItems?: unknown[]
}
const previewEdgeOverlayProps = vi.fn<(p: PreviewEdgeOverlayProps) => void>()
vi.mock('../Geometry3D/PreviewEdgeOverlay', () => ({
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

vi.mock('../CubeGizmo', () => ({
  CubeGizmoCanvas: () => <div data-testid="cube-gizmo" />,
}))

vi.mock('../ContextMenuDialog', () => ({
  default: () => <div data-testid="context-menu" />,
  __esModule: true,
}))

vi.mock('../Viewport/OriginMarker', () => ({
  default: () => <div data-testid="origin-marker" />,
  __esModule: true,
}))

vi.mock('../Viewport/ReferencePlane', () => ({
  default: () => <div data-testid="reference-plane" />,
  __esModule: true,
}))

vi.mock('../Viewport/SceneController', () => ({
  default: () => <div data-testid="scene-controller" />,
  __esModule: true,
}))

vi.mock('../Viewport/EnvLight', () => ({
  default: () => null,
  ENV_INTENSITY: 1.0,
  ENV_MAP_INTENSITY: 1.0,
  __esModule: true,
}))

vi.mock('../Viewport/UserDefinedPlane', () => ({
  default: () => <div data-testid="user-defined-plane" />,
  __esModule: true,
}))

function makeFeature(id: string, kind: string, overrides?: Partial<Feature>): Feature {
  return { id, kind, ...overrides } as Feature
}

function makeBody(): Record<string, BodyResult> {
  return {
    body_ex1: {
      id: 'body_ex1',
      created_by: 'ex1',
      modified_by: [],
      mesh: { vertices: [], normals: [], faces: [], face_data: [], face_queries: [] },
    } as unknown as BodyResult,
  }
}

beforeEach(() => {
  useSketchEditorStore.setState({
    pendingPickField: null,
    closeContextMenu: () => {},
    clearNormalSelection: () => {},
    setHoveredBodyId: () => {},
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

describe('Viewport body interactive flag', () => {
  it('bodyItems are interactive with no active feature', () => {
    usePartEditorStore.setState({ features: [sketch, extrude], bodies: makeBody() })
    const { container } = render(<Viewport />)
    container.querySelectorAll('[data-testid="body-3d"]').forEach(el => {
      expect(el.getAttribute('data-interactive')).toBe('true')
    })
  })

  it('bodyItems are inert (interactive=false) while a sketch is active', () => {
    // User invariant (solver_arch.user.md §Viewport Layers):
    //   "Sketch geometry takes precedence in visual AND clicks."
    // B-rep faces/edges must not intercept clicks while a sketch is being edited.
    usePartEditorStore.setState({
      features: [sketch, extrude],
      bodies: makeBody(),
      activeSketchFeatureId: 'sk1',
    })
    const { container } = render(<Viewport />)
    container.querySelectorAll('[data-testid="body-3d"]').forEach(el => {
      expect(el.getAttribute('data-interactive')).toBe('false')
    })
  })

  it('ghostMode renders pickBodies as normal interactive bodies and shows a preview edge overlay', () => {
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
    // All Body3D items are interactive (no ghost/inert Body3D)
    items.forEach(el => expect(el.getAttribute('data-interactive')).toBe('true'))
    // Preview edge overlay is present
    expect(getByTestId('preview-edge-overlay')).toBeTruthy()
  })

  it('ghostMode passes pickBodyItems to PreviewEdgeOverlay so inherited edges are filtered out', () => {
    // Regression test: without pickItems, the violet edge overlay renders every
    // edge of every body, including those that already existed before the edit
    // (per user invariant: violet shows only the new geometry contributed by
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
