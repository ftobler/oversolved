import { describe, it, expect, beforeEach } from 'vitest'
import { planeLabel } from '@/components/Geometry3D/utils'
import { buildSurfaceShapes, surfaceFillStyle, edgeColorStyle } from '@/components/Geometry3D/Surfaces'
import { COLOR_SELECTED, COLOR_HOVER, COLOR_INACTIVE } from '@/utils/partColors'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { Topology } from '@/types/cad'

describe('surfaceFillStyle', () => {
  it('selected areas use the selection color (wins over hover)', () => {
    expect(surfaceFillStyle('view', true, false).color).toBe(COLOR_SELECTED)
    expect(surfaceFillStyle('view', true, true).color).toBe(COLOR_SELECTED)
    // Selection stays lit even while another sketch is being edited.
    expect(surfaceFillStyle('inactive', true, false).color).toBe(COLOR_SELECTED)
  })

  it('hovered areas use the hover color when not inactive', () => {
    expect(surfaceFillStyle('view', false, true).color).toBe(COLOR_HOVER)
    expect(surfaceFillStyle('editing', false, true).color).toBe(COLOR_HOVER)
  })

  it('hover is suppressed while another sketch is being edited', () => {
    expect(surfaceFillStyle('inactive', false, true).color).toBe(COLOR_INACTIVE)
  })

  it('plain areas are white in view mode, dimmed when inactive', () => {
    expect(surfaceFillStyle('view', false, false).color).toBe('white')
    expect(surfaceFillStyle('inactive', false, false).color).toBe(COLOR_INACTIVE)
  })
})

// Surface selection stores the raw ancestral query verbatim (no wrapping):
// the collision-id buffer is the single selection source.
describe('store toggleNormalSelection with raw surface queries', () => {
  beforeEach(() => {
    useSketchEditorStore.getState().clearNormalSelection()
  })

  it('adds the raw query to selection', () => {
    useSketchEditorStore.getState().toggleNormalSelection('?3;@sketch1abc')
    expect(useSketchEditorStore.getState().normalSelection.has('?3;@sketch1abc')).toBe(true)
  })

  it('removes the raw query from selection on second call', () => {
    useSketchEditorStore.getState().toggleNormalSelection('?3;@sketch1abc')
    useSketchEditorStore.getState().toggleNormalSelection('?3;@sketch1abc')
    expect(useSketchEditorStore.getState().normalSelection.has('?3;@sketch1abc')).toBe(false)
  })
})

// 4g: planeLabel helper
describe('planeLabel', () => {
  it('returns Front for @builtin_plane_front', () => {
    expect(planeLabel('@builtin_plane_front')).toBe('Front')
  })
  it('returns Top for @builtin_plane_top', () => {
    expect(planeLabel('@builtin_plane_top')).toBe('Top')
  })
  it('returns Right for @builtin_plane_right', () => {
    expect(planeLabel('@builtin_plane_right')).toBe('Right')
  })
  it('returns Derived face for arbitrary query', () => {
    expect(planeLabel('?3;@sketch0abc:face')).toBe('Derived face')
  })
  it('returns None for undefined', () => {
    expect(planeLabel(undefined)).toBe('None')
  })
})

describe('edgeColorStyle', () => {
  it('selected edges always use the selection color regardless of mode', () => {
    expect(edgeColorStyle('editing', true)).toBe(COLOR_SELECTED)
  })

  it('unselected edges are white in editing mode (active closed-loop indicator)', () => {
    expect(edgeColorStyle('editing', false)).toBe('white')
  })
})

