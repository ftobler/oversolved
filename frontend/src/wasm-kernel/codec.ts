/**
 * Flat typed-array codec for the Rust sketch solver (WASM kernel migration,
 * phase 1). This MUST stay byte-for-byte in sync with `sketch-solver/src/codec.rs`;
 * the Rust crate is the canonical definition and its tests lock the layout.
 *
 * Everything is little-endian. See codec.rs for the full layout documentation.
 */

export const Kind = { Line: 0, Circle: 1, Arc: 2, Point: 3, Ellipse: 4, Spline: 5, FitSpline: 6 } as const

export const ConstraintKindCode: Record<string, number> = {
  horizontal: 0,
  vertical: 1,
  length: 2,
  radius: 3,
  diameter: 4,
  line_distance: 5,
  coincident: 6,
  normal: 7,
  parallel: 8,
  angle: 9,
  tangent: 10,
  equal_length: 11,
  point_distance: 12,
  midpoint: 13,
  concentric: 14,
  fixed: 15,
  radius_difference: 16,
  point_distance_x: 17,
  point_distance_y: 18,
}

export const Role = {
  target: 0,
  a: 1,
  b: 2,
  line: 3,
  arc: 4,
  point: 5,
  point_a: 6,
  point_b: 7,
} as const

export const Sel = {
  absent: 0, start: 1, end: 2, center: 3, xy: 4,
  // Ellipse axis endpoints (control points), mirroring PointSelector in
  // sketch-solver/src/constraints.rs.
  major: 5, majorNeg: 6, minor: 7, minorNeg: 8,
  // Spline off-curve control points P2/P3.
  c1: 9, c2: 10,
} as const

/** Interior fit-point selectors: `fit<k>` is wire code `32 + k` for
 *  `1 <= k <= 62`. 32 itself is unused because `Fit(0)` is `start` and the last
 *  point is `end`. Mirrors `PointSelector::Fit` in the Rust constraints. */
export const FIT_SELECTOR_BASE = 32

export function fitSelectorCode(k: number): number {
  return FIT_SELECTOR_BASE + k
}

export const AxisCode: Record<string, number> = { x: 0, y: 1, both: 2 }

export const Status = { fully_constrained: 0, underconstrained: 1, overconstrained: 2 } as const

/** Index -> status string, the inverse of the Rust `Status::to_u8`. */
export const STATUS_NAME = ['fully_constrained', 'underconstrained', 'overconstrained'] as const

/** Bits of a per-constraint verdict byte, mirroring `CONSTRAINT_FLAG_*` in
 *  sketch-solver/src/lib.rs. One byte per input constraint, in wire order. */
export const CONSTRAINT_FLAG = {
  /** Every Jacobian row of the constraint already lies in the span of the
   *  earlier constraints': a measurement, not a driver. */
  redundant: 1 << 0,
  /** The constraint never reached the residual stack: a stale ref or an
   *  operand kind its builder cannot read. The sketch reports it instead of
   *  letting it vanish. */
  dropped: 1 << 1,
} as const

// Rev 7 of the wire layout. `SKG6`/`SKR6` carry the dropped verdict bit: the
// byte layout is unchanged but the meaning of `constraint_flags` grew, and an
// older solver would read a dropped constraint as unflagged. `SKG5` added the
// header's storage quantum; `SKR5` added the per-entity moved bitmask before
// the diagnostics. The entity record itself is unchanged since `SKG4`, which
// made it variable-size (`fit_spline` carries `2 N + 2 h` params), and rev 4's
// per-constraint verdicts are otherwise unchanged too. The magic IS the
// version handshake: the layout evolved before (has_sign flag + trailing sign
// f32) without moving these, so a stale js/wasm pairing decoded shifted
// offsets instead of failing. Bump BOTH sides (these two and
// sketch-solver/src/codec.rs) on any layout or verdict-semantics change.
// Invalidating stale cached payloads is acceptable and safe post-wave-1:
// bundle-cache reads degrade to cold rebuilds.
const MAGIC_IN = 0x36474b53  // "SKG6", little-endian on the wire
const MAGIC_OUT = 0x36524b53  // "SKR6"

export interface FlatEntity {
  kind: number
  // Per-kind bits; `fit_spline` uses bit0 start handle, bit1 end handle.
  flags: number
  offset: number
  // The entity's own scalar count (variable for `fit_spline`).
  count: number
}

export type FlatRef =
  | { kind: 'entity'; index: number; point: number }
  | { kind: 'external'; x: number; y: number }

export interface FlatConstraint {
  kind: number
  refs: Array<{ role: number; ref: FlatRef }>
  value?: number
  xy?: [number, number]
  axis?: number
  // Orientation selector for directional dimensions (+1/-1). Picks which side /
  // handedness the signed measure must match while value stays non-negative.
  sign?: number
}

export interface FlatInput {
  entities: FlatEntity[]
  params: number[]
  pinnedMask: number[]
  equalityPins: Array<{ index: number; target: number }>
  constraints: FlatConstraint[]
  /** The host's storage grid in document units (the same `DOC_GRID` the sketch
   *  mutators round to). `0` disables the solver's moved report. */
  seedQuantum?: number
  options: { dragMode: boolean; dragAnchorId: number; skipStatusPass: boolean }
}

// WASM solver function: flat typed-array in, flat typed-array out. Declared in
// the neutral wasmTypes module so the mate glue does not import this sketch
// codec for its function type; re-exported for existing sketch-side callers.
export type { SolveBytes } from './wasmTypes'

