// The enclosure practice repro, rebuilt from its finding text (plan
// bug-fillet-end-cap-sliver; run 06_other_text_cad__kcl-samples__enclosure__main.kcl,
// report F1).
//
// A 40 x 30 x 3 plate on Top with its four upright edges rounded r12, then a
// 34 x 24 lip inset 3 on a plane 3 further out, extruded 3 and added. The lip's
// sharp corner lies 0.73 outside the plate's r12 outline, so each lip corner
// overhangs the plate and its underside is a small triangle whose legs are
// 9 - sqrt(63) = 1.0627 long. That triangle is the end face the lip edge ends
// on.
//
// The app's Top plane normal points away from the viewer (an extrude of
// distance 3 leaves the sketch plane in that direction), so "3 along the normal"
// is an offset of -3: the lip then sits on the plate's outer face, which is
// where the reported overhang lives.

import type { SharedHarness } from '../../occ/sharedHarness'
import type { Body } from '../../types3d'

type Dict = Record<string, unknown>

export const PLATE_W = 40
export const PLATE_H = 30
export const PLATE_T = 3
export const PLATE_CORNER_R = 12
export const LIP_INSET = 3
export const LIP_T = 3
/** The lip fillet the practice run asks for; its arc is concentric with the
 *  plate's r12 corner, 3 inside it. */
export const LIP_RADIUS = 9
/** The overhang triangle's leg: where the plate's r12 arc crosses the lip side. */
export const END_FACE_LEG =
  PLATE_CORNER_R - LIP_INSET -
  Math.sqrt(PLATE_CORNER_R ** 2 - (PLATE_CORNER_R - LIP_INSET) ** 2)
/** The volume one r9 corner blend removes: the corner square minus its quarter disc. */
export const CORNER_CUT_VOLUME = (1 - Math.PI / 4) * LIP_RADIUS ** 2 * LIP_T

/** A constrained rectangle sketch on `plane`, from (x0, y0) to (x0+w, y0+h) in
 *  the plane's own uv frame. */
export function rectSketch(
  sketchId: string,
  w: number,
  h: number,
  plane = '@builtin_plane_top',
  x0 = 0,
  y0 = 0,
): Dict {
  return {
    id: sketchId, kind: 'sketch', label: 'Rectangle', plane,
    entities: [
      { id: 'bottom', kind: 'line' }, { id: 'right', kind: 'line' },
      { id: 'top', kind: 'line' }, { id: 'left', kind: 'line' },
    ],
    initial: {
      bottom: [x0, y0, x0 + w, y0], right: [x0 + w, y0, x0 + w, y0 + h],
      top: [x0 + w, y0 + h, x0, y0 + h], left: [x0, y0 + h, x0, y0],
    },
    constraints: [
      { id: 'c1', kind: 'coincident', a: { entity: 'bottom', point: 'end' }, b: { entity: 'right', point: 'start' } },
      { id: 'c2', kind: 'coincident', a: { entity: 'right', point: 'end' }, b: { entity: 'top', point: 'start' } },
      { id: 'c3', kind: 'coincident', a: { entity: 'top', point: 'end' }, b: { entity: 'left', point: 'start' } },
      { id: 'c4', kind: 'coincident', a: { entity: 'left', point: 'end' }, b: { entity: 'bottom', point: 'start' } },
      { id: 'c5', kind: 'horizontal', target: { entity: 'bottom' } },
      { id: 'c6', kind: 'horizontal', target: { entity: 'top' } },
      { id: 'c7', kind: 'vertical', target: { entity: 'right' } },
      { id: 'c8', kind: 'vertical', target: { entity: 'left' } },
      { id: 'c9', kind: 'length', target: { entity: 'bottom' }, value: w },
      { id: 'c10', kind: 'length', target: { entity: 'left' }, value: h },
    ],
  }
}

/** The plate alone: the body every variant starts from (r12 corners optional). */
export function plateSpec(withCornerFillet = true): { features: Dict[] } {
  return { features: [
    rectSketch('sk1', PLATE_W, PLATE_H),
    { id: 'ex1', kind: 'extrude', sketch: '$sk1', distance: PLATE_T, direction: 'normal', operation: 'new' },
    ...(withCornerFillet ? [{ id: 'fi1', kind: 'fillet', fillet: { edges: [], radius: PLATE_CORNER_R } }] : []),
  ]}
}

/** The lip: a plane 3 further out, its rectangle inset 3, extruded 3 and added. */
export function lipFeatures(taper = 0): Dict[] {
  return [
    { id: 'pl1', kind: 'plane', definition: { mode: 'offset', plane: '@builtin_plane_top', offset: -LIP_INSET } },
    rectSketch('sk2', PLATE_W - 2 * LIP_INSET, PLATE_H - 2 * LIP_INSET, '@pl1', LIP_INSET, LIP_INSET),
    {
      id: 'ex2', kind: 'extrude', sketch: '$sk2', distance: LIP_T, direction: 'normal', operation: 'add',
      ...(taper !== 0 ? { taper } : {}),
    },
  ]
}

/** The upright edges of one rectangular body in a build's edge queries: the
 *  ones whose query names two of that sketch's lines and a z classifier. The
 *  alias index and the edge data are not index-aligned, so the query text is
 *  the reliable handle. */
export function uprightEdges(queries: string[], sketch: string): string[] {
  const token = new RegExp(`@${sketch}/`, 'g')
  return queries.filter((q) => (q.match(token) ?? []).length === 2 && /@cls_z/.test(q))
}

/** The plate with r12 corners and the lip added: the state every case starts
 *  from. Returns the spec (so a case can append its own fillet) and the four lip
 *  edge queries. */
export function enclosureBase(
  h: SharedHarness,
  opts: { cornerFillet?: boolean; taper?: number } = {},
): { spec: { features: Dict[] }; lipEdges: string[]; result: ReturnType<SharedHarness['run']> } {
  const spec = plateSpec(opts.cornerFillet ?? true)
  const plate = h.run(spec)
  const fillet = spec.features.find((f) => f.id === 'fi1')
  let withPlate = plate
  if (fillet !== undefined) {
    const plateEdges = uprightEdges((h.body(plate, 'body_ex1').edge_queries as string[]) ?? [], 'sk1')
    if (plateEdges.length !== 4) throw new Error(`enclosure fixture: expected 4 plate upright edges, found ${plateEdges.length}`)
    ;(fillet.fillet as Dict).edges = plateEdges
    withPlate = h.run(spec)
  }
  if (((h.body(withPlate, 'body_ex1').edge_queries as string[]) ?? []).length === 0) {
    throw new Error('enclosure fixture: the plate carried no edges')
  }
  spec.features.push(...lipFeatures(opts.taper ?? 0))
  const added = h.run(spec)
  const lipEdges = uprightEdges((h.body(added, 'body_ex1').edge_queries as string[]) ?? [], 'sk2')
  if (lipEdges.length !== 4) throw new Error(`enclosure fixture: expected 4 lip upright edges, found ${lipEdges.length}`)
  return { spec, lipEdges, result: added }
}

/** The Body a build checkpoint holds for `bodyId`, which carries its shape
 *  handle and its construction names. */
export function bodyAt(
  result: ReturnType<SharedHarness['run']>,
  featureId: string,
  bodyId = 'body_ex1',
): Body {
  const body = result._build_state!.checkpoints[featureId]?.body_store_snapshot[bodyId]
  if (body === undefined) throw new Error(`enclosure fixture: no ${bodyId} at checkpoint ${featureId}`)
  return body
}
