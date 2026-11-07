// The cosmetic thread's shading data: which body faces are tapped bores, and
// the per-vertex frame the thread program needs to draw helical ridges on them.
//
// A cosmetic thread changes no geometry. The hole solve reports each tapped
// bore (where the run starts, its axis, how far it goes) together with the UUID
// it minted for that bore face, and the viewport shades the faces whose query
// carries that UUID. The match is by identity only, never by comparing radii or
// axes: a cylinder that merely looks like the bore is not threaded.
//
// Pure: no three.js, no React, so the data path tests without a canvas. The
// shader that consumes the attributes is ThreadProgram (bodyAnalysisMaterial.ts).

import type { LengthUnit, Mesh3D, SketchData } from '@/types/cad'
import { parseAncestry, partitionAncestryIds } from '@/kernel/queryWire'
import { MM_PER_LENGTH_UNIT } from '@/utils/lengthUnit'
import { buildBodyGeometry } from './bodyGeometry'

type Vec3 = [number, number, number]

/** One tapped bore as the shading reads it, in document length units. */
export interface ShadedThreadSite {
  center: Vec3
  axis: Vec3
  length: number
  // The thread pitch in document units: the table's millimetres divided by the
  // unit, so an inch document's ridges are not 25.4x too coarse.
  pitch: number
}

/** Tapped bores keyed by the bore face's UUID. */
export type ThreadSiteIndex = ReadonlyMap<string, ShadedThreadSite>

/**
 * The tapped bores of the given (already visibility-filtered) features, or null
 * when none carries one. Null rather than an empty map so a part with no
 * threads hands every body the same value and no geometry memo re-runs.
 */
export function collectThreadSites(
  features: readonly { id: string; kind?: string }[],
  solveResults: Readonly<Record<string, SketchData>> | undefined,
  lengthUnit: LengthUnit,
): ThreadSiteIndex | null {
  if (!solveResults) return null
  const out = new Map<string, ShadedThreadSite>()
  for (const feature of features) {
    if (feature.kind !== 'hole') continue
    const thread = solveResults[feature.id]?.thread
    // A result cached before the sites existed has no array: draw nothing for
    // it rather than throw over a display-only payload.
    if (!thread || !Array.isArray(thread.sites)) continue
    const pitch = thread.pitch / MM_PER_LENGTH_UNIT[lengthUnit]
    if (!(pitch > 0)) continue
    for (const site of thread.sites) {
      if (!(site.length > 0) || !Array.isArray(site.bore_uuids)) continue
      // One shared record per site: the pieces of a split bore are one thread.
      const shaded: ShadedThreadSite = { center: site.center, axis: site.axis, length: site.length, pitch }
      for (const uuid of site.bore_uuids) out.set(uuid, shaded)
    }
  }
  return out.size > 0 ? out : null
}

/**
 * A content key for a site index, '' for none. Every solve hands the viewport a
 * new result object, so the index is rebuilt each time; going through this key
 * (`threadSitesFromKey`) keeps one index identity while the threads are
 * unchanged, and a threaded body does not rebuild its surface geometry on an
 * unrelated edit.
 */
export function threadSitesKey(index: ThreadSiteIndex | null): string {
  return index === null ? '' : JSON.stringify([...index])
}

/** The index a `threadSitesKey` names. */
export function threadSitesFromKey(key: string): ThreadSiteIndex | null {
  return key === '' ? null : new Map(JSON.parse(key) as [string, ShadedThreadSite][])
}

/** The construction UUIDs a face query carries, [] for an unnamed face. */
function queryUuids(query: string | undefined): string[] {
  if (!query?.startsWith('?')) return []
  try {
    return partitionAncestryIds(parseAncestry(query)[0]).uuids
  } catch {
    // A malformed query is an unnamed face for display purposes: the shading
    // is cosmetic, so it degrades to plain rather than failing the body.
    return []
  }
}

/**
 * Per B-rep face index, the tapped site it shows, or null when no face of the
 * mesh is a tapped bore. Only cylinder faces are considered, which is both the
 * cheap filter (no query parsing for planes) and the right one: a bore that a
 * later feature turned into something else is no longer a threaded wall.
 */