export interface SolverOutput {
  paramsSolved: number[]
  entityStatus: number[]
  overallStatus: number
  /** Per-constraint verdict bits (`CONSTRAINT_FLAG.*`), index-aligned with the
   *  constraint array that was encoded. Empty on the drag fast path. */
  constraintFlags: number[]
  /** Per-constraint miss as a fraction of the sketch scale, parallel to
   *  `constraintFlags`. All zeros on a satisfied cold solve; empty on drag. */
  constraintMiss: number[]
  /** Packed entity_moved bitmask (LSB-first, ceil(n_entities / 8) bytes): a
   *  set bit means the solve moved that entity by at least half the storage
   *  quantum. Empty on the drag fast path. */
  entityMoved: number[]
  diagnostics: { residualNorm: number; rank: number; dof: number; iters: number; ms: number }
}

const scratch = new DataView(new ArrayBuffer(8))

class ByteWriter {
  private bytes: number[] = []

  u8(v: number): void {
    this.bytes.push(v & 0xff)
  }

  u32(v: number): void {
    this.bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff)
  }

  f64(v: number): void {
    scratch.setFloat64(0, v, true)
    for (let i = 0; i < 8; i++) this.bytes.push(scratch.getUint8(i))
  }

  done(): Uint8Array {
    return new Uint8Array(this.bytes)
  }
}

class ByteReader {
  private view: DataView
  private pos = 0

  constructor(buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  u8(): number {
    return this.view.getUint8(this.pos++)
  }

  u32(): number {
    const v = this.view.getUint32(this.pos, true)
    this.pos += 4
    return v
  }

  f64(): number {
    const v = this.view.getFloat64(this.pos, true)
    this.pos += 8
    return v
  }
}

export function encodeInput(input: FlatInput): Uint8Array {
  const w = new ByteWriter()
  w.u32(MAGIC_IN)
  w.u32(input.entities.length)
  w.u32(input.params.length)
  w.u32(input.constraints.length)
  w.u32(input.equalityPins.length)
  w.u8(input.options.dragMode ? 1 : 0)
  w.u8(input.options.skipStatusPass ? 1 : 0)
  w.u32(input.options.dragAnchorId)
  w.f64(input.seedQuantum ?? 0)

  for (const e of input.entities) {
    w.u8(e.kind)
    w.u8(e.flags)
    w.u32(e.offset)
    w.u32(e.count)
  }
  for (const p of input.params) w.f64(p)

  const maskLen = Math.ceil(input.params.length / 8)
  for (let i = 0; i < maskLen; i++) w.u8(input.pinnedMask[i] ?? 0)

  for (const pin of input.equalityPins) {
    w.u32(pin.index)
    w.f64(pin.target)
  }

  for (const c of input.constraints) {
    w.u8(c.kind)
    w.u8(c.refs.length)
    for (const { role, ref } of c.refs) {
      w.u8(role)
      if (ref.kind === 'external') {
        w.u8(1)
        w.f64(ref.x)
        w.f64(ref.y)
      } else {
        w.u8(0)
        w.u8(ref.point)
        w.u32(ref.index)
      }
    }
    let flags = 0
    if (c.value !== undefined) flags |= 0b001
    if (c.xy !== undefined) flags |= 0b010
    if (c.axis !== undefined) flags |= 0b100
    if (c.sign !== undefined) flags |= 0b1000
    w.u8(flags)
    if (c.value !== undefined) w.f64(c.value)
    if (c.xy !== undefined) {
      w.f64(c.xy[0])
      w.f64(c.xy[1])
    }
    if (c.axis !== undefined) w.u8(c.axis)
    if (c.sign !== undefined) w.f64(c.sign)
  }
  return w.done()
}

export function decodeOutput(buf: Uint8Array): SolverOutput {
  const r = new ByteReader(buf)
  if (r.u32() !== MAGIC_OUT) throw new Error('sketch-solver: bad output magic')
  const nParams = r.u32()
  const nStatus = r.u32()
  const vfLen = r.u32()
  const nConstraintStatus = r.u32()
  const nMoved = r.u32()
  const overallStatus = r.u8()

  const paramsSolved: number[] = []
  for (let i = 0; i < nParams; i++) paramsSolved.push(r.f64())
  const entityStatus: number[] = []
  for (let i = 0; i < nStatus; i++) entityStatus.push(r.u8())
  // vertexFreedom rides the wire (the Rust side emits it) but nothing consumes
  // it yet, so it is read past to keep the cursor aligned rather than decoded
  // into a field nobody reads.
  for (let i = 0; i < vfLen; i++) r.f64()
  const constraintFlags: number[] = []
  for (let i = 0; i < nConstraintStatus; i++) constraintFlags.push(r.u8())
  const constraintMiss: number[] = []
  for (let i = 0; i < nConstraintStatus; i++) constraintMiss.push(r.f64())
  const entityMoved: number[] = []
  for (let i = 0; i < nMoved; i++) entityMoved.push(r.u8())

  const residualNorm = r.f64()
  const rank = r.u32()
  const dof = r.u32()
  const iters = r.u32()
  const ms = r.f64()

  return {
    paramsSolved,
    entityStatus,
    overallStatus,
    constraintFlags,
    constraintMiss,
    entityMoved,
    diagnostics: { residualNorm, rank, dof, iters, ms },
  }
}
