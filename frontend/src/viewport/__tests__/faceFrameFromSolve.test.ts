import { describe, it, expect, beforeEach } from 'vitest'
import type { BodyResult, FaceData, Mesh3D } from '@/types/cad'
import { faceFrameFromSolve } from '@/viewport/faceFrameFromSolve'
import { findFaceFrame, resetBodyCallbacksForTest } from '@/components/Viewport/idDispatch/bodyDispatchCallbacks'

function faceData(surface: string, normal: [number, number, number] = [0, 0, 1]): FaceData {
  return { centroid: [0, 0, 0], normal, surface_type: surface }
}

// One quad on the z = at plane, so a frame's point names exactly where the
// solve put the face.
function quadMeshAt(z: number, surface = 'flatface'): Mesh3D {
  return {
    vertices: [[0, 0, z], [1, 0, z], [1, 1, z], [0, 1, z]],
    faces: [[0, 1, 2], [0, 2, 3]],
    triangle_to_face: [0, 0],
    face_queries: ['face-q'],
    face_data: [faceData(surface)],
  }
}

function body(createdBy: string | undefined, mesh: Mesh3D): BodyResult {
  return { id: createdBy ?? 'body_x', created_by: createdBy ?? '', modified_by: [], mesh }
}

describe('faceFrameFromSolve', () => {
  beforeEach(() => {
    resetBodyCallbacksForTest()
  })

  it('resolves a planar face straight from the solve mesh', () => {
    const frame = faceFrameFromSolve({ b1: body('ex1', quadMeshAt(4)) }, 'face-q')
    expect(frame).not.toBeNull()
    expect(frame!.normal[0]).toBeCloseTo(0)
    expect(frame!.normal[1]).toBeCloseTo(0)
    expect(Math.abs(frame!.normal[2])).toBeCloseTo(1)
    expect(frame!.center).toEqual([0.5, 0.5, 4])
  })

  it('refuses a curved face even though its triangles are flat', () => {
    expect(faceFrameFromSolve({ b1: body('ex1', quadMeshAt(0, 'cylinderface')) }, 'face-q')).toBeNull()
  })

  it('returns null for a query no body carries', () => {
    expect(faceFrameFromSolve({ b1: body('ex1', quadMeshAt(0)) }, 'gone')).toBeNull()
  })

  it('uses the pickKey to pick the clicked owner of a shared query', () => {
    const bodies = {
      b1: body('ex1', quadMeshAt(0)),
      b2: body('ex2', quadMeshAt(5)),
    }
    expect(faceFrameFromSolve(bodies, 'face-q')?.center[2]).toBe(0)
    expect(faceFrameFromSolve(bodies, 'face-q', 'ex2/b2#face#0')?.center[2]).toBe(5)
  })

  it('does not depend on the hover registry, so a hidden body keeps its frame', () => {
    const bodies = { b1: body('ex1', quadMeshAt(2)) }
    // Hiding a body unregisters it from the hover registry; findFaceFrame then
    // answers null. The solve still has the mesh, and that is what the section
    // and "Normal to" must read.
    expect(findFaceFrame('face-q', undefined)).toBeNull()
    expect(faceFrameFromSolve(bodies, 'face-q')?.center[2]).toBe(2)
  })
})
