// End-to-end smoke test for the wasm boundary: build a flat Input buffer in JS
// (mirroring src/codec.rs), drive the wasm-pack `nodejs` build, decode the flat
// Output, and assert a trivial sketch solves. This is the minimal JS-side proof
// that the locked byte layout round-trips through real wasm; the full TS codec
// for the app is a later shard. Run after `wasm-pack build --target nodejs
// --out-dir pkg-node`. Exits nonzero on failure.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const wasm = require(path.join(here, "..", "..", "pkg-node", "sketch_solver.js"));

const MAGIC_IN = 0x5347_4b53;
const MAGIC_OUT = 0x5347_4b52;

// Stable wire codes (keep in sync with src/constraints.rs + src/lib.rs).
const Kind = { Line: 0, Circle: 1, Arc: 2, Point: 3 };
const CKind = { Horizontal: 0, Length: 2, Fixed: 15 };
const Role = { Target: 0, A: 1, B: 2 };
const Sel = { Absent: 0, Start: 1, End: 2, Center: 3, Xy: 4 };
const Status = { FullyConstrained: 0, Underconstrained: 1, Overconstrained: 2 };

// Minimal little-endian writer.
class Writer {
  constructor() {
    this.bytes = [];
  }
  u8(v) {
    this.bytes.push(v & 0xff);
  }
  u32(v) {
    this.bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  }
  f32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setFloat32(0, v, true);
    this.bytes.push(...b);
  }
  done() {
    return new Uint8Array(this.bytes);
  }
}

function encodeInput(input) {
  const w = new Writer();
  w.u32(MAGIC_IN);
  w.u32(input.entities.length);
  w.u32(input.params.length);
  w.u32(input.constraints.length);
  w.u32(input.equalityPins.length);
  w.u8(input.dragMode ? 1 : 0);
  w.u8(input.skipStatusPass ? 1 : 0);
  w.u32(input.dragAnchorId ?? 0);
  for (const e of input.entities) {
    w.u8(e.kind);
    w.u32(e.offset);
  }
  for (const p of input.params) w.f32(p);
  const maskLen = Math.ceil(input.params.length / 8);
  for (let i = 0; i < maskLen; i++) w.u8((input.pinnedMask && input.pinnedMask[i]) || 0);
  for (const pin of input.equalityPins) {
    w.u32(pin.index);
    w.f32(pin.target);
  }
  for (const c of input.constraints) {
    w.u8(c.kind);
    w.u8(c.refs.length);
    for (const r of c.refs) {
      w.u8(r.role);
      if (r.external) {
        w.u8(1);
        w.f32(r.external[0]);
        w.f32(r.external[1]);
      } else {
        w.u8(0);
        w.u8(r.point ?? Sel.Absent);
        w.u32(r.index);
      }
    }
    let flags = 0;
    if (c.value !== undefined) flags |= 0b001;
    if (c.xy !== undefined) flags |= 0b010;
    if (c.axis !== undefined) flags |= 0b100;
    w.u8(flags);
    if (c.value !== undefined) w.f32(c.value);
    if (c.xy !== undefined) {
      w.f32(c.xy[0]);
      w.f32(c.xy[1]);
    }
    if (c.axis !== undefined) w.u8(c.axis);
  }
  return w.done();
}

function decodeOutput(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 0;
  const u32 = () => {
    const v = dv.getUint32(o, true);
    o += 4;
    return v;
  };
  const u8 = () => dv.getUint8(o++);
  const f32 = () => {
    const v = dv.getFloat32(o, true);
    o += 4;
    return v;
  };
  const f64 = () => {
    const v = dv.getFloat64(o, true);
    o += 8;
    return v;
  };
  if (u32() !== MAGIC_OUT) throw new Error("bad output magic");
  const nParams = u32();
  const nStatus = u32();
  const vfLen = u32();
  const overallStatus = u8();
  const params = [];
  for (let i = 0; i < nParams; i++) params.push(f32());
  const entityStatus = [];
  for (let i = 0; i < nStatus; i++) entityStatus.push(u8());
  const vertexFreedom = [];
  for (let i = 0; i < vfLen; i++) vertexFreedom.push(f32());
  const residualNorm = f64();
  const rank = u32();
  const dof = u32();
  const iters = u32();
  const ms = f64();
  return { overallStatus, params, entityStatus, vertexFreedom, residualNorm, rank, dof, iters, ms };
}

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
}

// Line seeded off-axis; start fixed at origin, horizontal, length 10.
const input = {
  entities: [{ kind: Kind.Line, offset: 0 }],
  params: [0.2, -0.1, 9.5, 0.8],
  pinnedMask: [],
  equalityPins: [],
  dragMode: false,
  skipStatusPass: false,
  constraints: [
    { kind: CKind.Fixed, refs: [{ role: Role.Target, index: 0, point: Sel.Start }], xy: [0, 0] },
    { kind: CKind.Horizontal, refs: [{ role: Role.Target, index: 0, point: Sel.Absent }] },
    { kind: CKind.Length, refs: [{ role: Role.Target, index: 0, point: Sel.Absent }], value: 10 },
  ],
};

const outBytes = wasm.solve_sketch_bytes(encodeInput(input));
const out = decodeOutput(outBytes);

assert(out.overallStatus === Status.FullyConstrained, `status ${out.overallStatus}`);
assert(out.params.length === 4, `param count ${out.params.length}`);
assert(Math.abs(out.params[0]) < 1e-3 && Math.abs(out.params[1]) < 1e-3, `start ${out.params.slice(0, 2)}`);
assert(Math.abs(out.params[2] - 10) < 1e-3, `end.x ${out.params[2]}`);
assert(Math.abs(out.params[3]) < 1e-3, `end.y ${out.params[3]}`);
assert(out.residualNorm < 1e-4, `residual ${out.residualNorm}`);

console.log("wasm smoke ok:", {
  status: out.overallStatus,
  params: out.params.map((v) => Number(v.toFixed(4))),
  rank: out.rank,
  iters: out.iters,
});
