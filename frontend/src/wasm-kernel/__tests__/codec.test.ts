// @vitest-environment node
//
// Guards for the wire handshake itself. The magic is the only version marker
// on the sketch solver's flat buffers (see codec.ts and sketch-solver/src/codec.rs),
// so these pin that the current revision is written and accepted and that
// buffers stamped with superseded revisions (1: pre-sign, 2: f32 scalars, 3:
// no per-constraint verdicts, SKG4/SKR4: no storage quantum / moved report,
// SKG5/SKR5: no dropped verdict bit, SKG6/SKR6: no reference params,
// SKG7/SKR7: no realised-precision diagnostics) are refused instead of decoded
// with shifted offsets or misread verdicts.

import { describe, it, expect } from 'vitest'
import {
  encodeInput, decodeOutput, ConstraintKindCode, Kind, Role, Sel, Status,
  type FlatInput,
} from '../codec'
import { loadSolver } from '../loadSolver'
import { OCC_ANGULAR, OCC_CONFUSION } from '@/kernel/solverConstants'

const solveBytes = loadSolver()

const MAGIC_IN = 0x38474b53  // "SKG8"
const MAGIC_OUT = 0x38524b53  // "SKR8"
const MAGIC_OUT_SKR7 = 0x37524b53  // "SKR7" (diagnostics stop at ms)
const MAGIC_OUT_SKR6 = 0x36524b53  // "SKR6" (no reference params in the input)
const MAGIC_OUT_SKR5 = 0x35524b53  // "SKR5" (no dropped verdict bit)
const MAGIC_OUT_SKR4 = 0x34524b53  // "SKR4" (no entity_moved)
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
    seedQuantum: 1e-6,
    options: { dragMode: false, dragAnchorId: 0, skipStatusPass: true },
  }
}

/**
 * A well-formed output body with a distinct value in every field, so a
 * field-order or width slip in decodeOutput changes the decoded result instead
 * of landing on the same all-zero output. Mirrors the Rust output_round_trips
 * fixture (sketch-solver/src/codec.rs).
 */
function outputBytes(magic: number, entityMoved = [0b0000_0011]): Uint8Array {
  const params = [1.5, 2.25]
  const entityStatus = [0, 1]
  const vertexFreedom = [0, 1, 1, 0]
  const constraintFlags = [1, 0, 2]
  const constraintMiss = [0.5, 0, 0.125]
  const size = 4 + 4 + 4 + 4 + 4 + 4 + 1
    + params.length * 8 + entityStatus.length + vertexFreedom.length * 8
    + constraintFlags.length + constraintMiss.length * 8
    + entityMoved.length
    + 8 + 4 + 4 + 4 + 8 + 8 + 8
  const buf = new ArrayBuffer(size)
  const dv = new DataView(buf)
  let pos = 0
  const u32 = (v: number) => { dv.setUint32(pos, v, true); pos += 4 }
  const u8 = (v: number) => { dv.setUint8(pos, v); pos += 1 }
  const f64 = (v: number) => { dv.setFloat64(pos, v, true); pos += 8 }
  u32(magic)
  u32(params.length)  // nParams
  u32(entityStatus.length)  // nStatus
  u32(vertexFreedom.length)  // vertexFreedom length
  u32(constraintFlags.length)  // per-constraint verdict count
  u32(entityMoved.length)  // entity_moved byte count
  u8(1)  // overallStatus: underconstrained
  for (const p of params) f64(p)
  for (const s of entityStatus) u8(s)
  for (const v of vertexFreedom) f64(v)
  for (const f of constraintFlags) u8(f)
  for (const m of constraintMiss) f64(m)
  for (const m of entityMoved) u8(m)
  f64(1.25)  // residualNorm
  u32(5)  // rank
  u32(1)  // dof
  u32(7)  // iters
  f64(0.5)  // ms
  f64(2.5e-13)  // angularMiss
  f64(3.5e-10)  // linearMiss
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
    expect(out.entityMoved).toEqual([0b0000_0011])
    expect(out.overallStatus).toBe(1)
    expect(out.diagnostics.residualNorm).toBe(1.25)
    expect(out.diagnostics.rank).toBe(5)
    expect(out.diagnostics.dof).toBe(1)
    expect(out.diagnostics.iters).toBe(7)
    expect(out.diagnostics.ms).toBe(0.5)
    // The two realised-precision fields are appended after `ms`; a reordered
    // read would land them on each other's values.
    expect(out.diagnostics.angularMiss).toBe(2.5e-13)
    expect(out.diagnostics.linearMiss).toBe(3.5e-10)
  })

  it('decodes a NaN precision report as NaN', () => {
    // An unsatisfied solve reports NaN; the codec has no finite gate on the
    // output side, so the host sees exactly what the solver measured.
    const bytes = outputBytes(MAGIC_OUT)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const n = view.getUint32(4, true)
    const nStatus = view.getUint32(8, true)
    const vf = view.getUint32(12, true)
    const nCon = view.getUint32(16, true)
    const nMoved = view.getUint32(20, true)
    const tail = 25 + n * 8 + nStatus + vf * 8 + nCon * 9 + nMoved + 8 + 4 + 4 + 4 + 8
    view.setFloat64(tail, Number.NaN, true)
    view.setFloat64(tail + 8, Number.NaN, true)
    const out = decodeOutput(bytes)
    expect(Number.isNaN(out.diagnostics.angularMiss)).toBe(true)
    expect(Number.isNaN(out.diagnostics.linearMiss)).toBe(true)
  })

  it('decodeOutput rejects the rev 7 (SKR7) output magic', () => {
    // Rev 7's diagnostics stop at `ms`: this reader would read the two
    // precision fields past the end of the buffer.
    expect(() => decodeOutput(outputBytes(MAGIC_OUT_SKR7))).toThrow('bad output magic')
  })

  it('decodeOutput rejects the rev 3 output magic', () => {
    // Rev 3 carried no per-constraint verdict count, so decoding one with this
    // reader would read the diagnostics fields four bytes early.
    expect(() => decodeOutput(outputBytes(MAGIC_OUT_REV3))).toThrow('bad output magic')
  })

  it('decodeOutput rejects the rev 5 (SKR5) output magic', () => {
    // Same layout, older verdict meaning: that solver never set the dropped
    // bit, so accepting it would hide a filtered constraint.
    expect(() => decodeOutput(outputBytes(MAGIC_OUT_SKR5))).toThrow('bad output magic')
  })

  it('decodeOutput rejects the rev 6 (SKR6) output magic', () => {
    // The pair moves together: an SKR6 solver has no reference params, so a
    // stale js/wasm pairing must fail at the handshake.
    expect(() => decodeOutput(outputBytes(MAGIC_OUT_SKR6))).toThrow('bad output magic')
  })

  it('decodeOutput rejects the rev 4 (SKR4) output magic', () => {
    // No entity_moved block: the diagnostics would start where this decoder
    // reads the moved bytes.
    expect(() => decodeOutput(outputBytes(MAGIC_OUT_SKR4))).toThrow('bad output magic')
  })

  it('decodeOutput rejects the rev 2 (f32) output magic', () => {
    expect(() => decodeOutput(outputBytes(MAGIC_OUT_REV2))).toThrow('bad output magic')
  })

  it('decodeOutput rejects the rev 1 output magic', () => {
    expect(() => decodeOutput(outputBytes(MAGIC_OUT_REV1))).toThrow('bad output magic')
  })
})