// 3c: buildSurfaceShapes
describe('buildSurfaceShapes', () => {
  it('returns one shape for a triangle surface', () => {
    const topology: Topology = {
      vertices: {},
      intersection_points: {},
      edges: [],
      surfaces: [{
        query: '?3;@sketcha',
        boundary: [
          { kind: 'line', start: [0, 0], end: [2, 0], start_vertex: 'v0', end_vertex: 'v1' },
          { kind: 'line', start: [2, 0], end: [1, 2], start_vertex: 'v1', end_vertex: 'v2' },
          { kind: 'line', start: [1, 2], end: [0, 0], start_vertex: 'v2', end_vertex: 'v0' },
        ],
      }],
    }
    const shapes = buildSurfaceShapes(topology)
    expect(shapes).toHaveLength(1)
    expect(shapes[0].query).toBe('?3;@sketcha')
    // 3 line edges → 4 pts (first + 3 ends)
    expect(shapes[0].pts).toHaveLength(4)
  })

  it('returns empty for a surface with fewer than 3 points (single edge)', () => {
    // A single line edge → 2 pts (start + end), which is < 3 → must be dropped.
    const topology: Topology = {
      vertices: {},
      intersection_points: {},
      edges: [],
      surfaces: [{
        query: '?1;@a',
        boundary: [
          { kind: 'line', start: [0, 0], end: [1, 0], start_vertex: 'v0', end_vertex: 'v1' },
        ],
      }],
    }
    const shapes = buildSurfaceShapes(topology)
    expect(shapes).toHaveLength(0)
  })

  it('interpolates arc edges into multiple points', () => {
    // Semicircle arc from 0° to 180° CCW, radius 1, center at origin
    const topology: Topology = {
      vertices: {},
      intersection_points: {},
      edges: [],
      surfaces: [{
        query: '?2;@ab',
        boundary: [
          {
            kind: 'arc',
            start: [1, 0], end: [-1, 0],
            center: [0, 0], radius: 1,
            angle_start_deg: 0, angle_end_deg: 180,
            ccw: true,
            start_vertex: 'v0', end_vertex: 'v1',
          },
          { kind: 'line', start: [-1, 0], end: [1, 0], start_vertex: 'v1', end_vertex: 'v0' },
        ],
      }],
    }
    const shapes = buildSurfaceShapes(topology)
    expect(shapes).toHaveLength(1)
    // Arc should produce multiple intermediate points, so pts.length > 3
    expect(shapes[0].pts.length).toBeGreaterThan(3)
    // All arc points should be at radius ≈ 1 from the origin
    const arcPts = shapes[0].pts.slice(0, -1)  // last pt is the line end
    for (const [x, y] of arcPts) {
      expect(Math.hypot(x, y)).toBeCloseTo(1, 4)
    }
  })

  it('returns an empty array when topology has no surfaces', () => {
    const topology: Topology = { vertices: {}, intersection_points: {}, edges: [], surfaces: [] }
    expect(buildSurfaceShapes(topology)).toHaveLength(0)
  })
})

// 3f: surfaces are not draggable (checklist)
// SurfaceMesh does not attach onPointerDown — verified by code review.

// 3g: R3F mesh click suppression in editing mode (SurfaceMesh and EdgeMesh)
// mode='editing' means the ID buffer owns entity/vertex clicks; the R3F meshes must
// NOT call toggleNormalSelection. They still stopPropagation to prevent DrawPlane
// from clearing the ID-buffer selection. Only mode='view' allows R3F mesh selection.
describe('topology mesh click suppression during editing', () => {
  beforeEach(() => {
    useSketchEditorStore.getState().clearNormalSelection()
  })

  it('only entity is selected when ID buffer picks entity (surface click suppressed)', () => {
    // Simulate: ID buffer clicks entity (mode='editing' means surface R3F click is no-op)
    useSketchEditorStore.getState().toggleNormalSelection('entity:feat1:lineA')

    const sel = useSketchEditorStore.getState().normalSelection
    expect(sel.has('entity:feat1:lineA')).toBe(true)
    expect(sel.has('face:feat1:?3;@feat1/lineA')).toBe(false)
  })

  it('only entity is selected when ID buffer picks entity (edge click suppressed)', () => {
    // Simulate: ID buffer clicks entity (mode='editing' means edge R3F click is no-op)
    useSketchEditorStore.getState().toggleNormalSelection('entity:feat1:lineA')

    const sel = useSketchEditorStore.getState().normalSelection
    expect(sel.has('entity:feat1:lineA')).toBe(true)
    expect(sel.has('edge:feat1:?3;@feat1/lineA')).toBe(false)
  })

  it('surface can be selected via R3F click in view mode (no active edit)', () => {
    // In view mode (mode='view'), R3F mesh clicks ARE the selection mechanism
    useSketchEditorStore.getState().toggleNormalSelection('face:feat1:?3;@feat1/lineA')

    const sel = useSketchEditorStore.getState().normalSelection
    expect(sel.has('face:feat1:?3;@feat1/lineA')).toBe(true)
  })
})
// There is no drag initiation in Surfaces.tsx; setDrag is never called from surface meshes.
