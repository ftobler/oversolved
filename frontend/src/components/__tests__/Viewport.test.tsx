import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render } from '@testing-library/react'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import type { Feature, BodyResult } from '../../types/cad'
import Viewport from '../Viewport'

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children: React.ReactNode }) => <div data-testid="canvas">{children}</div>,
  useFrame: () => {},
  useThree: () => ({ camera: {}, gl: {}, scene: {} }),
}))

vi.mock('@react-three/drei', () => ({
  OrthographicCamera: () => <div data-testid="ortho-camera" />,
  Line: () => <div data-testid="line" />,
  Text: () => <div data-testid="text" />,
}))

vi.mock('../Geometry3D', () => ({
  default: () => <div data-testid="geometry-3d" />,
  __esModule: true,
}))

vi.mock('../Geometry3D/Body3D', () => ({
  default: ({ interactive }: { interactive?: boolean }) => <div data-testid={`body-3d`} data-interactive={interactive} />,
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

vi.mock('../Viewport/CameraLight', () => ({
  default: () => <div data-testid="camera-light" />,
  __esModule: true,
}))

vi.mock('../Viewport/UserDefinedPlane', () => ({
  default: () => <div data-testid="user-defined-plane" />,
  __esModule: true,
}))

function makeFeature(id: string, kind: string, overrides?: Partial<Feature>): Feature {
  return { id, kind, ...overrides } as Feature
}

beforeEach(() => {
  useSketchEditorStore.setState({
    pendingPickField: null,
    closeContextMenu: () => {},
    clearNormalSelection: () => {},
    setHoveredBodyId: () => {},
  })
})

describe('Viewport body interactive flag', () => {
  const sketch: Feature = makeFeature('sk1', 'sketch')
  const extrude: Feature = makeFeature('ex1', 'extrude')

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

  it('bodyItems are interactive with no active feature', () => {
    const { container } = render(
      <Viewport features={[sketch, extrude]} bodies={makeBody()} />
    )
    container.querySelectorAll('[data-testid="body-3d"]').forEach(el => {
      expect(el.getAttribute('data-interactive')).toBe('true')
    })
  })

  it('bodyItems remain interactive while a sketch is active', () => {
    const { container } = render(
      <Viewport features={[sketch, extrude]} bodies={makeBody()} activeFeatureId="sk1" />
    )
    container.querySelectorAll('[data-testid="body-3d"]').forEach(el => {
      expect(el.getAttribute('data-interactive')).toBe('true')
    })
  })
})