export function tappedFaces(mesh: Mesh3D, sites: ThreadSiteIndex | null): (ShadedThreadSite | null)[] | null {
  if (sites === null) return null
  const queries = mesh.face_queries
  const data = mesh.face_data
  if (!queries || !data) return null
  let any = false
  const out: (ShadedThreadSite | null)[] = new Array(queries.length).fill(null)
  for (let face = 0; face < queries.length; face++) {
    if (data[face]?.surface_type !== 'cylinderface') continue
    for (const uuid of queryUuids(queries[face])) {
      const site = sites.get(uuid)
      if (site !== undefined) {
        out[face] = site
        any = true
        break
      }
    }
  }
  return any ? out : null
}

/** The two vertex attributes the thread program reads. */
export interface ThreadAttributes {
  // (u, v, s, sMax) per vertex: u, v the position across the bore axis in a
  // fixed right-handed frame (u x v = axis), s the distance along the axis from
  // the tapped run's start in pitches, sMax the run's length in pitches.
  // sMax < 0 marks a vertex the program leaves plain.
  coord: Float32Array
  // The bore axis per vertex (model space).
  axis: Float32Array
}

/** A unit vector perpendicular to `axis`, and the third axis completing a
 *  right-handed frame: e1 x e2 = axis. */
function crossFrame(axis: Vec3): [Vec3, Vec3] {
  // Seed with the world axis least aligned with the bore, so the cross product
  // never degenerates.
  const ax = Math.abs(axis[0]), ay = Math.abs(axis[1]), az = Math.abs(axis[2])
  const seed: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1]
  const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
  const raw = cross(seed, axis)
  const n = Math.hypot(raw[0], raw[1], raw[2])
  const e1: Vec3 = [raw[0] / n, raw[1] / n, raw[2] / n]
  return [e1, cross(axis, e1)]
}

/**
 * The thread attributes for the INDEXED body geometry (the form Body3D builds
 * before `toNonIndexed`, which then copies them per split vertex like the
 * normals), or null when the body has no tapped face.
 *
 * Indexed works because the worker's mesh never shares a vertex across a B-rep
 * face boundary, so each vertex belongs to exactly one face and takes that
 * face's site. The angle around the axis is NOT computed here: a per-vertex
 * angle jumps from 2 pi to 0 on the cylinder seam and would smear a triangle
 * across it. The program takes atan2 of the interpolated (u, v) per fragment.
 */
export function buildThreadAttributes(mesh: Mesh3D, sites: ThreadSiteIndex | null): ThreadAttributes | null {
  const perFace = tappedFaces(mesh, sites)
  const triToFace = mesh.triangle_to_face
  if (perFace === null || !triToFace) return null
  const { positions, indices } = buildBodyGeometry(mesh)
  const vertexCount = positions.length / 3
  const coord = new Float32Array(vertexCount * 4)
  const axisOut = new Float32Array(vertexCount * 3)
  for (let i = 0; i < vertexCount; i++) coord[i * 4 + 3] = -1
  const frames = new Map<ShadedThreadSite, [Vec3, Vec3]>()
  const triangles = indices.length / 3
  for (let tri = 0; tri < triangles; tri++) {
    const site = perFace[triToFace[tri]] ?? null
    if (site === null) continue
    let frame = frames.get(site)
    if (frame === undefined) {
      frame = crossFrame(site.axis)
      frames.set(site, frame)
    }
    const [e1, e2] = frame
    for (let k = 0; k < 3; k++) {
      const v = indices[tri * 3 + k]
      const dx = positions[v * 3] - site.center[0]
      const dy = positions[v * 3 + 1] - site.center[1]
      const dz = positions[v * 3 + 2] - site.center[2]
      coord[v * 4] = dx * e1[0] + dy * e1[1] + dz * e1[2]
      coord[v * 4 + 1] = dx * e2[0] + dy * e2[1] + dz * e2[2]
      coord[v * 4 + 2] = (dx * site.axis[0] + dy * site.axis[1] + dz * site.axis[2]) / site.pitch
      coord[v * 4 + 3] = site.length / site.pitch
      axisOut[v * 3] = site.axis[0]
      axisOut[v * 3 + 1] = site.axis[1]
      axisOut[v * 3 + 2] = site.axis[2]
    }
  }
  return { coord, axis: axisOut }
}
