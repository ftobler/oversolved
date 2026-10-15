// @vitest-environment node
//
// Rev 3 wire proof: every scalar the TS side encodes crosses to Rust and comes
// back bit-exact as f64. Replaces the two-rounding band-aid of rev 2, where a
// typed 1234.567 decoded as 1234.567017 and a 1234-mm sketch carried ~1e-4 mm
// of placement error against OCCT's 1e-7 confusion.
//
// Skips when the node-target sketch package is absent (fresh checkout without
// `just wasm`).

import { describe, it, expect } from 'vitest'
import {
  encodeInput, decodeOutput, ConstraintKindCode, Kind, Role, Sel, Status,
  type FlatInput,
} from '../codec'
import { loadSolver } from '../loadSolver'

const solveBytes = loadSolver()

// The rev 2 input magic (f32 layout). A live decoder must refuse it outright:
// accepting it would read f64 fields out of f32 offsets and return shifted
// nonsense instead of surfacing the stale js/wasm pairing.
const MAGIC_IN_REV2 = 0x32474b53  // "SKG2"

describe.skipIf(!solveBytes)('sketch rev 3 wire (real wasm)', () => {
  it('round-trips the f64 stress values bit-exact through encode -> Rust -> decode', () => {
    // Point entities, no constraints: the LM driver returns the seed unchanged
    // and Rust echoes it back through encode_output, so every value makes the
    // full round trip. The pin, external ref and value/xy/sign fields ride
    // along so a wrong width anywhere in the input record would shift the
    // stream (Rust reads params first, then the pin, then the constraints) and
    // corrupt or reject what comes back.
    const values = [25.4, 1234.567, 1e-9, -0.0, 1e6]
    const input: FlatInput = {
      entities: [
        { kind: Kind.Point, offset: 0 },
        { kind: Kind.Point, offset: 2 },
        { kind: Kind.Point, offset: 4 },
      ],
      params: [...values, 0.1],
      pinnedMask: [],
      // Already at its target: the pin row reads 0 and LM returns the seed.
      equalityPins: [{ index: 5, target: 0.1 }],
      constraints: [
        {
          // Decode-only carrier (no operands, so the problem drops it): its
          // value/xy/sign fields must still read back at the right widths or
          // the stream shifts under the echo below.
          kind: ConstraintKindCode.length,
          refs: [],
          value: 1e-9,
          xy: [25.4, -0.0],
          sign: 1e6,
        },
        {
          kind: ConstraintKindCode.coincident,
          refs: [{ role: Role.a, ref: { kind: 'external', x: 1234.567, y: -0.0 } }],
        },
      ],
      options: { dragMode: false, dragAnchorId: 0, skipStatusPass: true },
    }
    const out = decodeOutput(solveBytes!(encodeInput(input)))
    expect(out.paramsSolved).toHaveLength(6)
    for (let i = 0; i < values.length; i++) {
      // Object.is semantics via toBe: -0.0 must not come back as +0.0.
      expect(out.paramsSolved[i]).toBe(values[i])
    }
    expect(out.paramsSolved[5]).toBe(0.1)
  })

  it('reproduces a typed 1234.567 by 25.4 rectangle within 1e-9', () => {
    // The report's canonical failure: under f32 the solved 1234.567 came back
    // 1234.567017 and the 25.4 side was only exact to ~1e-5 mm.
    const input: FlatInput = {
      entities: [
        { kind: Kind.Line, offset: 0 },
        { kind: Kind.Line, offset: 4 },
        { kind: Kind.Line, offset: 8 },
        { kind: Kind.Line, offset: 12 },
      ],
      // Seeded a few units off the solution so the solver really moves.
      params: [
        0.2, -0.3, 1234.1, 0.4,
        1234.4, 0.3, 1234.6, 25.1,
        1234.3, 25.6, -0.4, 25.3,
        0.3, 25.1, -0.2, 0.2,
      ],
      pinnedMask: [],
      equalityPins: [],
      constraints: [
        { kind: ConstraintKindCode.horizontal, refs: [{ role: Role.target, ref: { kind: 'entity', index: 0, point: Sel.absent } }] },
        { kind: ConstraintKindCode.vertical, refs: [{ role: Role.target, ref: { kind: 'entity', index: 1, point: Sel.absent } }] },
        { kind: ConstraintKindCode.horizontal, refs: [{ role: Role.target, ref: { kind: 'entity', index: 2, point: Sel.absent } }] },
        { kind: ConstraintKindCode.vertical, refs: [{ role: Role.target, ref: { kind: 'entity', index: 3, point: Sel.absent } }] },
        { kind: ConstraintKindCode.length, refs: [{ role: Role.target, ref: { kind: 'entity', index: 0, point: Sel.absent } }], value: 1234.567 },
        { kind: ConstraintKindCode.length, refs: [{ role: Role.target, ref: { kind: 'entity', index: 1, point: Sel.absent } }], value: 25.4 },
        { kind: ConstraintKindCode.length, refs: [{ role: Role.target, ref: { kind: 'entity', index: 2, point: Sel.absent } }], value: 1234.567 },
        { kind: ConstraintKindCode.length, refs: [{ role: Role.target, ref: { kind: 'entity', index: 3, point: Sel.absent } }], value: 25.4 },
        { kind: ConstraintKindCode.coincident, refs: [{ role: Role.a, ref: { kind: 'entity', index: 0, point: Sel.end } }, { role: Role.b, ref: { kind: 'entity', index: 1, point: Sel.start } }] },
        { kind: ConstraintKindCode.coincident, refs: [{ role: Role.a, ref: { kind: 'entity', index: 1, point: Sel.end } }, { role: Role.b, ref: { kind: 'entity', index: 2, point: Sel.start } }] },
        { kind: ConstraintKindCode.coincident, refs: [{ role: Role.a, ref: { kind: 'entity', index: 2, point: Sel.end } }, { role: Role.b, ref: { kind: 'entity', index: 3, point: Sel.start } }] },
        { kind: ConstraintKindCode.coincident, refs: [{ role: Role.a, ref: { kind: 'entity', index: 3, point: Sel.end } }, { role: Role.b, ref: { kind: 'entity', index: 0, point: Sel.start } }] },
        { kind: ConstraintKindCode.fixed, refs: [{ role: Role.target, ref: { kind: 'entity', index: 0, point: Sel.start } }], xy: [0, 0] },
      ],
      options: { dragMode: false, dragAnchorId: 0, skipStatusPass: false },
    }
    const out = decodeOutput(solveBytes!(encodeInput(input)))
    expect(out.overallStatus).toBe(Status.fully_constrained)
    const [x0, y0, x1, y1] = out.paramsSolved
    expect(Math.abs(x1 - x0 - 1234.567)).toBeLessThan(1e-9)
    expect(Math.abs(x0)).toBeLessThan(1e-9)
    expect(Math.abs(y0)).toBeLessThan(1e-9)
    const side = Math.hypot(out.paramsSolved[6] - out.paramsSolved[4], out.paramsSolved[7] - out.paramsSolved[5])
    expect(Math.abs(side - 25.4)).toBeLessThan(1e-9)
    expect(y1).toBeGreaterThan(-1e-9)
  })

  it('fails loud on a rev 2 payload instead of decoding shifted values', () => {
    // Build the rev 2 input layout by hand (f32 params, f32 pin target, f32
    // constraint scalars) with a rev 2 magic. The rev 3 decoder must refuse at
    // the magic; any output at all would mean shifted-offset garbage was
    // treated as a solve.
    const bytes: number[] = []
    const u32 = (v: number) => bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff)
    const u8 = (v: number) => bytes.push(v & 0xff)
    const f32 = (v: number) => {
      const b = new Uint8Array(4)
      new DataView(b.buffer).setFloat32(0, v, true)
      bytes.push(...b)
    }
    u32(MAGIC_IN_REV2)
    u32(1) // n_entities
    u32(4) // n_params
    u32(1) // n_constraints
    u32(0) // n_equality_pins
    u8(0)  // drag_mode
    u8(0)  // skip_status_pass
    u32(0) // drag_anchor_id
    u8(Kind.Line)
    u32(0)
    for (const p of [0, 0, 10, 0]) f32(p)
    u8(0)  // pinned mask
    u8(ConstraintKindCode.horizontal)
    u8(1)
    u8(Role.target)
    u8(0)
    u8(Sel.absent)
    u32(0)
    u8(0)  // no scalar flags
    expect(() => solveBytes!(new Uint8Array(bytes))).toThrow(/BadMagic/)
  })
})
