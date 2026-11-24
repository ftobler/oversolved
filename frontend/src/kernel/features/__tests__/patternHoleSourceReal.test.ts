// @vitest-environment node
//
// A hole as a feature-pattern and feature-mirror source, through the production
// builder (SharedHarness): the shared resolveSources/buildSourceTools engine
// repeats the hole's own per-site cutter, so a copy carries the hole's style
// (counterbore, drill point), its bore/floor face roles and its cosmetic thread
// instead of redrawing the bores as circles and cutting them with an extrude.
//
// Every kind runs through the same engine, so the circular case comes first and
// the linear, curve, instance and mirror cases follow. The axis case (a bore
// face as the pattern axis) pins the reading this feature relies on but does
// not change. Skips when OCC.js or the sketch solver is absent.

import { describe, it, expect, beforeAll } from 'vitest'
import { loadOcc } from '../../occ/loadOcc'
import { SharedHarness } from '../../occ/sharedHarness'
import { DisposeScope } from '../../occ/disposeScope'
import { setSketchSolver, resetSketchSolver } from '../sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { volumeOf } from '../../occ/volume'
import { arrayInstancePath, holeFacePath, mintFaceUuid } from '../../constructionName'
import { shapeBndBox } from '../../occ/primitives'
import type { OccModule, OccShape } from '../../occ/occTypes'
import type { BuildResponse } from '../../builder'
import type { PartSolid } from '../../types3d'
import type { ThreadDisplayData } from '@/types/cad'
import { splitPatternDef } from '@/utils/core/patternSplit'

const oc = await loadOcc()
const solveBytes = loadSolver()

type Dict = Record<string, unknown>

interface FaceView {
  centroid?: number[]
  normal?: number[]
  surface_type?: string
}
interface PartView {
  mesh?: { face_data?: FaceView[]; face_queries?: string[] }
}

function polySketch(id: string, points: [number, number][], plane = '@builtin_plane_front'): Dict {
  const n = points.length
  const entities: Dict[] = []
  const initial: Record<string, number[]> = {}
  const constraints: Dict[] = []
  for (let i = 0; i < n; i++) {
    const a = points[i]
    const b = points[(i + 1) % n]
    entities.push({ id: `l${i}`, kind: 'line' })
    initial[`l${i}`] = [a[0], a[1], b[0], b[1]]
    constraints.push({
      id: `c${i}`, kind: 'coincident',
      a: { entity: `l${i}`, point: 'end' },
      b: { entity: `l${(i + 1) % n}`, point: 'start' },
    })
    constraints.push({ id: `h${i}`, kind: a[1] === b[1] ? 'horizontal' : 'vertical', target: { entity: `l${i}` } })
  }
  return { id, kind: 'sketch', plane, entities, initial, constraints }
}

function rectSketch(id: string, w: number, h: number, x0 = 0, y0 = 0, plane = '@builtin_plane_front'): Dict {
  return polySketch(id, [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]], plane)
}

function circleSketch(id: string, cx: number, cy: number, r: number, plane = '@builtin_plane_front'): Dict {
  return {
    id, kind: 'sketch', plane,
    entities: [{ id: 'c1', kind: 'circle' }],
    initial: { c1: [cx, cy, r] },
    constraints: [{ id: 'r1', kind: 'radius', target: { entity: 'c1' } }],
  }
}

/** A point sketch standing in for a drill site; not this suite's sketch subject. */
function pointSketch(id: string, x: number, y: number, plane = '@builtin_plane_front'): Dict {
  return { id, kind: 'sketch', plane, entities: [{ id: 'p1', kind: 'point' }], initial: { p1: [x, y] }, constraints: [] }
}

/** A straight path line for the curve pattern, the sweep's own grammar. */
function linePath(id: string, x0: number, y0: number, x1: number, y1: number): Dict {
  return {
    id, kind: 'sketch', plane: '@builtin_plane_front',
    entities: [{ id: 'l0', kind: 'line' }],
    initial: { l0: [x0, y0, x1, y1] },
    constraints: [],
  }
}

