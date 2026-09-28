// "Normal to" and "New Sketch" on a hovered face are only offered for a face the
// kernel classified as flat. The hover path runs dispatcher -> registry ->
// Body3D -> store -> buildContextMenu, and this drives that whole chain with a
// real Body3D so a curved face cannot slip through on a local normal.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { brepFaceAdapter, clearAllHover } from '@/components/Viewport/idDispatch/brepAdapters'
import { findFaceFrame, resetBodyCallbacksForTest } from '@/components/Viewport/idDispatch/bodyDispatchCallbacks'
import { bodyKeyFor } from '@/picking/pickKey'
import { buildContextMenu } from '@/pages/buildContextMenu'
import type { BuildContextMenuCallbacks } from '@/pages/buildContextMenu'
import type { Mesh3D } from '@/types/cad'

vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  useThree: () => ({ camera: {} }),
}))

// Face 0 is a flat cap; face 1 is tagged as a cylinder. Its triangles are flat
// here on purpose, so only the B-rep surface type can tell the two apart.
const mesh: Mesh3D = {
  vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 3, 1, 0, 3, 0, 1, 3]),
  faces: new Uint32Array([0, 1, 2, 3, 4, 5]),
  triangle_to_face: [0, 1],
  face_queries: ['?flatQ', '?cylQ'],
  face_data: [
    { centroid: [0, 0, 0], normal: [0, 0, 1], surface_type: 'flatface' },
    { centroid: [0, 0, 3], normal: [1, 0, 0], surface_type: 'cylinderface' },
  ],
}

const noop = () => {}
const callbacks: BuildContextMenuCallbacks = {
  onRebuild: noop, onRemoveDanglingContent: noop, onToggleVisibility: noop,
  onToggleSuppression: noop, onEnterEditSketch: noop, onExitSketch: noop,
  onDeleteFeature: noop, onRequestRename: noop, onAlignToFace: noop,
  onNormalToPlane: noop, onAlignCameraToSketchPlane: noop, onToggleConstraintTiles: noop,
  onSetPartColorPopover: noop, onExportBody: noop, onNewSketchOnPlane: noop,
  onShowContextMenu: noop,
}

// The menu keeps a fixed board now, so the surface commands are always present
// and only the enabled ones say whether the hover resolved to a sketch surface.
function viewportMenuEnabledLabels(): string[] {
  const s = useSketchEditorStore.getState()
  return buildContextMenu({
    pos: [0, 0],
    targetId: undefined,
    hoveredSelectionId: s.hoveredSelectionId,
    hoveredFaceNormal: s.hoveredFaceNormal,
    hoveredFaceCenter: s.hoveredFaceCenter,
    selectedNormalTarget: null,
    features: [],
    visibleFeatures: new Set(),
    activeSketchFeatureId: undefined,
    showConstraintTiles: false,
    partLabels: {},
    builtInIds: new Set(),
    hasDanglingContent: false,
  }, callbacks).items.filter(i => !i.disabled).map(i => i.label)
}

const bodyKey = bodyKeyFor('ex1', 'body_ex1')

beforeEach(async () => {
  resetBodyCallbacksForTest()
  clearAllHover()
  useSketchEditorStore.setState({ normalSelection: new Set(), selectedPicks: new Map() } as never)
  const { default: Body3D } = await import('@/components/Geometry3D/Body3D')
  render(<Body3D featureId="ex1" bodyId="body_ex1" mesh={mesh} />)
})

afterEach(() => {
  cleanup()
  clearAllHover()
})

describe('Body3D hover feeds Normal to only for flat faces', () => {
  it('a hovered flat face gets New Sketch and Normal to', () => {
    brepFaceAdapter.onHover('?flatQ', `${bodyKey}#face#0`)
    expect(useSketchEditorStore.getState().hoveredFaceNormal).not.toBeNull()
    expect(viewportMenuEnabledLabels()).toEqual(['New Sketch', 'Normal to', 'Rebuild'])
  })

  it('a hovered curved face gets neither, despite a local normal', () => {
    brepFaceAdapter.onHover('?cylQ', `${bodyKey}#face#1`)
    expect(useSketchEditorStore.getState().hoveredFaceNormal).toBeNull()
    const labels = viewportMenuEnabledLabels()
    expect(labels).not.toContain('Normal to')
    expect(labels).not.toContain('New Sketch')
  })

  it('moving from a flat face onto a curved one drops the flat face frame', () => {
    brepFaceAdapter.onHover('?flatQ', `${bodyKey}#face#0`)
    brepFaceAdapter.onHover('?cylQ', `${bodyKey}#face#1`)
    expect(useSketchEditorStore.getState().hoveredFaceNormal).toBeNull()
    expect(viewportMenuEnabledLabels()).not.toContain('Normal to')
  })

  it('the selection path agrees with hover on the same mounted body', () => {
    expect(findFaceFrame('?flatQ', `${bodyKey}#face#0`)).not.toBeNull()
    expect(findFaceFrame('?cylQ', `${bodyKey}#face#1`)).toBeNull()
  })
})
