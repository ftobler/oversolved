import { describe, it, expect } from 'vitest'
import type { Mesh3D, FaceData } from '@/types/cad'
import { planarFaceFrame } from '@/components/Geometry3D/bodyGeometry'

// "Normal to" on a face reads its frame through planarFaceFrame from both the
// hover path (Body3D) and the selection path (bodyDispatchCallbacks), so the
// two can never disagree about which faces have a normal to align to.

// Face 0: unit square in z=0. Face 1: unit square in x=5.
function twoFaceMesh(face_data?: FaceData[]): Mesh3D {
  return {
    vertices: [
      [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
      [5, 0, 0], [5, 1, 0], [5, 1, 1], [5, 0, 1],
    ],
    faces: [[0, 1, 2], [0, 2, 3], [4, 5, 6], [4, 6, 7]],
    triangle_to_face: [0, 0, 1, 1],
    face_queries: ['q0', 'q1'],
    face_data,
  }
}

function faceData(surface_type: string): FaceData {
  return { centroid: [0, 0, 0], normal: [0, 0, 1], surface_type }
}

describe('planarFaceFrame', () => {
  it('returns the centroid and a normal perpendicular to a flat face', () => {
    const frame = planarFaceFrame(twoFaceMesh([faceData('flatface'), faceData('flatface')]), 0)
    expect(frame).not.toBeNull()
    expect(frame!.center).toEqual([0.5, 0.5, 0])
    expect(frame!.normal[0]).toBeCloseTo(0)
    expect(frame!.normal[1]).toBeCloseTo(0)
    expect(Math.abs(frame!.normal[2])).toBeGreaterThan(0)
  })

  it('resolves the face named by index, not the first one', () => {
    const frame = planarFaceFrame(twoFaceMesh([faceData('flatface'), faceData('flatface')]), 1)
    expect(frame!.center).toEqual([5, 0.5, 0.5])
    expect(Math.abs(frame!.normal[0])).toBeGreaterThan(0)
    expect(frame!.normal[1]).toBeCloseTo(0)
    expect(frame!.normal[2]).toBeCloseTo(0)
  })

  it.each(['cylinderface', 'coneface', 'sphereface', 'torusface', 'face'])(
    'has no frame for a %s even though its triangles here are flat',
    (surface) => {
      // The fixture's triangles are coplanar on purpose: planarity comes from
      // the B-rep surface type, never from sampling the tessellation.
      const mesh = twoFaceMesh([faceData('flatface'), faceData(surface)])
      expect(planarFaceFrame(mesh, 1)).toBeNull()
      expect(planarFaceFrame(mesh, 0)).not.toBeNull()
    },
  )

  it('has no frame for a face without surface metadata', () => {
    expect(planarFaceFrame(twoFaceMesh(), 0)).toBeNull()
  })

  it('has no frame for a face without triangles', () => {
    const data = Array.from({ length: 8 }, () => faceData('flatface'))
    expect(planarFaceFrame(twoFaceMesh(data), 7)).toBeNull()
  })
})
