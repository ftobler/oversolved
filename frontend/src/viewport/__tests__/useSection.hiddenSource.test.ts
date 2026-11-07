// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'
import type { BodyResult, FaceData, Mesh3D } from '@/types/cad'
import { DEFAULT_PART_EDITOR_DATA, usePartEditorStore } from '@/stores/partEditorStore'
import { DEFAULT_SECTION_STATE, useSectionStore } from '@/stores/sectionStore'
import { useSectionClip, useSectionFrame } from '@/viewport/useSection'
import { resetSectionClippingForTest } from '@/viewport/sectionClipping'

function faceData(): FaceData {
  return { centroid: [0, 0, 0], normal: [0, 0, 1], surface_type: 'flatface' }
}

function quadMeshAt(z: number): Mesh3D {
  return {
    vertices: [[0, 0, z], [1, 0, z], [1, 1, z], [0, 1, z]],
    faces: [[0, 1, 2], [0, 2, 3]],
    triangle_to_face: [0, 0],
    face_queries: ['face-q'],
    face_data: [faceData()],
  }
}

function bodyAt(z: number): BodyResult {
  return { id: 'body_ex1', created_by: 'ex1', modified_by: [], mesh: quadMeshAt(z) }
}

function setBodies(z: number): void {
  usePartEditorStore.setState({ bodies: { body_ex1: bodyAt(z) } })
}

describe('section on a solve-derived face source', () => {
  beforeEach(() => {
    resetSectionClippingForTest()
    useSectionStore.setState({
      ...DEFAULT_SECTION_STATE,
      enabled: true,
      plane: { kind: 'query', query: 'face-q', pickKey: 'ex1/body_ex1#face#0' },
    })
    usePartEditorStore.setState({ ...DEFAULT_PART_EDITOR_DATA })
    setBodies(0)
  })

  afterEach(() => {
    cleanup()
    useSectionStore.setState({ ...DEFAULT_SECTION_STATE })
    usePartEditorStore.setState({ ...DEFAULT_PART_EDITOR_DATA })
    resetSectionClippingForTest()
  })

  it('stays on when the source body is hidden from the hover registry', () => {
    // Hiding a body leaves it in the solve but unregisters its Body3D hover
    // callbacks. The old frame lookup read that registry and turned the section
    // off with "source gone"; the solve-derived frame does not.
    const { result } = renderHook(() => useSectionClip())
    expect(result.current.active).toBe(true)
    expect(result.current.frame?.point[2]).toBe(0)
  })

  it('follows the face when a re-solve moves it', () => {
    const { result, rerender } = renderHook(() => useSectionFrame())
    expect(result.current?.point[2]).toBe(0)

    act(() => { setBodies(3) })
    rerender()

    expect(result.current?.point[2]).toBe(3)
    expect(result.current?.normal[2]).toBeCloseTo(1)
  })
})
