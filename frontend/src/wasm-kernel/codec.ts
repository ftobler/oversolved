/**
 * Flat typed-array codec for the Rust sketch solver (WASM kernel migration,
 * phase 1). This MUST stay byte-for-byte in sync with `sketch-solver/src/codec.rs`;
 * the Rust crate is the canonical definition and its tests lock the layout.
 *
 * Everything is little-endian. See codec.rs for the full layout documentation.
 */

export const Kind = { Line: 0, Circle: 1, Arc: 2, Point: 3, Ellipse: 4, Spline: 5 } as const

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

export const AxisCode: Record<string, number> = { x: 0, y: 1, both: 2 }

export const Status = { fully_constrained: 0, underconstrained: 1, overconstrained: 2 } as const

/** Index -> status string, the inverse of the Rust `Status::to_u8`. */
export const STATUS_NAME = ['fully_constrained', 'underconstrained', 'overconstrained'] as const

const MAGIC_IN = 0x53474b53
const MAGIC_OUT = 0x53474b52

export interface FlatEntity {
  kind: number
  offset: number
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
}

export interface FlatInput {
  entities: FlatEntity[]
  params: number[]
  pinnedMask: number[]
  equalityPins: Array<{ index: number; target: number }>
  constraints: FlatConstraint[]
  options: { dragMode: boolean; dragAnchorId: number; skipStatusPass: boolean }
}

/** WASM solver function: flat typed-array in, flat typed-array out. */
export type SolveBytes = (input: Uint8Array) => Uint8Array

export interface SolverOutput {
  paramsSolved: number[]
  entityStatus: number[]
  overallStatus: number
  vertexFreedom: number[]
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

  f32(v: number): void {
    scratch.setFloat32(0, v, true)
    for (let i = 0; i < 4; i++) this.bytes.push(scratch.getUint8(i))
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

  f32(): number {
    const v = this.view.getFloat32(this.pos, true)
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

  for (const e of input.entities) {
    w.u8(e.kind)
    w.u32(e.offset)
  }
  for (const p of input.params) w.f32(p)

  const maskLen = Math.ceil(input.params.length / 8)
  for (let i = 0; i < maskLen; i++) w.u8(input.pinnedMask[i] ?? 0)

  for (const pin of input.equalityPins) {
    w.u32(pin.index)
    w.f32(pin.target)
  }

  for (const c of input.constraints) {
    w.u8(c.kind)
    w.u8(c.refs.length)
    for (const { role, ref } of c.refs) {
      w.u8(role)
      if (ref.kind === 'external') {
        w.u8(1)
        w.f32(ref.x)
        w.f32(ref.y)
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
    w.u8(flags)
    if (c.value !== undefined) w.f32(c.value)
    if (c.xy !== undefined) {
      w.f32(c.xy[0])
      w.f32(c.xy[1])
    }
    if (c.axis !== undefined) w.u8(c.axis)
  }
  return w.done()
}

export function decodeOutput(buf: Uint8Array): SolverOutput {
  const r = new ByteReader(buf)
  if (r.u32() !== MAGIC_OUT) throw new Error('sketch-solver: bad output magic')
  const nParams = r.u32()
  const nStatus = r.u32()
  const vfLen = r.u32()
  const overallStatus = r.u8()

  const paramsSolved: number[] = []
  for (let i = 0; i < nParams; i++) paramsSolved.push(r.f32())
  const entityStatus: number[] = []
  for (let i = 0; i < nStatus; i++) entityStatus.push(r.u8())
  const vertexFreedom: number[] = []
  for (let i = 0; i < vfLen; i++) vertexFreedom.push(r.f32())

  const residualNorm = r.f64()
  const rank = r.u32()
  const dof = r.u32()
  const iters = r.u32()
  const ms = r.f64()

  return {
    paramsSolved,
    entityStatus,
    overallStatus,
    vertexFreedom,
    diagnostics: { residualNorm, rank, dof, iters, ms },
  }
}