describe.skipIf(!solveBytes)('sketch wire stale input magic', () => {
  it('rejects a SKG4 buffer, whose header has no storage quantum', () => {
    const bytes = encodeInput(emptyInput())
    bytes.set([0x53, 0x4b, 0x47, 0x34], 0)  // "SKG4"
    expect(() => solveBytes!(bytes)).toThrow()
  })

  it('rejects a SKG5 buffer, whose solver cannot report a dropped constraint', () => {
    const bytes = encodeInput(emptyInput())
    bytes.set([0x53, 0x4b, 0x47, 0x35], 0)  // "SKG5"
    expect(() => solveBytes!(bytes)).toThrow()
  })

  it('rejects a SKG6 buffer, whose header has no reference params', () => {
    // This decoder would read the first entity record as `n_reference` and
    // shift every following block.
    const bytes = encodeInput(emptyInput())
    bytes.set([0x53, 0x4b, 0x47, 0x36], 0)  // "SKG6"
    expect(() => solveBytes!(bytes)).toThrow()
  })
})

describe.skipIf(!solveBytes)('sketch wire reference params', () => {
  it('holds the reference shape while the seed is moved', () => {
    // The drag case in one call: the seed has the line end pulled up, the
    // reference is the authored line, and `fixed` must pin to the reference.
    const input: FlatInput = {
      entities: [{ kind: Kind.Line, flags: 0, offset: 0, count: 4 }],
      params: [0.0, 4.0, 10.0, 4.0],
      paramsReference: [0.0, 0.0, 10.0, 0.0],
      pinnedMask: [],
      equalityPins: [],
      constraints: [
        { kind: ConstraintKindCode.fixed, refs: [{ role: Role.target, ref: { kind: 'entity', index: 0, point: Sel.absent } }] },
      ],
      seedQuantum: 1e-6,
      options: { dragMode: false, dragAnchorId: 0, skipStatusPass: false },
    }
    const out = decodeOutput(solveBytes!(encodeInput(input)))
    expect(out.paramsSolved[1]).toBeCloseTo(0, 6)
    expect(out.paramsSolved[3]).toBeCloseTo(0, 6)
  })
})

