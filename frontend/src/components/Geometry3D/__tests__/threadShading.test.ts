// The cosmetic thread's shading data, without a canvas: which faces a body
// shades (by the bore uuid the hole minted, never by geometry), and the
// per-vertex frame the thread program reads.
import { describe, it, expect } from 'vitest'
import type { FaceData, Mesh3D, SketchData } from '@/types/cad'
import { constructionUuidToken, makeAncestryQuery } from '@/kernel/queryWire'
import {
  buildThreadAttributes, collectThreadSites, tappedFaces, threadSitesFromKey, threadSitesKey, type ThreadSiteIndex,
} from '../threadShading'

const solved = { solved: true } as unknown as SketchData
const holeResult = (sites: unknown[], pitch = 1): SketchData =>
  ({ ...solved, thread: { designation: 'M6x1', nominal: 6, pitch, sites } }) as unknown as SketchData
const boreSite = (uuid: string | string[], over: Record<string, unknown> = {}) => ({
  center: [0, 0, 10], axis: [0, 0, -1], radius: 2.5, length: 6,
  bore_uuids: Array.isArray(uuid) ? uuid : [uuid], ...over,
})

/** A face query naming one construction uuid plus the drill entity, the shape
 *  the kernel's face registration emits. */
const faceQuery = (uuid: string) => makeAncestryQuery([constructionUuidToken(uuid), '@sk/p1'])

const cylinder: FaceData = { centroid: [0, 0, 7], normal: [1, 0, 0], surface_type: 'cylinderface' }
const plane: FaceData = { centroid: [0, 0, 10], normal: [0, 0, 1], surface_type: 'flatface' }

describe('collectThreadSites', () => {
  it('indexes every tapped bore of every hole by its uuid', () => {
    const sites = collectThreadSites(
      [{ id: 'h1', kind: 'hole' }, { id: 'h2', kind: 'hole' }, { id: 'e1', kind: 'extrude' }],
      { h1: holeResult([boreSite('u_a'), boreSite('u_b')]), h2: holeResult([boreSite('u_c')]), e1: solved },
      'mm',
    )
    expect([...sites!.keys()]).toEqual(['u_a', 'u_b', 'u_c'])
    expect(sites!.get('u_a')).toMatchObject({ length: 6, pitch: 1 })
  })

  it('indexes every piece of a split bore as the one site', () => {
    const sites = collectThreadSites([{ id: 'h1', kind: 'hole' }], { h1: holeResult([boreSite(['u_p0', 'u_p1'])]) }, 'mm')
    expect(sites!.get('u_p0')).toBe(sites!.get('u_p1'))
  })

  it('round-trips through its content key, so equal threads keep one identity downstream', () => {
    const results = { h1: holeResult([boreSite(['u_p0', 'u_p1']), boreSite('u_b')]) }
    const a = threadSitesKey(collectThreadSites([{ id: 'h1', kind: 'hole' }], results, 'mm'))
    // A second solve hands a new result object with the same content.
    const b = threadSitesKey(collectThreadSites([{ id: 'h1', kind: 'hole' }], structuredClone(results), 'mm'))
    expect(b).toBe(a)
    expect([...threadSitesFromKey(a)!.keys()]).toEqual(['u_p0', 'u_p1', 'u_b'])
    expect(threadSitesKey(null)).toBe('')
    expect(threadSitesFromKey('')).toBeNull()
  })

  it('scales the millimetre pitch to an inch document', () => {
    const sites = collectThreadSites([{ id: 'h1', kind: 'hole' }], { h1: holeResult([boreSite('u_a')], 1.27) }, 'inch')
    expect(sites!.get('u_a')!.pitch).toBeCloseTo(0.05, 12)
  })

  it('is null with no threads, for a hidden hole, and for a payload without sites', () => {
    expect(collectThreadSites([{ id: 'h1', kind: 'hole' }], { h1: solved }, 'mm')).toBeNull()
    // The viewport filters hidden and rolled-back features out before the call.
    expect(collectThreadSites([], { h1: holeResult([boreSite('u_a')]) }, 'mm')).toBeNull()
    // A result cached by an older build carried `helices`, not `sites`.
    const legacy = { ...solved, thread: { designation: 'M6x1', nominal: 6, pitch: 1, helices: [] } } as unknown as SketchData
    expect(collectThreadSites([{ id: 'h1', kind: 'hole' }], { h1: legacy }, 'mm')).toBeNull()
    expect(collectThreadSites([{ id: 'h1', kind: 'hole' }], undefined, 'mm')).toBeNull()
  })
})

/** A mesh of named faces with no geometry: tappedFaces reads metadata only. */
const faceMesh = (faces: Array<{ data: FaceData; query: string }>): Mesh3D => ({
  vertices: [], faces: [],
  face_data: faces.map(f => f.data),
  face_queries: faces.map(f => f.query),
})

