// The selector engine: evaluate a structured predicate over a solved body set
// and return the query strings a click would have stored. Pure TS over the
// solve result, with no OCC import, so it unit-tests without WASM.
//
// `and` narrows sequentially (CadQuery chaining: "|Z" then ">Z"), so an
// `extreme` clause groups the extremes of whatever the earlier clauses left. An
// empty result is an error whose message carries the nearest-miss count per
// predicate and, for a `type` clause, the values present and the full valid
// vocabulary, so an authoring agent can see which clause killed the match.

import type { BodyResult } from '@/types/cad'
import { parseAncestry } from '@/kernel/query'
import { DEFAULT_MEASURE_TOLERANCE, valueWithinTolerance } from '@/kernel/occ/measureTolerance'
import { SelectorError } from './errors'
import {
  bboxOf,
  directionOf,
  dot,
  edgeCandidates,
  faceCandidates,
  geometryOf,
  normalize,
  pointOf,
  radiusOf,
  suggestTypeName,
  typeOf,
  typeVocabulary,
  type Candidate,
} from './geometry'
import type { Predicate, RadiusTest, SelectKind, SelectResult, Selector, Vec3 } from './types'

// Direction tests compare normalized vectors: parallel means the axes coincide,
// perpendicular means they cross at a right angle. The epsilon is an angle
// threshold in disguise (1e-6 is about 0.00006 degrees), tight enough to reject
// a nearby face while absorbing the f64 noise of an exact solve.
const DIRECTION_EPS = 1e-6

export interface EvalContext {
  bodies: Record<string, BodyResult>
  from?: string
}

function isZero(v: Vec3): boolean {
  return v[0] === 0 && v[1] === 0 && v[2] === 0
}

function isParallel(a: Vec3 | null, axis: Vec3): boolean {
  return a !== null && !isZero(a) && Math.abs(dot(a, axis)) > 1 - DIRECTION_EPS
}

function isPerpendicular(a: Vec3 | null, axis: Vec3): boolean {
  // A zero direction or a zero axis has a zero dot against everything, which the
  // `<` test would read as perpendicular to all: refuse both.
  return a !== null && !isZero(a) && !isZero(axis) && Math.abs(dot(a, axis)) < DIRECTION_EPS
}

function radiusMatches(value: number | null, test: RadiusTest): boolean {
  if (value === null) return false
  if (typeof test === 'number') return valueWithinTolerance(value, test)
  if (test.eq !== undefined && !valueWithinTolerance(value, test.eq)) return false
  if (test.min !== undefined && value < test.min - DEFAULT_MEASURE_TOLERANCE.abs) return false
  if (test.max !== undefined && value > test.max + DEFAULT_MEASURE_TOLERANCE.abs) return false
  return true
}

/** Whether an element query's ancestry names `featureId`. The query string is
 *  opaque outside the query engine, so this goes through parseAncestry rather
 *  than any substring test. A non-ancestry or malformed query is a non-match,
 *  never a throw: the query arrays are padded with '' placeholders. */
function createdByMatches(query: string, featureId: string): boolean {
  if (!query.startsWith('?')) return false
  try {
    const [ids] = parseAncestry(query)
    return ids.includes('@' + featureId)
  } catch {
    return false
  }
}

function extremeGroup(spec: { axis: Vec3; side: 'min' | 'max' }, pool: Candidate[]): Candidate[] {
  const axis = normalize(spec.axis)
  const projections = new Map<Candidate, number>()
  for (const c of pool) {
    const point = pointOf(c)
    if (point !== null) projections.set(c, dot(point, axis))
  }
  if (projections.size === 0) return []
  let best = spec.side === 'max' ? -Infinity : Infinity
  for (const v of projections.values()) best = spec.side === 'max' ? Math.max(best, v) : Math.min(best, v)
  return pool.filter(c => {
    const v = projections.get(c)
    return v !== undefined && valueWithinTolerance(v, best)
  })
}

