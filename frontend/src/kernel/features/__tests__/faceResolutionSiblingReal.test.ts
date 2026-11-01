// @vitest-environment node
//
// A stored face pick names the body it was authored on, but identity is not
// the body's: a keep-both split hands an untouched face's UUID to whichever
// half contains it, while the query keeps naming the pre-split body. Shell and
// move face trusted the token and reported the pick unresolved; delete face
// already scanned the store and recovered it.
//
// All three leaves now share `bodyOfQuery`'s contains-then-scan rule. The picks
// below are authored on the one-piece body and land on the sibling
// (`body_ex1_1`, the below half) once the plate is split through the middle.
//
// Skips when OCC.js or the Rust solver is absent.
import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { parseAncestry } from '../../query'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import type { BuildResponse } from '../../builder'
import type { Body } from '../../types3d'

const oc = await loadOcc()
const solveBytes = loadSolver()

type Dict = Record<string, unknown>
interface FaceDatum {
  centroid: number[]
  normal?: number[]
  area?: number
  surface_type?: string
}
interface FaceMesh { face_queries?: string[]; face_data?: FaceDatum[] }

const uuidOf = (q: string): string | undefined => parseAncestry(q)[0].find((i) => i.startsWith('@u|'))

function rectSketch(sketchId: string, w: number, h: number): Dict {
  return {
    id: sketchId, kind: 'sketch', label: 'Rectangle', plane: '@builtin_plane_front',
    entities: [
      { id: 'bottom', kind: 'line' }, { id: 'right', kind: 'line' },
      { id: 'top', kind: 'line' }, { id: 'left', kind: 'line' },
    ],
    initial: {
      bottom: [0, 0, w, 0], right: [w, 0, w, h],
      top: [w, h, 0, h], left: [0, h, 0, 0],
    },
    constraints: [
      { id: 'c1', kind: 'coincident', a: { entity: 'bottom', point: 'end' }, b: { entity: 'right', point: 'start' } },
      { id: 'c2', kind: 'coincident', a: { entity: 'right', point: 'end' }, b: { entity: 'top', point: 'start' } },
      { id: 'c3', kind: 'coincident', a: { entity: 'top', point: 'end' }, b: { entity: 'left', point: 'start' } },
      { id: 'c4', kind: 'coincident', a: { entity: 'left', point: 'end' }, b: { entity: 'bottom', point: 'start' } },
      { id: 'c9', kind: 'length', target: { entity: 'bottom' }, value: w },
      { id: 'c10', kind: 'length', target: { entity: 'left' }, value: h },
    ],
  }
}

/** A 10-cube extruded along the front normal (world +y), optionally with a
 *  blind hole drilled 3 deep from the y=0 face. */
function plateSpec(hole: boolean): { features: Dict[] } {
  const features: Dict[] = [
    rectSketch('sk1', 10, 10),
    { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: 10, direction: 'normal', operation: 'new' },
  ]
  if (hole) {
    features.push(
      {
        id: 'skh', kind: 'sketch', label: 'Drill sites', plane: '@builtin_plane_front',
        entities: [{ id: 'p1', kind: 'point' }], initial: { p1: [5, 2] }, constraints: [],
      },
      {
        id: 'h1', kind: 'hole', hole: {
          sketch: '@skh', diameter: 3, depth_mode: 'blind', depth: 3, direction: 'normal', target: '@body_ex1',
        },
      },
    )
  }
  return { features }
}

/** Split the one body through y=5 and keep both halves. */
function splitBoth(spec: { features: Dict[] }): { features: Dict[] } {
  return { features: [
    ...spec.features,
    { id: 'pl1', kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_top', offset: 5 } },
    { id: 'sp1', kind: 'split', split: { bodies: ['@ex1'], plane: '@pl1', keep: 'both' } },
  ]}
}

function meshOf(h: SharedHarness, r: BuildResponse, bodyId: string): FaceMesh {
  return ((h.body(r, bodyId).mesh ?? {}) as FaceMesh)
}

/** The flat face whose centroid y is nearest `y`. */
function flatFaceNear(mesh: FaceMesh, y: number): string {
  let best = -1
  let bestGap = Infinity
  mesh.face_data?.forEach((fd, i) => {
    if (fd.surface_type !== 'flatface') return
    const gap = Math.abs(fd.centroid[1] - y)
    if (gap < bestGap) { bestGap = gap; best = i }
  })
  return mesh.face_queries?.[best] ?? ''
}

describe.skipIf(!oc || !solveBytes)('a face pick on a split sibling resolves (real OCC)', () => {
  const h = new SharedHarness(oc!)
  beforeAll(() => {
    resetSketchSolver()
    setSketchSolver(solveBytes!)
  })

  // The pick's UUID is live on the below half after the split, which is what
  // makes the stored @body token a stale hint rather than an error.
  function expectOnSibling(r: BuildResponse, pick: string): void {
    const uuid = uuidOf(pick)
    expect(uuid).toBeDefined()
    const snapshot = r._build_state!.checkpoints['sp1'].body_store_snapshot as Record<string, Body>
    const raw = uuid?.slice('@u|'.length)
    expect(snapshot.body_ex1_1.face_uuids ?? []).toContain(raw)
  }

  it('shell acts on the sibling', () => {
    const base = h.run(plateSpec(false))
    const bottom = flatFaceNear(meshOf(h, base, 'body_ex1'), 0)
    expect(bottom).toContain('@body_ex1')
    const spec = splitBoth(plateSpec(false))
    spec.features.push({ id: 'sh1', kind: 'shell', shell: { faces: [bottom], thickness: 0.5 } })
    const r = h.run(spec)
    expect(h.res(r, 'sh1').status).toBe('ok')
    expect(h.res(r, 'sh1').body_ids).toEqual(['body_ex1_1'])
    expectOnSibling(r, bottom)
  })

  it('move face acts on the sibling', () => {
    const base = h.run(plateSpec(false))
    const bottom = flatFaceNear(meshOf(h, base, 'body_ex1'), 0)
    const spec = splitBoth(plateSpec(false))
    spec.features.push({ id: 'mf1', kind: 'move_face', move_face: { faces: [bottom], distance: 2 } })
    const r = h.run(spec)
    expect(h.res(r, 'mf1').status).toBe('ok')
    expect(h.res(r, 'mf1').body_ids).toEqual(['body_ex1_1'])
    expectOnSibling(r, bottom)
  })

  it('delete face acts on the sibling', () => {
    const base = h.run(plateSpec(true))
    // The blind hole's wall and floor: the two faces carrying the drill site's
    // lineage. The hole heals to a plain half plate, which is the whole-feature
    // case delete face accepts.
    const hm = meshOf(h, base, 'body_ex1')
    const hole = (hm.face_data ?? [])
      .map((fd, i) => ({ fd, q: hm.face_queries?.[i] ?? '' }))
      .filter(({ q }) => q.includes('@skh/p1'))
      .map(({ q }) => q)
    expect(hole).toHaveLength(2)
    const spec = splitBoth(plateSpec(true))
    spec.features.push({ id: 'df1', kind: 'delete_face', delete_face: { faces: hole } })
    const r = h.run(spec)
    expect(h.res(r, 'df1').status).toBe('ok')
    expect(h.res(r, 'df1').body_ids).toEqual(['body_ex1_1'])
    for (const q of hole) expectOnSibling(r, q)
  })
})
