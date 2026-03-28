import { describe, it, expect, beforeEach } from 'vitest'
import { surfaceSelectionId, planeLabel } from '../Geometry3D/utils'
import { buildSurfaceShapes } from '../Geometry3D/Surfaces'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'
import type { Topology } from '../../types/cad'

// 3a: surfaceSelectionId helper
describe('surfaceSelectionId', () => {
  it('formats correctly', () => {
    expect(surfaceSelectionId('sketch1', '?3;@sketch1abc')).toBe('face:sketch1:?3;@sketch1abc')
  })
})

// 3b: store toggleSelect accepts face:-prefixed IDs
describe('store toggleSelect with face:-prefixed IDs', () => {
  beforeEach(() => {
    useSketchEditorStore.getState().clearSelection()
  })

  it('adds face:-prefixed ID to selection', () => {
    useSketchEditorStore.getState().toggleSelect('face:sketch1:?3;@sketch1abc')
    expect(useSketchEditorStore.getState().selection.has('face:sketch1:?3;@sketch1abc')).toBe(true)
  })

  it('removes face:-prefixed ID from selection on second call', () => {
    useSketchEditorStore.getState().toggleSelect('face:sketch1:?3;@sketch1abc')
    useSketchEditorStore.getState().toggleSelect('face:sketch1:?3;@sketch1abc')
    expect(useSketchEditorStore.getState().selection.has('face:sketch1:?3;@sketch1abc')).toBe(false)
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

// 3c: buildSurfaceShapes
describe('buildSurfaceShapes', () => {
  it('returns one shape for a triangle surface', () => {
    const topology: Topology = {
      vertices: {},
      intersection_points: {},
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
    const topology: Topology = { vertices: {}, intersection_points: {}, surfaces: [] }
    expect(buildSurfaceShapes(topology)).toHaveLength(0)
  })
})

// 3f: surfaces are not draggable (checklist)
// SurfaceMesh does not attach onPointerDown — verified by code review.
// There is no drag initiation in Surfaces.tsx; setDrag is never called from surface meshes.