const planeAt = (id: string, offset: number): Dict =>
  ({ id, kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_front', offset } })

const extrude = (id: string, sketch: string, distance: number, operation = 'new'): Dict =>
  ({ id, kind: 'extrude', extrude: { sketch, distance, direction: 'normal', operation } })

const hole = (id: string, sketch: string, fields: Dict): Dict =>
  ({ id, kind: 'hole', hole: { sketch, target: '@body_ex_disc', ...fields } })

/** A linear or circular pattern row from the retired flat spelling. */
function pattern(id: string, sources: string[], fields: Dict): Dict {
  const refs = sources.map((ref) => (ref.startsWith('@') ? ref : `@${ref}`))
  const { kind, def } = splitPatternDef({ subject: 'feature', source_features: refs, ...fields })
  return { id, kind, [kind]: def }
}

function circleBoreVolume(radius: number, length: number): number {
  return Math.PI * radius * radius * length
}

/** The volume removed by a counterbored blind bore: the bore plus the wider
 *  step annulus, and a drill point adds its cone below the shoulder. */
function counterboreRemoved(r: number, depth: number, R: number, step: number, tipHeight = 0): number {
  return Math.PI * r * r * depth + Math.PI * (R * R - r * r) * step + (Math.PI * r * r * tipHeight) / 3
}

describe.skipIf(!oc || !solveBytes)('a hole as a pattern source (real OCC + Rust solver)', () => {
  const h = new SharedHarness(oc!)
  const occ = oc as OccModule

  beforeAll(() => {
    if (!oc || !solveBytes) throw new Error('unreachable: skipIf guards this')
    resetSketchSolver()
    setSketchSolver(solveBytes)
  })

  function snapshot(r: BuildResponse, featureId: string): Record<string, PartSolid> {
    return r._build_state!.checkpoints[featureId].body_store_snapshot as Record<string, PartSolid>
  }
  function shapeAt(r: BuildResponse, featureId: string, partId: string): OccShape {
    return h.table.get<OccShape>(snapshot(r, featureId)[partId].shape!)
  }
  function volumeAt(r: BuildResponse, featureId: string, partId: string): number {
    const scope = new DisposeScope()
    try { return volumeOf(occ, scope, shapeAt(r, featureId, partId)) } finally { scope.dispose() }
  }
  function facesOf(r: BuildResponse, partId: string): FaceView[] {
    return (h.part(r, partId) as PartView).mesh?.face_data ?? []
  }
  function queriesOf(r: BuildResponse, partId: string): string[] {
    return (h.part(r, partId) as PartView).mesh?.face_queries ?? []
  }
  function partFaceUuids(r: BuildResponse, featureId: string, partId: string): string[] {
    return (snapshot(r, featureId)[partId].face_uuids ?? []).filter((uuid): uuid is string => uuid !== null)
  }
  function bboxOf(r: BuildResponse, featureId: string, partId: string) {
    const scope = new DisposeScope()
    try { return shapeBndBox(occ, scope, shapeAt(r, featureId, partId)) } finally { scope.dispose() }
  }

  it('repeats a through hole around an axis, one bore role per copy', () => {
    // A 60 mm disc 10 thick on Front; one d5 through bore on a 20 mm pitch
    // radius, drilled down from the top plane. Count 6 is the source plus five
    // copies, so six bores in all.
    const doc = {
      features: [
        circleSketch('sk_disc', 0, 0, 30),
        extrude('ex_disc', '$sk_disc', 10),
        planeAt('pl_top', 10),
        pointSketch('sk_hole', 20, 0, '@pl_top'),
        hole('h1', '$sk_hole', {
          diameter: 5, depth_mode: 'through_all', direction: 'reverse', target: '@body_ex_disc',
        }),
        pattern('pt1', ['h1'], {
          mode: 'circular', count: 6, axis_origin: [0, 0, 0], axis_direction: [0, 0, 1],
        }),
      ],
    }
    const r = h.run(doc)
    expect(h.res(r, 'h1').status).toBe('ok')
    const res = h.res(r, 'pt1')
    expect(res.status, String(res.exception)).toBe('ok')
    expect(res.operation).toBe('cut')
    expect(volumeAt(r, 'pt1', 'body_ex_disc')).toBeCloseTo(
      Math.PI * 900 * 10 - 6 * circleBoreVolume(2.5, 10), 4,
    )
    // One cylindrical wall per bore, plus the disc's own outer wall.
    expect(facesOf(r, 'body_ex_disc').filter((face) => face.surface_type === 'cylinderface')).toHaveLength(7)

    // Each copy's wall is the bore role the hole minted, remapped through the
    // pattern's instance path: the source bore's UUID plus `|array|pt1|<key>`.
    const sourceBore = mintFaceUuid(holeFacePath('h1', 'sk_hole/p1', 'bore'))
    const uuids = partFaceUuids(r, 'pt1', 'body_ex_disc')
    expect(uuids).toContain(sourceBore)
    for (const key of ['1', '2', '3', '4', '5']) {
      expect(uuids).toContain(mintFaceUuid(arrayInstancePath(sourceBore, 'pt1', key)))
    }
    // The copy's face query carries the drill site's ancestry, as an extrude
    // cut's copy carries its profile entity's.
    const boreQueries = queriesOf(r, 'body_ex_disc').filter((query) => query.includes('sk_hole/p1'))
    expect(boreQueries).toHaveLength(6)
  }, 240_000)

  it('keeps the side the hole voted when direction is omitted', () => {
    // The common face-sketch/top-plane case: no authored direction, so the real
    // solve probes and votes `reverse`. The pattern's tool build must read that
    // recorded axis; re-probing the already-drilled body would vote `normal`
    // and leave five dimples above the top face instead of five bores.
    const disc = {
      features: [
        circleSketch('sk_disc', 0, 0, 30),
        extrude('ex_disc', '$sk_disc', 10),
        planeAt('pl_top', 10),
        pointSketch('sk_hole', 20, 0, '@pl_top'),
        hole('h1', '$sk_hole', { diameter: 5, depth_mode: 'through_all', target: '@body_ex_disc' }),
        pattern('pt1', ['h1'], {
          mode: 'circular', count: 6, axis_origin: [0, 0, 0], axis_direction: [0, 0, 1],
        }),
      ],
    }
    const r = h.run(disc)
    expect(h.res(r, 'h1').direction).toBe('reverse')
    const res = h.res(r, 'pt1')
    expect(res.status, String(res.exception)).toBe('ok')
    expect(res.solver_warning).toBeUndefined()
    // Six through bores in the 60 mm disc: 28274.33 - 1178.10 = 27096.24.
    expect(volumeAt(r, 'pt1', 'body_ex_disc')).toBeCloseTo(
      Math.PI * 900 * 10 - 6 * circleBoreVolume(2.5, 10), 4,
    )

    // The same source mirrored across a vertical mid plane: the reflected copy
    // must enter from the same face, not turn the voted axis outward.
    const mirrored = h.run({
      features: [
        rectSketch('sk_plate', 40, 20),
        extrude('ex_plate', '$sk_plate', 10),
        planeAt('pl_top', 10),
        pointSketch('sk_hole', 10, 10, '@pl_top'),
        hole('h1', '$sk_hole', { diameter: 5, depth_mode: 'through_all', target: '@body_ex_plate' }),
        { id: 'pl_mid', kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_right', offset: 20 } },
        {
          id: 'mi1', kind: 'mirror',
          mirror: { subject: 'feature', source_features: ['@h1'], plane: '@pl_mid' },
        },
      ],
    })
    expect(h.res(mirrored, 'h1').direction).toBe('reverse')
    const mirrorRes = h.res(mirrored, 'mi1')
    expect(mirrorRes.status, String(mirrorRes.exception)).toBe('ok')
    expect(mirrorRes.solver_warning).toBeUndefined()
    // 40 x 20 x 10 plate minus the source bore and its mirror at x = 30.
    expect(volumeAt(mirrored, 'mi1', 'body_ex_plate')).toBeCloseTo(
      40 * 20 * 10 - 2 * circleBoreVolume(2.5, 10), 4,
    )
  }, 240_000)

  it('repeats a hole with several drill sites as one compound tool', () => {
    // Three sites are one tool per instance: six bores for count 2, each with
    // its own wall. This is the compound branch (the sites do not overlap).
    const doc = {
      features: [
        rectSketch('sk_plate', 200, 40),
        extrude('ex_plate', '$sk_plate', 5),
        planeAt('pl_top', 5),
        {
          id: 'sk_hole', kind: 'sketch', plane: '@pl_top',
          entities: [{ id: 'p1', kind: 'point' }, { id: 'p2', kind: 'point' }, { id: 'p3', kind: 'point' }],
          initial: { p1: [10, 20], p2: [30, 20], p3: [50, 20] },
          constraints: [],
        },
        hole('h1', '$sk_hole', {
          diameter: 4, depth_mode: 'through_all', direction: 'reverse', target: '@body_ex_plate',
        }),
        pattern('pt1', ['h1'], {
          mode: 'linear', count: 2, pitch: 60, direction: [1, 0, 0],
        }),
      ],
    }
    const r = h.run(doc)
    const res = h.res(r, 'pt1')
    expect(res.status, String(res.exception)).toBe('ok')
    expect(volumeAt(r, 'pt1', 'body_ex_plate')).toBeCloseTo(
      200 * 40 * 5 - 6 * circleBoreVolume(2, 5), 4,
    )
    // Six bore walls and no other cylinder on a rectangular plate.
    expect(facesOf(r, 'body_ex_plate').filter((face) => face.surface_type === 'cylinderface')).toHaveLength(6)
  }, 240_000)

  it('keeps a site the body no longer names when a later feature replaces its bore', () => {
    // A later concentric cut swallows the h1 bore wall and leaves its own face
    // there, so a body-role classification at the pattern's log position would
    // drop the site. The hole's recorded state still knows it cut.
    const doc = {
      features: [
        rectSketch('sk_plate', 40, 20),
        extrude('ex_plate', '$sk_plate', 5),
        planeAt('pl_top', 5),
        pointSketch('sk_hole', 10, 10, '@pl_top'),
        hole('h1', '$sk_hole', {
          diameter: 4, depth_mode: 'through_all', direction: 'reverse', target: '@body_ex_plate',
        }),
        circleSketch('sk_big', 10, 10, 3, '@pl_top'),
        {
          id: 'ex_big', kind: 'extrude',
          extrude: { sketch: '@sk_big', termination: 'through_all', direction: 'reverse', operation: 'cut' },
        },
        pattern('pt1', ['h1'], {
          mode: 'linear', count: 2, pitch: 10, direction: [1, 0, 0],
        }),
      ],
    }
    const r = h.run(doc)
    const res = h.res(r, 'pt1')
    expect(res.status, String(res.exception)).toBe('ok')
    // Plate minus the r3 cut at x=10 and the repeated d4 bore at x=20.
    expect(volumeAt(r, 'pt1', 'body_ex_plate')).toBeCloseTo(
      40 * 20 * 5 - circleBoreVolume(3, 5) - circleBoreVolume(2, 5), 4,
    )
  }, 240_000)

  it('fuses two partially overlapping site cutters into one repeatable tool', () => {
    // The two d4 bores are 3 mm apart: each leaves material the other does not,
    // so neither is swallowed, but their cutters overlap. The tool must be one
    // fused solid, and the copies of the pair remove the same lens-shaped union.
    const lens = (r: number, d: number): number =>
      2 * r * r * Math.acos(d / (2 * r)) - (d / 2) * Math.sqrt(4 * r * r - d * d)
    const pair = (2 * Math.PI * 4 - lens(2, 3)) * 5
    const doc = {
      features: [
        rectSketch('sk_plate', 40, 20),
        extrude('ex_plate', '$sk_plate', 5),
        planeAt('pl_top', 5),
        {
          id: 'sk_hole', kind: 'sketch', plane: '@pl_top',
          entities: [{ id: 'p1', kind: 'point' }, { id: 'p2', kind: 'point' }],
          initial: { p1: [5, 10], p2: [8, 10] },
          constraints: [],
        },
        hole('h1', '$sk_hole', {
          diameter: 4, depth_mode: 'through_all', direction: 'reverse', target: '@body_ex_plate',
        }),
        pattern('pt1', ['h1'], {
          mode: 'linear', count: 2, pitch: 10, direction: [1, 0, 0],
        }),
      ],
    }
    const r = h.run(doc)
    const res = h.res(r, 'pt1')
    expect(res.status, String(res.exception)).toBe('ok')
    // The source pair plus its copy at x 15 and 18: 40 x 20 x 5 minus two unions.
    expect(volumeAt(r, 'pt1', 'body_ex_plate')).toBeCloseTo(40 * 20 * 5 - 2 * pair, 4)
  }, 240_000)

  it('refuses a copy that turns a through_all hole\'s drill axis', () => {
    // A through_all tool carries one span along the source's drill axis. A copy
    // rotated 45 degrees about a perpendicular axis would need a longer span, so
    // it is refused by name rather than cutting a blind pocket.
    const doc = {
      features: [
        rectSketch('sk_plate', 40, 40, -20, -20),
        extrude('ex_plate', '$sk_plate', 5),
        planeAt('pl_top', 5),
        pointSketch('sk_hole', 0, 0, '@pl_top'),
        hole('h1', '$sk_hole', {
          diameter: 5, depth_mode: 'through_all', direction: 'reverse', target: '@body_ex_plate',
        }),
        {
          id: 'pt1', kind: 'circular_pattern',
          circular_pattern: {
            subject: 'feature', source_features: ['@h1'], count: 2, angle: 45, equal_spacing: false,
            axis_origin: [0, 0, 5], axis_direction: [1, 0, 0],
          },
        },
      ],
    }
    const r = h.run(doc)
    const res = h.res(r, 'pt1')
    expect(res.status).toBe('exception')
    expect(String(res.exception)).toContain("turns the through_all hole's drill axis")
    expect(String(res.exception)).toContain('keep the drill axis parallel or use a blind hole')
    // The source's own bore is still there; the refused copy changed nothing.
    expect(volumeAt(r, 'pt1', 'body_ex_plate')).toBeCloseTo(
      40 * 40 * 5 - circleBoreVolume(2.5, 5), 4,
    )
  }, 240_000)

  it('repeats a counterbored blind hole with its drill point, style intact', () => {
    // Same plate, one counterbored blind hole 6 deep with a drill point. The
    // pattern must remove five times the source's own delta, and every copy
    // keeps the cone floor the tip leaves.
    const tipAngle = 118
    const tipHeight = 2.5 / Math.tan((tipAngle * Math.PI) / 360)
    const doc = {
      features: [
        circleSketch('sk_disc', 0, 0, 30),
        extrude('ex_disc', '$sk_disc', 10),
        planeAt('pl_top', 10),
        pointSketch('sk_hole', 20, 0, '@pl_top'),
        hole('h1', '$sk_hole', {
          diameter: 5, depth_mode: 'blind', depth: 6, direction: 'reverse', target: '@body_ex_disc',
          style: 'counterbore', cb_diameter: 9, cb_depth: 2, tip: 'drill_point', tip_angle: tipAngle,
        }),
        pattern('pt1', ['h1'], {
          mode: 'circular', count: 6, axis_origin: [0, 0, 0], axis_direction: [0, 0, 1],
        }),
      ],
    }
    const r = h.run(doc)
    // The disk, after the hole, after the pattern: the deltas are the hole's
    // own and the five copies'.
    const plate = volumeAt(r, 'ex_disc', 'body_ex_disc')
    const afterHole = volumeAt(r, 'h1', 'body_ex_disc')
    const afterPattern = volumeAt(r, 'pt1', 'body_ex_disc')
    const holeDelta = plate - afterHole
    expect(holeDelta).toBeCloseTo(counterboreRemoved(2.5, 6, 4.5, 2, tipHeight), 4)
    expect(afterHole - afterPattern).toBeCloseTo(5 * holeDelta, 4)
    // The source's tip and its five copies: one cone face each.
    expect(facesOf(r, 'body_ex_disc').filter((face) => face.surface_type === 'coneface')).toHaveLength(6)
  }, 240_000)

  it('repeats a hole over the boss a mixed source fuses first', () => {
    // A 40 x 20 x 5 plate with a boss and a bore through it. Both are sources;
    // the boss copy is fused at instance 1 before the hole copy cuts it, so the
    // bore lands in the copied boss rather than beside it.
    const doc = {
      features: [
        rectSketch('sk_plate', 40, 20),
        extrude('ex_plate', '$sk_plate', 5),
        planeAt('pl_top', 5),
        circleSketch('sk_boss', 10, 10, 3, '@pl_top'),
        extrude('ex_boss', '$sk_boss', 3, 'add'),
        planeAt('pl_boss_top', 8),
        pointSketch('sk_hole', 10, 10, '@pl_boss_top'),
        hole('h1', '$sk_hole', {
          diameter: 2, depth_mode: 'through_all', direction: 'reverse', target: '@body_ex_plate',
        }),
        pattern('pt1', ['ex_boss', 'h1'], {
          mode: 'linear', count: 2, pitch: 10, direction: [1, 0, 0],
        }),
      ],
    }
    const r = h.run(doc)
    const res = h.res(r, 'pt1')
    expect(res.status, String(res.exception)).toBe('ok')
    // Source and copy both drill the bore through the boss and the plate: two
    // bores 8 mm long, not just the plate's 5.
    expect(volumeAt(r, 'pt1', 'body_ex_plate')).toBeCloseTo(
      40 * 20 * 5 + 2 * Math.PI * 9 * 3 - 2 * circleBoreVolume(1, 8), 4,
    )
    // The copy is fused into the one body, not islanded beside it.
    expect(res.body_ids).toEqual(['body_ex_plate'])
  }, 240_000)

  it('sizes a through_all copy from the whole body, not the source site thickness', () => {
    // A plate with its bottom 8 mm removed over x 0..20: the top face is at
    // z = 10 everywhere, so the source bore over the 2 mm web and its copy over
    // the 10 mm block both start at the same face. Sizing from the body's whole
    // span cuts the copy through; sizing from the source's local thickness
    // would leave an 8 mm plug in the copy.
    const doc = {
      features: [
        rectSketch('sk_plate', 40, 20),
        extrude('ex_plate', '$sk_plate', 10),
        rectSketch('sk_under', 20, 20, 0, 0),
        extrude('ex_under', '$sk_under', 8, 'cut'),
        planeAt('pl_top', 10),
        pointSketch('sk_hole', 5, 10, '@pl_top'),
        hole('h1', '$sk_hole', {
          diameter: 5, depth_mode: 'through_all', direction: 'reverse', target: '@body_ex_plate',
        }),
        pattern('pt1', ['h1'], {
          mode: 'linear', count: 2, pitch: 20, direction: [1, 0, 0],
        }),
      ],
    }
    const r = h.run(doc)
    const res = h.res(r, 'pt1')
    expect(res.status, String(res.exception)).toBe('ok')
    // Plate 8000 minus the 20 x 20 x 8 undercut, minus the source bore through
    // the 2 mm web and the copy through the 10 mm block.
    expect(volumeAt(r, 'pt1', 'body_ex_plate')).toBeCloseTo(
      40 * 20 * 10 - 20 * 20 * 8 - circleBoreVolume(2.5, 2) - circleBoreVolume(2.5, 10), 4,
    )
  }, 240_000)

  it('carries a threaded hole\'s tapped runs onto every applied copy', () => {
    // A threaded blind bore patterned four copies around the source: each copy
    // shades the bore it actually cut. Skipping instance 2 leaves three.
    const plate = (skip?: number[]): Dict => ({
      features: [
        rectSketch('sk_plate', 60, 60, -30, -30),
        extrude('ex_plate', '$sk_plate', 5),
        planeAt('pl_top', 5),
        pointSketch('sk_hole', 10, 10, '@pl_top'),
        hole('h_bores', '$sk_hole', {
          diameter: 4.2, depth_mode: 'blind', depth: 4, direction: 'reverse', target: '@body_ex_plate',
          thread: { designation: 'M5x0.8', nominal: 5, pitch: 0.8 },
        }),
        pattern('pt1', ['h_bores'], {
          mode: 'circular', count: 5, axis_origin: [0, 0, 0], axis_direction: [0, 0, 1],
          ...(skip === undefined ? {} : { skip }),
        }),
      ],
    })
    const r = h.run(plate())
    expect(h.res(r, 'pt1').status).toBe('ok')
    const sourceThread = h.res(r, 'h_bores').thread as ThreadDisplayData
    expect(sourceThread.sites).toHaveLength(1)
    const thread = h.res(r, 'pt1').thread as ThreadDisplayData
    expect(thread).toBeDefined()
    expect(thread.designation).toBe('M5x0.8')
    expect(thread.pitch).toBe(0.8)
    expect(thread.sites).toHaveLength(4)
    // Each run's centre is the source centre rotated by the instance angle;
    // its axis stays the drill direction.
    const uuids = partFaceUuids(r, 'pt1', 'body_ex_plate')
    thread.sites.forEach((site, index) => {
      const angle = ((index + 1) * 72 * Math.PI) / 180
      const x = 10 * Math.cos(angle) - 10 * Math.sin(angle)
      const y = 10 * Math.sin(angle) + 10 * Math.cos(angle)
      expect(site.center[0]).toBeCloseTo(x, 6)
      expect(site.center[1]).toBeCloseTo(y, 6)
      expect(site.center[2]).toBeCloseTo(5, 6)
      expect(site.axis.map((n) => n + 0)).toEqual([0, 0, -1])
      expect(site.length).toBeCloseTo(4, 6)
      // The run names the bore face the copy actually left on the body.
      expect(site.bore_uuids).toHaveLength(1)
      expect(uuids).toContain(site.bore_uuids[0])
    })

    const skipped = h.run(plate([2]))
    expect(h.res(skipped, 'pt1').status).toBe('ok')
    const skippedThread = h.res(skipped, 'pt1').thread as ThreadDisplayData
    expect(skippedThread.sites).toHaveLength(3)
  }, 240_000)

  it('repeats a hole along a curve path', () => {
    // The shared engine serves every kind; a straight path must land the same
    // bores a linear pattern does.
    const doc = {
      features: [
        rectSketch('sk_plate', 80, 40, 0, 0),
        extrude('ex_plate', '$sk_plate', 5),
        planeAt('pl_top', 5),
        pointSketch('sk_hole', 30, 20, '@pl_top'),
        hole('h1', '$sk_hole', {
          diameter: 4, depth_mode: 'through_all', direction: 'reverse', target: '@body_ex_plate',
        }),
        linePath('sk_path', 0, 20, 40, 20),
        {
          id: 'cu1', kind: 'curve_pattern',
          curve_pattern: {
            subject: 'feature', source_features: ['@h1'], count: 3, path: ['@sk_path'], orientation: 'fixed',
          },
        },
      ],
    }
    const r = h.run(doc)
    const res = h.res(r, 'cu1')
    expect(res.status, String(res.exception)).toBe('ok')
    expect(volumeAt(r, 'cu1', 'body_ex_plate')).toBeCloseTo(
      80 * 40 * 5 - 3 * circleBoreVolume(2, 5), 4,
    )
  }, 240_000)

  it('repeats a hole onto an instance pattern target list', () => {
    // A sketch's points are the instance list; the source's own point is its
    // slot, so three points make two copies.
    const doc = {
      features: [
        rectSketch('sk_plate', 80, 40, 0, 0),
        extrude('ex_plate', '$sk_plate', 5),
        planeAt('pl_top', 5),
        pointSketch('sk_hole', 10, 20, '@pl_top'),
        hole('h1', '$sk_hole', {
          diameter: 4, depth_mode: 'through_all', direction: 'reverse', target: '@body_ex_plate',
        }),
        {
          id: 'sk_targets', kind: 'sketch', plane: '@pl_top',
          entities: [{ id: 'a', kind: 'point' }, { id: 'b', kind: 'point' }, { id: 'c', kind: 'point' }],
          initial: { a: [10, 20], b: [40, 20], c: [70, 20] },
          constraints: [],
        },
        {
          id: 'ip1', kind: 'instance_pattern',
          instance_pattern: {
            subject: 'feature', source_features: ['@h1'], targets: ['@sk_targets'], orientation: 'fixed',
          },
        },
      ],
    }
    const r = h.run(doc)
    const res = h.res(r, 'ip1')
    expect(res.status, String(res.exception)).toBe('ok')
    expect(volumeAt(r, 'ip1', 'body_ex_plate')).toBeCloseTo(
      80 * 40 * 5 - 3 * circleBoreVolume(2, 5), 4,
    )
  }, 240_000)

  it('mirrors a counterbored hole so the bore enters from the mirrored face', () => {
    // The mirror plane is the plate's mid plane (z = 5). The tool is reflected
    // with the copy, so the mirrored counterbore opens on the BOTTOM face at
    // the same plan position; a re-voted drill side would open it on top.
    const doc = {
      features: [
        rectSketch('sk_plate', 40, 20),
        extrude('ex_plate', '$sk_plate', 10),
        planeAt('pl_top', 10),
        pointSketch('sk_hole', 10, 10, '@pl_top'),
        hole('h1', '$sk_hole', {
          diameter: 5, depth_mode: 'blind', depth: 6, direction: 'reverse', target: '@body_ex_plate',
          style: 'counterbore', cb_diameter: 9, cb_depth: 2,
        }),
        planeAt('pl_mid', 5),
        {
          id: 'mi1', kind: 'mirror',
          mirror: { subject: 'feature', source_features: ['@h1'], plane: '@pl_mid' },
        },
      ],
    }
    const r = h.run(doc)
    const res = h.res(r, 'mi1')
    expect(res.status, String(res.exception)).toBe('ok')
    // The source counterbore opens at z 8..10 and the mirrored one at z 0..2;
    // the two bores overlap between z 4 and 6, so the shared volume counts once.
    const source = counterboreRemoved(2.5, 6, 4.5, 2)
    const mirrored = counterboreRemoved(2.5, 6, 4.5, 2)
    // Only the two bores' z 4..6 lengths coincide; the steps open on opposite
    // faces and share nothing.
    const overlap = circleBoreVolume(2.5, 2)
    expect(volumeAt(r, 'mi1', 'body_ex_plate')).toBeCloseTo(
      40 * 20 * 10 - (source + mirrored - overlap), 4,
    )
    // The bottom step wall sits at z = 1 and the top one at z = 9.
    const step = (z: number): number => facesOf(r, 'body_ex_plate').filter((face) => {
      const centroid = face.centroid ?? []
      return face.surface_type === 'cylinderface' && (centroid[2] ?? 0) > z - 0.5 && (centroid[2] ?? 0) < z + 0.5
    }).length
    expect(step(1)).toBeGreaterThanOrEqual(1)
    expect(step(9)).toBeGreaterThanOrEqual(1)
  }, 240_000)

  it('uses an earlier hole\'s bore face as the pattern axis', () => {
    // The bore face of a centre hole already resolves as a circular pattern
    // axis (resolvePatternAxis takes a cylindrical face). This pins the reading
    // the hole-as-source feature leans on. A square boss on the plate repeats
    // about the bore, so the only cylinder face on the probe build is the bore.
    const features = (axis?: string): Dict[] => [
      rectSketch('sk_plate', 60, 60, -30, -30),
      extrude('ex_plate', '$sk_plate', 5),
      planeAt('pl_top', 5),
      pointSketch('sk_centre', 0, 0, '@pl_top'),
      hole('h_centre', '$sk_centre', {
        diameter: 10, depth_mode: 'through_all', direction: 'reverse', target: '@body_ex_plate',
      }),
      rectSketch('sk_boss', 4, 4, 8, -2, '@pl_top'),
      extrude('ex_boss', '$sk_boss', 4, 'add'),
      {
        id: 'pt1', kind: 'circular_pattern',
        circular_pattern: {
          subject: 'feature', source_features: ['@ex_boss'], count: 4,
          ...(axis === undefined
            ? { axis_origin: [0, 0, 0], axis_direction: [0, 0, 1] }
            : { axis }),
        },
      },
    ]
    const probe = h.run({ version: 9, kind: 'part', features: features() })
    const mesh = (h.part(probe, 'body_ex_plate') as PartView).mesh
    const index = (mesh?.face_data ?? []).findIndex((face) => face.surface_type === 'cylinderface')
    expect(index).toBeGreaterThanOrEqual(0)
    const query = mesh?.face_queries?.[index] ?? ''

    const r = h.run({ version: 9, kind: 'part', features: features(query) })
    const res = h.res(r, 'pt1')
    expect(res.status, String(res.exception)).toBe('ok')
    // Plate minus the bore, plus the source boss and its three copies: four
    // 4 x 4 x 4 bosses standing at the same 30 mm height.
    expect(volumeAt(r, 'pt1', 'body_ex_plate')).toBeCloseTo(
      60 * 60 * 5 - circleBoreVolume(5, 5) + 4 * (4 * 4 * 4), 4,
    )
    expect(bboxOf(r, 'pt1', 'body_ex_plate').max[2]).toBeCloseTo(9, 4)
  }, 240_000)

  it('refuses a suppressed, reordered or empty hole source with the existing sentences', () => {
    const base = [
      rectSketch('sk_plate', 40, 20),
      extrude('ex_plate', '$sk_plate', 5),
      planeAt('pl_top', 5),
      pointSketch('sk_hole', 10, 10, '@pl_top'),
    ]
    const holeRow = (id: string, over: Dict = {}): Dict => ({
      id, kind: 'hole',
      hole: { sketch: '$sk_hole', diameter: 3, depth_mode: 'through_all', direction: 'reverse', ...over },
    })

    const suppressed = h.run({
      features: [
        ...base,
        { ...holeRow('h1'), suppressed: true },
        pattern('pt1', ['h1'], { mode: 'linear', count: 2, pitch: 10, direction: [1, 0, 0] }),
      ],
    })
    expect(String(h.res(suppressed, 'pt1').exception)).toContain('is suppressed')

    const reordered = h.run({
      features: [
        ...base,
        pattern('pt1', ['h1'], { mode: 'linear', count: 2, pitch: 10, direction: [1, 0, 0] }),
        holeRow('h1'),
      ],
    })
    const reorderedRes = h.res(reordered, 'pt1')
    expect(reorderedRes.status).toBe('exception')
    expect(String(reorderedRes.exception)).toContain('comes after this pattern')
    expect(String(reorderedRes.exception)).toContain('reorder_features')

    // Every site misses the plate. With an explicit target the source resolves
    // and the tool build finds nothing to hand back, which is the existing
    // "produced no solid to repeat" sentence.
    const missed = h.run({
      features: [
        ...base,
        pointSketch('sk_miss', 100, 100, '@pl_top'),
        holeRow('h1', { sketch: '$sk_miss' }),
        pattern('pt1', ['h1'], {
          mode: 'linear', count: 2, pitch: 10, direction: [1, 0, 0], target_body: '@body_ex_plate',
        }),
      ],
    })
    expect(String(h.res(missed, 'pt1').exception)).toContain('produced no solid to repeat')

    // Without a target the hole shaped no body, so the target resolution names
    // that first, with the existing sentence.
    const noTarget = h.run({
      features: [
        ...base,
        pointSketch('sk_miss', 100, 100, '@pl_top'),
        holeRow('h1', { sketch: '$sk_miss' }),
        pattern('pt1', ['h1'], { mode: 'linear', count: 2, pitch: 10, direction: [1, 0, 0] }),
      ],
    })
    expect(String(h.res(noTarget, 'pt1').exception)).toContain('produced no part')
  }, 240_000)

  it('still refuses a sketch or a fillet as a source, naming the hole', () => {
    const sketchSource = h.run({
      features: [
        rectSketch('sk_plate', 10, 10),
        extrude('ex_plate', '$sk_plate', 5),
        pattern('pt1', ['sk_plate'], { mode: 'linear', count: 2, pitch: 10, direction: [1, 0, 0] }),
      ],
    })
    expect(String(h.res(sketchSource, 'pt1').exception))
      .toContain('a feature pattern repeats an extrude, revolve, sweep, wrap or hole')

    const filletSource = h.run({
      features: [
        rectSketch('sk_plate', 10, 10),
        extrude('ex_plate', '$sk_plate', 5),
        { id: 'fi1', kind: 'fillet', fillet: { edges: [], radius: 1 } },
        pattern('pt1', ['fi1'], { mode: 'linear', count: 2, pitch: 10, direction: [1, 0, 0] }),
      ],
    })
    expect(String(h.res(filletSource, 'pt1').exception)).toContain('is a fillet')
    expect(String(h.res(filletSource, 'pt1').exception)).toContain('or hole')
  }, 240_000)
})
