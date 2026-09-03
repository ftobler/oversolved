// Construction-by-name identity (query-naming-by-construction).
//
// Every produced face/edge/vertex gets a stable UUID derived from HOW it was
// constructed (feature ids, sketch entity ids, cap roles, parent UUIDs, split
// indices) -- never from where it sits in space. Because the ingredients are
// symbolic and never floats, the UUID recomputes to the same value on every
// rebuild, so a persisted query token still matches after a reload+rebuild.
//
// The only geometry that survives is the split-sibling tie-break in
// `orderSplitChildren`: when one parent face/edge genuinely splits into children
// with identical ancestry, their arrangement in the parent's OWN (normalized)
// frame deterministically sorts them into stable integer indices. That relative
// key is used once at mint time and never stored or emitted.

import { sha256Hex } from './sha256'

// Prefixes distinguish the three element kinds inside a token; they are opaque
// to consumers (the resolver keys on the whole string).
export const FACE_UUID_PREFIX = 'u_'
export const EDGE_UUID_PREFIX = 'e_'
export const VERTEX_UUID_PREFIX = 'v_'

// Two split siblings whose relative sort keys fall within this window are a
// near-tie: `orderSplitChildren` refuses to order them (fail-safe over
// fail-wrong) and the caller lets the ancestral path carry recovery.
//
// Dimensionless: every key convention normalizes by its own characteristic
// length first (`faceSplitKey` by sqrt(face area), edges/vertices/corners and
// body split by the parent AABB span), so the epsilon is one dimensionless
// fraction per convention (1e-3 = 0.1% of that convention's own characteristic
// length), internally consistent and resize-invariant -- never an absolute
// world-unit distance. A uniform parent resize cancels exactly.
export const SPLIT_EPS = 1e-3

function shortHash(s: string): string {
  return sha256Hex(s).slice(0, 16)
}

// ─── path grammar (symbolic only, never a float) ───

/** A side face generated from one profile edge: `<createdBy>|side|<entityId>`. */
export function sideFacePath(createdBy: string, sketchEntityId: string): string {
  return `${createdBy}|side|${sketchEntityId}`
}

/** A sweep cap (start = sketch side, end = swept-to side). */
export function capFacePath(createdBy: string, which: 'start' | 'end'): string {
  return `${createdBy}|cap|${which}`
}

/** A fillet/chamfer face generated on one edge: `<createdBy>|fillet|<edgeUuid>`. */
export function filletFacePath(createdBy: string, filletedEdgeUuid: string): string {
  return `${createdBy}|fillet|${filletedEdgeUuid}`
}

/**
 * A child face that split off a parent face during a boolean/modifier op. The
 * integer `index` is assigned by `orderSplitChildren`, so two rebuilds of the
 * same split produce the same index and therefore the same UUID.
 */
export function splitFacePath(parentUuid: string, index: number): string {
  return `${parentUuid}|split|${index}`
}

/**
 * An imported face, named by the STEP entity id (`#17=ADVANCED_FACE(...)`) the
 * file gave it. Imported geometry has no construction history in THIS system,
 * but it has one in the file, and that id is symbolic: it survives a rebuild and
 * a rescale. `createdBy` keeps two imports of the same file (two `import_step`
 * features) in disjoint UUID namespaces.
 *
 * The entity id alone is NOT unique within a file: a repeated assembly instance
 * (the same part placed twice) shares its TShape, so both copies carry the same
 * `ADVANCED_FACE` entities. `importedInstanceFacePath` adds the per-solid index
 * for exactly that case.
 */
export function importedFacePath(createdBy: string, stepEntityId: number): string {
  return `${createdBy}|step|${stepEntityId}`
}

/**
 * An imported face inside ONE `import_step` feature that produced several
 * solids. The `solidIndex` is the bodySplit solid order (features/bodySplit.ts),
 * the same order `registerSplitBodies` hands out as `body_x_1`, `body_x_2`, ...
 * A shared STEP entity id (a repeated instance) therefore lands in a disjoint
 * UUID namespace per placement, so the resolver's UUID tier no longer sees a
 * "collision by construction" on every pick. Index 0 is exactly
 * `importedFacePath`, so a single-solid import stays byte-identical to before.
 */
export function importedInstanceFacePath(createdBy: string, stepEntityId: number, solidIndex: number): string {
  const base = importedFacePath(createdBy, stepEntityId)
  return solidIndex > 0 ? `${base}|${solidIndex}` : base
}

/**
 * A face that inherited a tool face's UUID where that UUID is claimed by more
 * than one live face, so the copy needs an identity of its own. Two ways that
 * happens: the boolean KEPT its tool (`keep_tools`), which survives as a body
 * still holding the original, and a cut that reaches several target bodies,
 * which hands one tool's names to each of them. Either way the resolver's UUID
 * tier would refuse every such face with "collision by construction"; scoping
 * the copy under whatever makes it distinct -- the boolean, or the body it
 * landed on -- gives it a stable identity instead, the same move
 * `arrayInstancePath` makes for array copies. The uncontested copy keeps the
 * UUID verbatim, so an ordinary single-target cut names its walls exactly as
 * it always has.
 */
export function toolCopyFacePath(toolFaceUuid: string, scope: string): string {
  return `${toolFaceUuid}|toolcopy|${scope}`
}