function withinGroup(spec: { axis: 'x' | 'y' | 'z'; min?: number; max?: number }, pool: Candidate[]): Candidate[] {
  const axis = spec.axis === 'x' ? 0 : spec.axis === 'y' ? 1 : 2
  const tol = DEFAULT_MEASURE_TOLERANCE.abs
  return pool.filter(c => {
    const bounds = bboxOf(c)
    if (bounds === null) return false
    // The WHOLE box must sit in the range: an element crossing a boundary is out,
    // even when its centre or one end is in. The tolerance is the same measure
    // tolerance the radius and extreme tests use, so a value authored as the
    // boundary itself is not lost to f64 noise.
    if (spec.min !== undefined && bounds.min[axis] < spec.min - tol) return false
    if (spec.max !== undefined && bounds.max[axis] > spec.max + tol) return false
    return true
  })
}

function onFace(inner: Selector, pool: Candidate[], ctx: EvalContext): Candidate[] {
  if (inner.kind !== 'face') {
    throw new SelectorError('on_face needs a face selector (kind "face")')
  }
  // An inner selector that omits `from` inherits the outer one: "edges bounding
  // this body's faces" is the intended reading when the outer names a body.
  const from = inner.from ?? ctx.from
  const faceSelector: Selector = {
    kind: 'face',
    ...(from !== undefined && { from }),
    ...(inner.where !== undefined && { where: inner.where }),
  }
  const faces = runSelector(faceSelector, ctx.bodies)
  const boundary = new Set<string>()
  for (const face of faces) {
    const faceEdges = ctx.bodies[face.bodyId]?.mesh?.face_edge_queries?.[face.index]
    if (faceEdges) for (const q of faceEdges) boundary.add(q)
  }
  return pool.filter(c => c.kind === 'edge' && boundary.has(c.query))
}

function evaluate(p: Predicate, pool: Candidate[], ctx: EvalContext): Candidate[] {
  if ('and' in p) {
    let current = pool
    for (const child of p.and) current = evaluate(child, current, ctx)
    return current
  }
  if ('or' in p) {
    const matched = new Set<Candidate>()
    for (const child of p.or) for (const c of evaluate(child, pool, ctx)) matched.add(c)
    return pool.filter(c => matched.has(c))
  }
  if ('not' in p) {
    const rejected = new Set(evaluate(p.not, pool, ctx))
    return pool.filter(c => !rejected.has(c))
  }
  if ('parallel' in p) {
    const axis = normalize(p.parallel)
    return pool.filter(c => isParallel(directionOf(c), axis))
  }
  if ('perpendicular' in p) {
    const axis = normalize(p.perpendicular)
    return pool.filter(c => isPerpendicular(directionOf(c), axis))
  }
  if ('type' in p) return pool.filter(c => typeOf(c) === p.type)
  if ('extreme' in p) return extremeGroup(p.extreme, pool)
  if ('within' in p) return withinGroup(p.within, pool)
  if ('on_face' in p) return onFace(p.on_face, pool, ctx)
  if ('created_by' in p) return pool.filter(c => createdByMatches(c.query, p.created_by))
  return pool.filter(c => radiusMatches(radiusOf(c), p.radius))
}

function label(p: Predicate): string {
  if ('parallel' in p) return `parallel [${p.parallel.join(', ')}]`
  if ('perpendicular' in p) return `perpendicular [${p.perpendicular.join(', ')}]`
  if ('type' in p) return `type "${p.type}"`
  // The whole clause, not an abbreviation: an author copies it back to fix it.
  if ('extreme' in p) return `extreme ${JSON.stringify(p.extreme)}`
  if ('within' in p) return `within ${JSON.stringify(p.within)}`
  if ('on_face' in p) return `on_face {${p.on_face.kind}}`
  if ('created_by' in p) return `created_by "${p.created_by}"`
  if ('radius' in p) return `radius ${JSON.stringify(p.radius)}`
  if ('not' in p) return 'not(...)'
  if ('and' in p) return 'and(...)'
  return 'or(...)'
}

/** Per-predicate nearest-miss counts. For a top-level `and` this walks the
 *  clauses in order, each measured against the set the previous clause left;
 *  every other shape reports one count over the incoming pool. The later
 *  clauses are phrased "then ... left M of N" so a count is not read as the
 *  clause's match over the whole pool: `within x min 140 matched 0` read as
 *  independent while that predicate alone matched 30 (kcl enclosure F3). */
