import { describe, it, expect, beforeEach } from 'vitest'
import { surfaceSelectionId, planeLabel } from '../Geometry3D/utils'
import { useSketchEditorStore } from '../../stores/sketchEditorStore'

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

// 3f: surfaces are not draggable (checklist)
// SurfaceMesh does not attach onPointerDown — verified by code review.
// There is no drag initiation in Surfaces.tsx; setDrag is never called from surface meshes.