/**
 * An instance of a source face produced by an array/transform copy operation.
 * The source face's UUID is the parent; the copy feature id and instance index
 * make the construction path unique across identical transformed copies, so
 * edges on different array instances do not share a query.
 */
export function arrayInstancePath(parentUuid: string, featureId: string, index: number): string {
  return `${parentUuid}|array|${featureId}|${index}`
}

// ─── minting ───

/** Mint a face UUID from a symbolic construction path string. */
export function mintFaceUuid(path: string): string {
  return FACE_UUID_PREFIX + shortHash(path)
}

/**
 * An edge is the intersection of two faces, so its identity is the (unordered)
 * pair of adjacent face UUIDs. `multiplicity` disambiguates the rare case of two
 * faces sharing more than one edge; index 0 (the default) carries no suffix, so
 * a pair that gains a second shared edge keeps edge 0's UUID stable.
 */
export function deriveEdgeUuid(faceUuidA: string, faceUuidB: string, multiplicity = 0): string {
  const [a, b] = [faceUuidA, faceUuidB].sort()
  const base = `${a}|${b}`
  const path = multiplicity > 0 ? `${base}|${multiplicity}` : base
  return EDGE_UUID_PREFIX + shortHash(path)
}

/**
 * A seam edge lies on a single face (e.g. a cylinder's lateral seam), so it has
 * no face pair to derive from. Its identity is that one face's UUID plus a
 * `|seam` role marker, so the path can never collide with a two-face edge path
 * (which is always `uuidA|uuidB` with distinct halves). `multiplicity` orders
 * the rare case of one face carrying more than one seam edge.
 */
export function deriveSeamEdgeUuid(faceUuid: string, multiplicity = 0): string {
  const base = `${faceUuid}|seam`
  const path = multiplicity > 0 ? `${base}|${multiplicity}` : base
  return EDGE_UUID_PREFIX + shortHash(path)
}

/**
 * A face no producer could name -- typically the corner patch a fillet grows
 * where several blend faces meet, which OCC generates from a VERTEX rather than
 * from any filleted edge. Its identity is the (unordered) set of its named
 * neighbour faces, mirroring `deriveVertexUuid`. The `|corner` marker keeps the
 * path out of the vertex namespace, which uses the bare joined set.
 */
export function deriveCornerFaceUuid(neighbourUuids: string[], multiplicity = 0): string {
  const sorted = [...new Set(neighbourUuids)].sort()
  const base = `${sorted.join('|')}|corner`
  const path = multiplicity > 0 ? `${base}|${multiplicity}` : base
  return FACE_UUID_PREFIX + shortHash(path)
}

/**
 * A vertex is where >=3 faces meet, so its identity is the (unordered) set of
 * adjacent face UUIDs. `multiplicity` handles >1 vertex per face set, mirroring
 * `deriveEdgeUuid`.
 */
export function deriveVertexUuid(faceUuids: string[], multiplicity = 0): string {
  const sorted = [...new Set(faceUuids)].sort()
  const base = sorted.join('|')
  const path = multiplicity > 0 ? `${base}|#${multiplicity}` : base
  return VERTEX_UUID_PREFIX + shortHash(path)
}

// ─── split-sibling ordering (the confined geometry) ───

/** A split child paired with its sort key in the parent's normalized frame. */
export interface SplitChild<T> {
  item: T
  // Sort key: `[u, v]` in the parent face's [0,1]^2 frame, or `[t]` along a
  // parent edge, or a topological side index. All components are relative +
  // normalized so a uniform parent resize cancels.
  key: number[]
}

function keyLess(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    if (av < bv) return -1
    if (av > bv) return 1
  }
  return 0
}

function keyDistance(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length)
  let maxd = 0
  for (let i = 0; i < n; i++) {
    const d = Math.abs((a[i] ?? 0) - (b[i] ?? 0))
    if (d > maxd) maxd = d
  }
  return maxd
}

/**
 * Deterministically order split siblings by their relative position in the
 * parent's own frame, returning the items sorted stably. Returns `null` (a
 * refusal) when any two siblings sort within `SPLIT_EPS`: an ambiguous order
 * must not silently pick wrong, so the caller assigns no split UUID and lets
 * the ancestral path recover.
 */
export function orderSplitChildren<T>(children: SplitChild<T>[]): T[] | null {
  if (children.length === 0) return []
  // A NaN component is a geometry-read failure. NaN sorts as equal in keyLess and
  // keyDistance ignores it (NaN > maxd is false), so without this gate a broken key
  // silently lands on stable-sort insertion order -- OCC explorer order by another
  // name. Refuse the whole group instead.
  for (const c of children) {
    if (c.key.some((k) => Number.isNaN(k))) return null
  }
  const sorted = [...children].sort((x, y) => keyLess(x.key, y.key))
  // Check every pair, not just adjacent ones: keyDistance nearness is a max
  // over components while keyLess sorts lexicographically, so a near-tied pair
  // can sit non-adjacent with a third key interleaving between them. That
  // escape left an ambiguous order silently assigned. O(n^2) is fine for the
  // small sibling counts that reach here.
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (keyDistance(sorted[i].key, sorted[j].key) < SPLIT_EPS) return null
    }
  }
  return sorted.map((c) => c.item)
}
