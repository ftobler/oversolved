// A body puts the thread attributes on its surface geometry only when one of
// its faces is a tapped bore, and a body without one keeps the plain geometry
// (no attribute, no extra program) whatever threads the rest of the part has.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as THREE from 'three'
import { render } from '@testing-library/react'
import type { FaceData, Mesh3D } from '@/types/cad'
import { useViewOptionsStore } from '@/stores/viewOptionsStore'
import { constructionUuidToken, makeAncestryQuery } from '@/kernel/queryWire'
import type { ThreadSiteIndex } from '@/components/Geometry3D/threadShading'

vi.mock('@react-three/fiber', () => ({
  useFrame: vi.fn(),
  useThree: () => ({ camera: {} }),
}))

const { surfaces } = vi.hoisted(() => ({ surfaces: [] as THREE.BufferGeometry[] }))

vi.mock('@/components/Geometry3D/bodyGeometry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/Geometry3D/bodyGeometry')>()
  return {
    ...actual,
    buildBodySurfaceGeometry: (mesh: Mesh3D) => {
      const geometry = actual.buildBodySurfaceGeometry(mesh)
      surfaces.push(geometry)
      return geometry
    },
  }
})

const cylinder: FaceData = { centroid: [2.5, 0, 8.5], normal: [1, 0, 0], surface_type: 'cylinderface' }
const plane: FaceData = { centroid: [5, 5, 10], normal: [0, 0, 1], surface_type: 'flatface' }
const query = (uuid: string) => makeAncestryQuery([constructionUuidToken(uuid), '@sk/p1'])

const mesh = (boreUuid: string): Mesh3D => ({
  vertices: [[2.5, -0.5, 10], [2.5, 0.5, 10], [2.5, 0, 7], [5, 5, 10], [6, 5, 10], [5, 6, 10]],
  faces: [[0, 1, 2], [3, 4, 5]],
  triangle_to_face: [0, 1],
  face_data: [cylinder, plane],
  face_queries: [query(boreUuid), query('u_top')],
})

const sites: ThreadSiteIndex = new Map([['u_bore', { center: [0, 0, 10], axis: [0, 0, -1], length: 6, pitch: 1 }]])

beforeEach(() => {
  surfaces.length = 0
  useViewOptionsStore.setState({ shading: true, edges: true, zebra: false, curvature: false, curvature_range: null, curvatureAutoRange: null })
})

async function renderBody(m: Mesh3D, threadSites: ThreadSiteIndex | null) {
  const { default: Body3D } = await import('@/components/Geometry3D/Body3D')
  return render(<Body3D featureId="ex1" bodyId="body_ex1" mesh={m} threadSites={threadSites} />)
}

describe('Body3D thread shading', () => {
  it('puts both thread attributes on a body with a tapped bore', async () => {
    await renderBody(mesh('u_bore'), sites)
    const surface = surfaces.at(-1)!
    // Indexed attributes, split per triangle by toNonIndexed like the normals:
    // two triangles, six vertices.
    expect((surface.getAttribute('aThreadCoord') as THREE.BufferAttribute | undefined)?.itemSize).toBe(4)
    expect((surface.getAttribute('aThreadAxis') as THREE.BufferAttribute | undefined)?.itemSize).toBe(3)
  })

  it('leaves a body without a tapped face plain', async () => {
    await renderBody(mesh('u_elsewhere'), sites)
    expect(surfaces.at(-1)!.getAttribute('aThreadCoord')).toBeUndefined()
  })

  it('leaves every body plain in a part with no threads', async () => {
    await renderBody(mesh('u_bore'), null)
    expect(surfaces.at(-1)!.getAttribute('aThreadCoord')).toBeUndefined()
  })
})
