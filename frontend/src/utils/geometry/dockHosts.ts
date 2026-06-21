// PURE -- no React, no Three, no doc mutation. Dock emit for lazy inferred
// materialization. A "dockable host" is a constraint with an *implied* contact
// not already an explicit operand: today a `tangent(A, B)`, whose foot is where A
// and B touch. This module enumerates those hosts and computes each contact
// location from the current solved params. The location seeds a snap/pick target
// carrying a transient `dock:<featureId>:<hostId>` handle; referencing that handle
// materializes a real point (see `applyAddDock` and the dock interception in
// `applyAddConstraint`).
//
// The location is re-derived every frame and never compared across solves, so an
// approximate-but-correct foot is all that is needed -- the dock lowering pins the
// materialized point exactly via dual locus. Node-unit-testable; the math is kept
// dependency-free so it ports to Rust as a clean lift.

import type { PartConstraint, PartEntityDef } from '@/types/cad'
import { VERTEX_POINT_KEYS } from '@/types/vertexKeys'

export interface DockHost {
  hostId: string
  hostKind: string  // the host constraint kind, e.g. 'tangent'
  at: [number, number]
}

interface Geo {
  kind: string
  p: number[]
}

/** Resolve an entity-only constraint operand (`$eid` or `{entity}`) to its entity
 *  id. Tolerates a vertex-keyed operand (`$eidstart` / `{entity, point}`) by
 *  stripping the key -- a tangent names whole curves, but being lenient keeps the
 *  resolver reusable for future dockable hosts. */
function refEntityId(ref: unknown, knownIds: Set<string>): string | null {
  if (ref && typeof ref === 'object') {
    const e = (ref as { entity?: unknown }).entity
    return typeof e === 'string' && knownIds.has(e) ? e : null
  }
  if (typeof ref !== 'string' || !ref.startsWith('$')) return null
  const bare = ref.slice(1)
  if (knownIds.has(bare)) return bare
  for (const key of VERTEX_POINT_KEYS) {
    if (bare.length > key.length && bare.endsWith(key)) {
      const eid = bare.slice(0, -key.length)
      if (knownIds.has(eid)) return eid
    }
  }
  return null
}

function center(g: Geo): [number, number] | null {
  return g.kind === 'circle' || g.kind === 'arc' ? [g.p[0], g.p[1]] : null
}

/** Foot of the perpendicular from `pt` onto the infinite line through `line`. */
function projectOnLine(pt: [number, number], line: Geo): [number, number] {
  const [ax, ay, bx, by] = line.p
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-18) return [ax, ay]
  const t = ((pt[0] - ax) * dx + (pt[1] - ay) * dy) / len2
  return [ax + t * dx, ay + t * dy]
}

/** Contact point of a tangency between two curves, from solved params:
 *  - line & circle/arc -> the foot of perpendicular from the centre onto the line
 *    (the point on the line nearest the centre, which is exactly the tangent point);
 *  - circle/arc & circle/arc -> the point on A toward B's centre, `cA + rA * û`.
 *    This is correct for both external and internal tangency.
 *  Returns null when neither operand carries a usable contact (e.g. line/line). */
export function tangentFoot(a: Geo, b: Geo): [number, number] | null {
  const ca = center(a), cb = center(b)
  if (a.kind === 'line' && cb) return projectOnLine(cb, a)
  if (b.kind === 'line' && ca) return projectOnLine(ca, b)
  if (ca && cb) {
    const dx = cb[0] - ca[0], dy = cb[1] - ca[1]
    const d = Math.hypot(dx, dy)
    if (d < 1e-12) return ca  // concentric: degenerate, fall back to the centre
    const ra = a.p[2]
    return [ca[0] + ra * dx / d, ca[1] + ra * dy / d]
  }
  return null
}

/** Compute the contact location of a single dockable host by id, from solved
 *  params. Unlike `dockHostsOf` this does NOT skip already-materialized hosts --
 *  the materialize interception needs the foot whether or not a dock exists yet
 *  (idempotent reuse ignores the seed, but the seed is still required for the
 *  not-yet-docked case). Returns null when the host is not a resolvable tangent. */
export function dockLocationOf(
  entities: PartEntityDef[],
  constraints: PartConstraint[],
  params: Record<string, number[]>,
  hostId: string,
): [number, number] | null {
  const host = constraints.find(c => c.id === hostId)
  if (!host || host.kind !== 'tangent') return null
  const known = new Set(entities.map(e => e.id))
  const kindOf = new Map(entities.map(e => [e.id, e.kind]))
  const ea = refEntityId(host.a, known), eb = refEntityId(host.b, known)
  if (!ea || !eb) return null
  const pa = params[ea], pb = params[eb]
  if (!pa || !pb) return null
  return tangentFoot({ kind: kindOf.get(ea)!, p: pa }, { kind: kindOf.get(eb)!, p: pb })
}

/** Enumerate the dockable hosts of a sketch with their contact locations. Hosts
 *  already materialized (a `dock` constraint names them) are omitted -- the real
 *  point covers them, so re-emitting the dock target would double up the snap. */
export function dockHostsOf(
  entities: PartEntityDef[],
  constraints: PartConstraint[],
  params: Record<string, number[]>,
): DockHost[] {
  const docked = new Set<string>()
  for (const c of constraints) {
    if (c.kind === 'dock' && typeof c.host === 'string') docked.add(c.host)
  }
  const out: DockHost[] = []
  for (const c of constraints) {
    if (c.kind !== 'tangent' || !c.id || docked.has(c.id)) continue
    const at = dockLocationOf(entities, constraints, params, c.id)
    if (!at) continue
    out.push({ hostId: c.id, hostKind: 'tangent', at })
  }
  return out
}