function diagnose(p: Predicate, pool: Candidate[], ctx: EvalContext, kind: SelectKind): string[] {
  if ('and' in p) {
    const out: string[] = []
    let current = pool
    p.and.forEach((child, index) => {
      const matched = evaluate(child, current, ctx)
      const lines = describeOne(child, current, matched.length, ctx, kind)
      out.push(...(index === 0 ? lines : lines.map(line => thenLine(line, child, matched.length, current.length))))
      current = matched
    })
    return out
  }
  return describeOne(p, pool, evaluate(p, pool, ctx).length, ctx, kind)
}

/** A later `and` clause's line: what it left of what the earlier ones kept. */
function thenLine(line: string, p: Predicate, matched: number, of: number): string {
  const head = `${label(p)} matched ${matched}`
  // A line the head does not open (never today) keeps its own text whole.
  if (!line.startsWith(head)) return `then ${line}`
  return `then ${label(p)} left ${matched} of ${of}${line.slice(head.length)}`
}

/** A `type` clause that matched nothing also names the values it could have
 *  used: the ones present on the candidates and the full vocabulary for the
 *  kind. An unknown name also gets the closest vocabulary spelling, so one call
 *  fixes a wrong guess instead of a nearest-miss count. */
function typeDetail(p: { type: string }, pool: Candidate[], kind: SelectKind): string {
  const present = [...new Set(pool.map(typeOf).filter((t): t is string => t !== null))].sort()
  const valid = typeVocabulary(kind)
  const noun = kind === 'edge' ? 'edge kinds' : 'face types'
  const suggestion = suggestTypeName(p.type, kind)
  const hint = suggestion === null ? '' : `; did you mean "${suggestion}"?`
  return `${label(p)} matched 0${hint}; present ${noun}: ${present.join(', ') || 'none'}; valid ${noun}: ${valid.join(', ')}`
}

function describeOne(p: Predicate, pool: Candidate[], matched: number, ctx: EvalContext, kind: SelectKind): string[] {
  if ('and' in p) return diagnose(p, pool, ctx, kind)
  if ('type' in p && matched === 0) return [typeDetail(p, pool, kind)]
  return [`${label(p)} matched ${matched}`]
}

function emptyError(selector: Selector, pool: Candidate[], ctx: EvalContext): SelectorError {
  const what = selector.kind === 'edge' ? 'edges' : 'faces'
  const details = selector.where ? diagnose(selector.where, pool, ctx, selector.kind) : ['no candidates']
  const count = `${pool.length} candidate${pool.length === 1 ? '' : 's'}`
  return new SelectorError(`selector matched no ${what} (${count}: ${details.join(', ')})`)
}

function candidatesFor(selector: Selector, bodies: Record<string, BodyResult>): Candidate[] {
  if (selector.from !== undefined && !(selector.from in bodies)) {
    throw new SelectorError(`no body named "${selector.from}"`)
  }
  return selector.kind === 'edge'
    ? edgeCandidates(bodies, selector.from)
    : faceCandidates(bodies, selector.from)
}

/** Run a selector, throwing SelectorError with diagnostics on an empty match. */
function runSelector(selector: Selector, bodies: Record<string, BodyResult>): Candidate[] {
  const ctx: EvalContext = { bodies, ...(selector.from !== undefined && { from: selector.from }) }
  const pool = candidatesFor(selector, bodies)
  const out = selector.where ? evaluate(selector.where, pool, ctx) : pool
  if (out.length === 0) throw emptyError(selector, pool, ctx)
  return out
}

/**
 * Select faces or edges by predicate over a solved body set. Returns the
 * queries to store plus a per-item geometry summary, in deterministic order
 * (body id sorted, then face/edge index). Throws SelectorError on an invalid
 * expression or an empty match.
 */
export function selectByPredicate(selector: Selector, bodies: Record<string, BodyResult>): SelectResult {
  const candidates = runSelector(selector, bodies)
  const items = candidates.map(c => ({
    query: c.query,
    kind: c.kind,
    body: c.bodyId,
    index: c.index,
    geometry: geometryOf(c),
  }))
  return { queries: items.map(i => i.query), items }
}
