// Sketch profiles the pattern_entities suites share: the document-write test
// counts their entities and constraints, the real-kernel test extrudes them,
// and both need the same numbers.

import type { PartConstraint, PartEntityDef } from '@/types/cad'

export interface ProfileBlocks {
  entities: PartEntityDef[]
  initial: Record<string, number[]>
  constraints: PartConstraint[]
}

/**
 * A rounded-rectangle tooth (4 lines plus 4 tangent corner arcs) with its
 * lower-left corner at (x0, y0), joined by 8 coincidents. `prefix` keeps the
 * ids of several hand-authored teeth apart. Its area is
 * w * h - (4 - pi) * r^2.
 */
export function roundedRectProfile(
  prefix: string, x0: number, y0: number, w: number, h: number, r: number,
): ProfileBlocks {
  const id = (s: string) => `${prefix}${s}`
  const initial: Record<string, number[]> = {
    [id('b')]: [x0 + r, y0, x0 + w - r, y0],
    [id('r')]: [x0 + w, y0 + r, x0 + w, y0 + h - r],
    [id('t')]: [x0 + w - r, y0 + h, x0 + r, y0 + h],
    [id('l')]: [x0, y0 + h - r, x0, y0 + r],
    [id('a1')]: [x0 + r, y0 + r, r, 180, 270],
    [id('a2')]: [x0 + w - r, y0 + r, r, 270, 360],
    [id('a3')]: [x0 + w - r, y0 + h - r, r, 0, 90],
    [id('a4')]: [x0 + r, y0 + h - r, r, 90, 180],
  }
  const entities: PartEntityDef[] = ['b', 'r', 't', 'l'].map(s => ({ id: id(s), kind: 'line' }))
    .concat(['a1', 'a2', 'a3', 'a4'].map(s => ({ id: id(s), kind: 'arc' })))
  const joints: [string, string][] = [
    ['a1end', 'bstart'], ['bend', 'a2start'], ['a2end', 'rstart'], ['rend', 'a3start'],
    ['a3end', 'tstart'], ['tend', 'a4start'], ['a4end', 'lstart'], ['lend', 'a1start'],
  ]
  const constraints: PartConstraint[] = joints.map(([a, b], i) => ({
    id: `${prefix}k${i}`, kind: 'coincident', a: `$${prefix}${a}`, b: `$${prefix}${b}`,
  }))
  return { entities, initial, constraints }
}

export const roundedRectArea = (w: number, h: number, r: number): number => w * h - (4 - Math.PI) * r * r

/** A slot (2 lines plus 2 end arcs) of overall length `length` and width
 *  `width`, centred at (cx, cy) along X: build123d's SlotOverall. Its area is
 *  (length - width) * width + pi * (width / 2)^2. */
export function slotProfile(prefix: string, cx: number, cy: number, length: number, width: number): ProfileBlocks {
  const r = width / 2
  const half = (length - width) / 2
  const id = (s: string) => `${prefix}${s}`
  const initial: Record<string, number[]> = {
    [id('lo')]: [cx - half, cy - r, cx + half, cy - r],
    [id('hi')]: [cx + half, cy + r, cx - half, cy + r],
    [id('ar')]: [cx + half, cy, r, 270, 450],
    [id('al')]: [cx - half, cy, r, 90, 270],
  }
  const entities: PartEntityDef[] = [
    { id: id('lo'), kind: 'line' }, { id: id('hi'), kind: 'line' },
    { id: id('ar'), kind: 'arc' }, { id: id('al'), kind: 'arc' },
  ]
  const constraints: PartConstraint[] = [
    { id: `${prefix}k0`, kind: 'coincident', a: `$${prefix}loend`, b: `$${prefix}arstart` },
    { id: `${prefix}k1`, kind: 'coincident', a: `$${prefix}arend`, b: `$${prefix}histart` },
    { id: `${prefix}k2`, kind: 'coincident', a: `$${prefix}hiend`, b: `$${prefix}alstart` },
    { id: `${prefix}k3`, kind: 'coincident', a: `$${prefix}alend`, b: `$${prefix}lostart` },
  ]
  return { entities, initial, constraints }
}

export const slotArea = (length: number, width: number): number =>
  (length - width) * width + Math.PI * (width / 2) ** 2

/** Several profiles merged into one sketch's three lists. */
export function mergeProfiles(...profiles: ProfileBlocks[]): ProfileBlocks {
  return {
    entities: profiles.flatMap(p => p.entities),
    initial: Object.assign({}, ...profiles.map(p => p.initial)),
    constraints: profiles.flatMap(p => p.constraints),
  }
}
