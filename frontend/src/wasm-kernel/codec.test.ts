// @vitest-environment node
//
// Guards for the wire handshake itself. The magic is the only version marker
// on the sketch solver's flat buffers (see codec.ts and sketch-solver/src/codec.rs),
// so these pin that the current revision is written and accepted and that a
// buffer stamped with superseded rev 1 is refused instead of decoded with
// shifted offsets.

import { describe, it, expect } from 'vitest'
import { encodeInput, decodeOutput, type FlatInput } from './codec'

const MAGIC_IN_REV2 = 0x32474b53  // "SKG2"
const MAGIC_OUT_REV2 = 0x32524b53  // "SKR2"
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

/** Minimal well-formed output body: no params/status/freedom rows, one diagnostics tail. */
function outputBytes(magic: number): Uint8Array {
  const buf = new ArrayBuffer(4 + 4 + 4 + 4 + 1 + 8 + 4 + 4 + 4 + 8)
  const dv = new DataView(buf)
  let pos = 0
  const u32 = (v: number) => { dv.setUint32(pos, v, true); pos += 4 }
  const u8 = (v: number) => { dv.setUint8(pos, v); pos += 1 }
  const f64 = (v: number) => { dv.setFloat64(pos, v, true); pos += 8 }
  u32(magic)
  u32(0)  // nParams
  u32(0)  // nStatus
  u32(0)  // vertexFreedom length
  u8(0)  // overallStatus
  f64(0)  // residualNorm
  u32(0)  // rank
  u32(0)  // dof
  u32(0)  // iters
  f64(0)  // ms
  return new Uint8Array(buf)
}

describe('sketch wire magic', () => {
  it('encodeInput stamps the current input magic', () => {
    const bytes = encodeInput(emptyInput())
    expect(bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)).toBe(MAGIC_IN_REV2)
  })

  it('decodeOutput accepts the current output magic', () => {
    expect(() => decodeOutput(outputBytes(MAGIC_OUT_REV2))).not.toThrow()
  })

  it('decodeOutput rejects the rev 1 output magic', () => {
    expect(() => decodeOutput(outputBytes(MAGIC_OUT_REV1))).toThrow('bad output magic')
  })
})