describe('tappedFaces', () => {
  const sites: ThreadSiteIndex = new Map([['u_bore', { center: [0, 0, 10], axis: [0, 0, -1], length: 6, pitch: 1 }]])

  it('shades the cylinder carrying the bore uuid and nothing that only looks like it', () => {
    const perFace = tappedFaces(faceMesh([
      { data: cylinder, query: faceQuery('u_bore') },
      // Same radius, same axis, a different feature's face: not threaded.
      { data: cylinder, query: faceQuery('u_other') },
      { data: plane, query: faceQuery('u_floor') },
    ]), sites)
    expect(perFace!.map(s => s !== null)).toEqual([true, false, false])
  })

  it('shades both pieces of a bore that crossed a gap, each under its own split uuid', () => {
    const shared = sites.get('u_bore')!
    const split: ThreadSiteIndex = new Map([['u_piece0', shared], ['u_piece1', shared]])
    const perFace = tappedFaces(faceMesh([
      { data: cylinder, query: faceQuery('u_piece0') },
      { data: cylinder, query: faceQuery('u_piece1') },
    ]), split)
    expect(perFace!.every(s => s === shared)).toBe(true)
  })

  it('ignores a non-cylinder face even when it carries the uuid', () => {
    expect(tappedFaces(faceMesh([{ data: plane, query: faceQuery('u_bore') }]), sites)).toBeNull()
  })

  it('degrades a malformed or unnamed query to plain', () => {
    expect(tappedFaces(faceMesh([
      { data: cylinder, query: '?zz;broken' },
      { data: cylinder, query: '@body_1/face3' },
    ]), sites)).toBeNull()
    expect(tappedFaces(faceMesh([{ data: cylinder, query: faceQuery('u_bore') }]), null)).toBeNull()
  })
})

describe('buildThreadAttributes', () => {
  // Bore of radius 2.5 down the -Z axis from z=10, tapped 6 deep at pitch 1.
  const sites: ThreadSiteIndex = new Map([['u_bore', { center: [0, 0, 10], axis: [0, 0, -1], length: 6, pitch: 1 }]])
  // Face 0: one bore triangle straddling the +X direction (where a seam would
  // sit), face 1: one triangle of the top plane.
  const mesh: Mesh3D = {
    vertices: [
      [2.5, -0.5, 10], [2.5, 0.5, 10], [2.5, 0, 7],
      [5, 5, 10], [6, 5, 10], [5, 6, 10],
    ],
    faces: [[0, 1, 2], [3, 4, 5]],
    triangle_to_face: [0, 1],
    face_data: [cylinder, plane],
    face_queries: [faceQuery('u_bore'), faceQuery('u_top')],
  }

  it('writes the axial run in pitches and the run length on the bore vertices', () => {
    const attrs = buildThreadAttributes(mesh, sites)!
    // z=10 is the run start, z=7 is three pitches down the -Z axis.
    expect(attrs.coord[0 * 4 + 2]).toBeCloseTo(0, 9)
    expect(attrs.coord[2 * 4 + 2]).toBeCloseTo(3, 9)
    for (const v of [0, 1, 2]) {
      expect(attrs.coord[v * 4 + 3]).toBe(6)
      expect([...attrs.axis.slice(v * 3, v * 3 + 3)]).toEqual([0, 0, -1])
    }
  })

  it('puts (u, v) on the bore circle so the program can take the angle per fragment', () => {
    const attrs = buildThreadAttributes(mesh, sites)!
    for (const v of [0, 1, 2]) {
      const [x, y] = (mesh.vertices as number[][])[v]
      expect(Math.hypot(attrs.coord[v * 4], attrs.coord[v * 4 + 1])).toBeCloseTo(Math.hypot(x, y), 6)
    }
  })

  it('builds a right-handed frame: u x v is the bore axis', () => {
    // The vertex on +X and a second bore vertex on +Y: the angle from the
    // first to the second must turn positively about the axis.
    const quarter: Mesh3D = {
      vertices: [[2.5, 0, 10], [0, 2.5, 10], [2.5, 0, 9]],
      faces: [[0, 1, 2]],
      triangle_to_face: [0],
      face_data: [cylinder],
      face_queries: [faceQuery('u_bore')],
    }
    const attrs = buildThreadAttributes(quarter, sites)!
    const angle = (v: number) => Math.atan2(attrs.coord[v * 4 + 1], attrs.coord[v * 4])
    // About -Z, going from +X to +Y is a negative turn (right-hand rule).
    let delta = angle(1) - angle(0)
    if (delta > Math.PI) delta -= 2 * Math.PI
    if (delta < -Math.PI) delta += 2 * Math.PI
    expect(delta).toBeCloseTo(-Math.PI / 2, 6)
  })

  it('marks the untapped vertices plain', () => {
    const attrs = buildThreadAttributes(mesh, sites)!
    for (const v of [3, 4, 5]) expect(attrs.coord[v * 4 + 3]).toBe(-1)
  })

  it('is null for a body with no tapped face', () => {
    expect(buildThreadAttributes(mesh, null)).toBeNull()
    expect(buildThreadAttributes({ ...mesh, face_queries: [faceQuery('u_x'), faceQuery('u_top')] }, sites)).toBeNull()
  })
})