describe.skipIf(!solveBytes)('sketch wire storage quantum', () => {
  it('round-trips a fixed input through the real solver with the quantum on the header', () => {
    // A hand-built flat Input (no lowerSketch): the quantum sits in the header
    // and the output carries the moved report. A one-grid-step seed at scale 1
    // is the case the report exists for.
    const input: FlatInput = {
      entities: [{ kind: Kind.Line, flags: 0, offset: 0, count: 4 }],
      params: [0.2, -0.1, 9.5, 0.8],
      pinnedMask: [],
      equalityPins: [],
      constraints: [
        { kind: ConstraintKindCode.fixed, refs: [{ role: Role.target, ref: { kind: 'entity', index: 0, point: Sel.start } }], xy: [0, 0] },
        { kind: ConstraintKindCode.horizontal, refs: [{ role: Role.target, ref: { kind: 'entity', index: 0, point: Sel.absent } }] },
        { kind: ConstraintKindCode.length, refs: [{ role: Role.target, ref: { kind: 'entity', index: 0, point: Sel.absent } }], value: 10 },
      ],
      seedQuantum: 1e-6,
      options: { dragMode: false, dragAnchorId: 0, skipStatusPass: false },
    }
    const out = decodeOutput(solveBytes!(encodeInput(input)))
    expect(out.overallStatus).toBe(Status.fully_constrained)
    expect(out.paramsSolved).toHaveLength(4)
    // The seed was 0.5 off the authored length, so the line is reported moved.
    expect(out.entityMoved).toEqual([0b0000_0001])
  })
})

describe.skipIf(!solveBytes)('sketch wire real-wasm round-trip', () => {
  it('solves a fixed, horizontal, length-10 line from a raw flat input', () => {
    const input: FlatInput = {
      entities: [{ kind: Kind.Line, flags: 0, offset: 0, count: 4 }],
      params: [0.2, -0.1, 9.5, 0.8],
      pinnedMask: [],
      equalityPins: [],
      constraints: [
        { kind: ConstraintKindCode.fixed, refs: [{ role: Role.target, ref: { kind: 'entity', index: 0, point: Sel.start } }], xy: [0, 0] },
        { kind: ConstraintKindCode.horizontal, refs: [{ role: Role.target, ref: { kind: 'entity', index: 0, point: Sel.absent } }] },
        { kind: ConstraintKindCode.length, refs: [{ role: Role.target, ref: { kind: 'entity', index: 0, point: Sel.absent } }], value: 10 },
      ],
      seedQuantum: 1e-6,
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
    // Rev 4: one verdict byte and one miss per constraint sent, all clean.
    expect(out.constraintFlags).toEqual([0, 0, 0])
    expect(out.constraintMiss).toEqual([0, 0, 0])
    // The seed was 0.5 off the authored length, so the one entity is moved.
    expect(out.entityMoved).toEqual([1])
  })
})

describe.skipIf(!solveBytes)('sketch wire precision contract', () => {
  function twoLineInput(conflicting: boolean): FlatInput {
    const target = (index: number) => ({
      role: Role.target,
      ref: { kind: 'entity' as const, index, point: Sel.absent },
    })
    const fixedStart = {
      kind: ConstraintKindCode.fixed,
      refs: [{ role: Role.target, ref: { kind: 'entity' as const, index: 0, point: Sel.start } }],
      xy: [0, 0] as [number, number],
    }
    const horizontal = (index: number) => ({ kind: ConstraintKindCode.horizontal, refs: [target(index)] })
    const length = (value: number) => ({
      kind: ConstraintKindCode.length,
      refs: [target(0)],
      value,
    })
    return {
      entities: [
        { kind: Kind.Line, flags: 0, offset: 0, count: 4 },
        { kind: Kind.Line, flags: 0, offset: 4, count: 4 },
      ],
      params: [0, 0, 10, 0, 0, 5, 10, 5],
      pinnedMask: [],
      equalityPins: [],
      constraints: conflicting
        ? [fixedStart, length(10), length(10.1)]
        : [
            fixedStart,
            horizontal(0),
            horizontal(1),
            {
              kind: ConstraintKindCode.parallel,
              refs: [
                { role: Role.a, ref: { kind: 'entity' as const, index: 0, point: Sel.absent } },
                { role: Role.b, ref: { kind: 'entity' as const, index: 1, point: Sel.absent } },
              ],
            },
          ],
      seedQuantum: 1e-6,
      options: { dragMode: false, dragAnchorId: 0, skipStatusPass: false },
    }
  }

  it('carries the realised misses of a satisfied solve', () => {
    // The two fields are the kernel half's input: a satisfied solve must report
    // finite values, and this sketch's parallel pair is exactly the row the
    // contract exists for.
    const out = decodeOutput(solveBytes!(encodeInput(twoLineInput(false))))
    expect(Number.isFinite(out.diagnostics.angularMiss)).toBe(true)
    expect(Number.isFinite(out.diagnostics.linearMiss)).toBe(true)
    expect(out.diagnostics.angularMiss).toBeLessThanOrEqual(OCC_ANGULAR)
    expect(out.diagnostics.linearMiss).toBeLessThanOrEqual(OCC_CONFUSION * 1e-2)
  })

  it('reports NaN on an unsatisfied solve', () => {
    const out = decodeOutput(solveBytes!(encodeInput(twoLineInput(true))))
    expect(out.overallStatus).toBe(Status.overconstrained)
    expect(Number.isNaN(out.diagnostics.angularMiss)).toBe(true)
    expect(Number.isNaN(out.diagnostics.linearMiss)).toBe(true)
  })
})
