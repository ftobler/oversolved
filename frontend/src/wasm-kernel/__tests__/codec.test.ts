// @vitest-environment node
//
// Guards for the wire handshake itself. The magic is the only version marker
// on the sketch solver's flat buffers (see codec.ts and sketch-solver/src/codec.rs),
// so these pin that the current revision is written and accepted and that
// buffers stamped with superseded revisions (1: pre-sign, 2: f32 scalars, 3:
// no per-constraint verdicts) are refused instead of decoded with shifted
// offsets.

import { describe, it, expect } from 'vitest'
import {
  encodeInput, decodeOutput, ConstraintKindCode, Kind, Role, Sel, Status,
  type FlatInput,
} from '../codec'
import { loadSolver } from '../loadSolver'

const solveBytes = loadSolver()

const MAGIC_IN = 0x33474b53  // "SKG3"
const MAGIC_OUT = 0x34524b53  // "SKR4"
const MAGIC_OUT_REV3 = 0x33524b53  // "SKR3" (no per-constraint verdicts)
const MAGIC_OUT_REV2 = 0x32524b53  // "SKR2" (f32 layout)
const MAGIC_OUT_REV1 = 0x53474b52

function emptyInput(): FlatInput {
  return {
    entities: [],
    params: [],
    pinnedMask: [],
    equalityPins: [],
    constraints: [],
    options: { dragMode: false, dragAnchorId: 0, skipStatusPass: true },
  }
}

/**
 * A well-formed output body with a distinct value in every field, so a
 * field-order or width slip in decodeOutput changes the decoded result instead
 * of landing on the same all-zero output. Mirrors the Rust output_round_trips
 * fixture (sketch-solver/src/codec.rs).
 */
function outputBytes(magic: number): Uint8Array {
  const params = [1.5, 2.25]
  const entityStatus = [0, 1]
  const vertexFreedom = [0, 1, 1, 0]
  const constraintFlags = [1, 0, 2]
  const constraintMiss = [0.5, 0, 0.125]
  const size = 4 + 4 + 4 + 4 + 4 + 1
    + params.length * 8 + entityStatus.length + vertexFreedom.length * 8
    + constraintFlags.length + constraintMiss.length * 4
    + 8 + 4 + 4 + 4 + 8
  const buf = new ArrayBuffer(size)
  const dv = new DataView(buf)
  let pos = 0
  const u32 = (v: number) => { dv.setUint32(pos, v, true); pos += 4 }
  const u8 = (v: number) => { dv.setUint8(pos, v); pos += 1 }
  const f32 = (v: number) => { dv.setFloat32(pos, v, true); pos += 4 }
  const f64 = (v: number) => { dv.setFloat64(pos, v, true); pos += 8 }
  u32(magic)
  u32(params.length)  // nParams
  u32(entityStatus.length)  // nStatus
  u32(vertexFreedom.length)  // vertexFreedom length
  u32(constraintFlags.length)  // per-constraint verdict count
  u8(1)  // overallStatus: underconstrained
  for (const p of params) f64(p)
  for (const s of entityStatus) u8(s)
  for (const v of vertexFreedom) f64(v)
  for (const f of constraintFlags) u8(f)
  for (const m of constraintMiss) f32(m)
  f64(1.25)  // residualNorm
  u32(5)  // rank
  u32(1)  // dof
  u32(7)  // iters
  f64(0.5)  // ms
  return new Uint8Array(buf)
}

describe('sketch wire magic', () => {
  it('encodeInput stamps the current input magic', () => {
    const bytes = encodeInput(emptyInput())
    expect(bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)).toBe(MAGIC_IN)
  })

  it('decodeOutput accepts the current output magic', () => {
    expect(() => decodeOutput(outputBytes(MAGIC_OUT))).not.toThrow()
  })

  it('decodes each field from a distinct, correctly ordered layout', () => {
    // Every field carries a value no other field shares, so a reordered or
    // wrong-width read cannot pass by decoding to the same result.
    const out = decodeOutput(outputBytes(MAGIC_OUT))
    expect(out.paramsSolved).toEqual([1.5, 2.25])
    expect(out.entityStatus).toEqual([0, 1])
    expect(out.constraintFlags).toEqual([1, 0, 2])
    expect(out.constraintMiss).toEqual([0.5, 0, 0.125])
    expect(out.overallStatus).toBe(1)
    expect(out.diagnostics.residualNorm).toBe(1.25)
    expect(out.diagnostics.rank).toBe(5)
    expect(out.diagnostics.dof).toBe(1)
    expect(out.diagnostics.iters).toBe(7)
    expect(out.diagnostics.ms).toBe(0.5)
  })

  it('decodeOutput rejects the rev 3 output magic', () => {
    // Rev 3 carried no per-constraint verdict count, so decoding one with this
    // reader would read the diagnostics fields four bytes early.
    expect(() => decodeOutput(outputBytes(MAGIC_OUT_REV3))).toThrow('bad output magic')
  })

  it('decodeOutput rejects the rev 2 (f32) output magic', () => {
    expect(() => decodeOutput(outputBytes(MAGIC_OUT_REV2))).toThrow('bad output magic')
  })

  it('decodeOutput rejects the rev 1 output magic', () => {
    expect(() => decodeOutput(outputBytes(MAGIC_OUT_REV1))).toThrow('bad output magic')
  })
})

// The end-to-end boundary proof the deleted tests/node/smoke.mjs used to carry:
// a hand-built flat Input (no lowerSketch) round-trips through the real wasm
// and comes back solved. Kept beside the layout guards so the byte contract and
// the real solver are pinned in one place.
describe.skipIf(!solveBytes)('sketch wire real-wasm round-trip', () => {
  it('solves a fixed, horizontal, length-10 line from a raw flat input', () => {
    const input: FlatInput = {
      entities: [{ kind: Kind.Line, offset: 0 }],
      params: [0.2, -0.1, 9.5, 0.8],
      pinnedMask: [],
      equalityPins: [],
      constraints: [
        { kind: ConstraintKindCode.fixed, refs: [{ role: Role.target, ref: { kind: 'entity', index: 0, point: Sel.start } }], xy: [0, 0] },
        { kind: ConstraintKindCode.horizontal, refs: [{ role: Role.target, ref: { kind: 'entity', index: 0, point: Sel.absent } }] },
        { kind: ConstraintKindCode.length, refs: [{ role: Role.target, ref: { kind: 'entity', index: 0, point: Sel.absent } }], value: 10 },
      ],
      // The deleted smoke.mjs left this false (full status pass); keep that so
      // the folded test still exercises the entity-status/vertex-freedom path.
      options: { dragMode: false, dragAnchorId: 0, skipStatusPass: false },
    }
    const out = decodeOutput(solveBytes!(encodeInput(input)))
    expect(out.overallStatus).toBe(Status.fully_constrained)
    expect(out.paramsSolved).toHaveLength(4)
    expect(Math.abs(out.paramsSolved[0])).toBeLessThan(1e-3)
    expect(Math.abs(out.paramsSolved[1])).toBeLessThan(1e-3)
    expect(Math.abs(out.paramsSolved[2] - 10)).toBeLessThan(1e-3)
    expect(Math.abs(out.paramsSolved[3])).toBeLessThan(1e-3)
    expect(out.diagnostics.residualNorm).toBeLessThan(1e-4)
    // Rev 4: one verdict byte and one f32 miss per constraint sent, all clean.
    expect(out.constraintFlags).toEqual([0, 0, 0])
    expect(out.constraintMiss).toEqual([0, 0, 0])
  })
})
