// Shared little-endian flat codec for the Node-side crate tests (smoke +
// bench), mirroring sketch-solver/src/codec.rs. The Rust crate is canonical;
// this is the minimal JS counterpart the headless harness needs.

export const MAGIC_IN = 0x3247_4b53 // "SKG2": rev 2, mirrors sketch-solver/src/codec.rs
export const MAGIC_OUT = 0x3252_4b53 // "SKR2"

export const Kind = { Line: 0, Circle: 1, Arc: 2, Point: 3 }
export const CKind = {
  Horizontal: 0,
  Vertical: 1,
  Length: 2,
  Radius: 3,
  Diameter: 4,
  LineDistance: 5,
  Coincident: 6,
  Normal: 7,
  Parallel: 8,
  Angle: 9,
  Tangent: 10,
  EqualLength: 11,
  PointDistance: 12,
  Midpoint: 13,
  Concentric: 14,
  Fixed: 15,
}
export const Role = { Target: 0, A: 1, B: 2, Line: 3, Arc: 4, Point: 5, PointA: 6, PointB: 7 }
export const Sel = { Absent: 0, Start: 1, End: 2, Center: 3, Xy: 4 }
export const Status = { FullyConstrained: 0, Underconstrained: 1, Overconstrained: 2 }

class Writer {
  constructor() {
    this.bytes = []
  }
  u8(v) {
    this.bytes.push(v & 0xff)
  }
  u32(v) {
    this.bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff)
  }
  f32(v) {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setFloat32(0, v, true)
    this.bytes.push(...b)
  }
  done() {
    return new Uint8Array(this.bytes)
  }
}

export function encodeInput(input) {
  const w = new Writer()
  w.u32(MAGIC_IN)
  w.u32(input.entities.length)
  w.u32(input.params.length)
  w.u32(input.constraints.length)
  w.u32(input.equalityPins?.length ?? 0)
  w.u8(input.dragMode ? 1 : 0)
  w.u8(input.skipStatusPass ? 1 : 0)
  w.u32(input.dragAnchorId ?? 0)
  for (const e of input.entities) {
    w.u8(e.kind)
    w.u32(e.offset)
  }
  for (const p of input.params) w.f32(p)
  const maskLen = Math.ceil(input.params.length / 8)
  for (let i = 0; i < maskLen; i++) w.u8((input.pinnedMask && input.pinnedMask[i]) || 0)
  for (const pin of input.equalityPins ?? []) {
    w.u32(pin.index)
    w.f32(pin.target)
  }
  for (const c of input.constraints) {
    w.u8(c.kind)
    w.u8(c.refs.length)
    for (const r of c.refs) {
      w.u8(r.role)
      if (r.external) {
        w.u8(1)
        w.f32(r.external[0])
        w.f32(r.external[1])
      } else {
        w.u8(0)
        w.u8(r.point ?? Sel.Absent)
        w.u32(r.index)
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

export function decodeOutput(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let o = 0
  const u32 = () => {
    const v = dv.getUint32(o, true)
    o += 4
    return v
  }
  const u8 = () => dv.getUint8(o++)
  const f32 = () => {
    const v = dv.getFloat32(o, true)
    o += 4
    return v
  }
  const f64 = () => {
    const v = dv.getFloat64(o, true)
    o += 8
    return v
  }
  if (u32() !== MAGIC_OUT) throw new Error('bad output magic')
  const nParams = u32()
  const nStatus = u32()
  const vfLen = u32()
  const overallStatus = u8()
  const params = []
  for (let i = 0; i < nParams; i++) params.push(f32())
  const entityStatus = []
  for (let i = 0; i < nStatus; i++) entityStatus.push(u8())
  const vertexFreedom = []
  for (let i = 0; i < vfLen; i++) vertexFreedom.push(f32())
  const residualNorm = f64()
  const rank = u32()
  const dof = u32()
  const iters = u32()
  const ms = f64()
  return { overallStatus, params, entityStatus, vertexFreedom, residualNorm, rank, dof, iters, ms }
}
