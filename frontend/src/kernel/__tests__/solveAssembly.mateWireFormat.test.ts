import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { encodeMateInput, decodeMateOutput } from '../solveAssembly'
import { makeEchoSolver, readMateWireFixture, freshDb } from '../solveAssemblyTestUtils'

beforeEach(() => { freshDb() })

describe('mate wire format', () => {
  it('encode/decode round-trips params', () => {
    // Test the wire format indirectly: encode with known input,
    // decode the output from a fake solver that echoes params.
    const params = new Float64Array(14)
    for (let i = 0; i < 14; i++) params[i] = i * 0.1
    const fixedMask = new Uint8Array([0])
    const encoded = encodeMateInput(2, params, fixedMask, [])
    const solver = makeEchoSolver()
    const outputBytes = solver(encoded)
    const decoded = decodeMateOutput(outputBytes, 14)

    expect(decoded.paramsSolved).toHaveLength(14)
    for (let i = 0; i < 14; i++) {
      // f64 end to end: the echo is bit-exact, not close.
      expect(decoded.paramsSolved[i]).toBe(params[i])
    }
  })

  it('decode detects bad magic', () => {
    const bad = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0])
    expect(() => decodeMateOutput(bad, 0)).toThrow('bad mate output magic')
  })

  it('decode detects a params-count mismatch (short buffer, e.g. wrong bodyCount)', () => {
    const params = new Float64Array(7)
    const fixedMask = new Uint8Array([0])
    const encoded = encodeMateInput(1, params, fixedMask, [])
    const outputBytes = makeEchoSolver()(encoded)
    expect(() => decodeMateOutput(outputBytes, 14)).toThrow(/params/)
  })

  it('byte sizes align with Rust format', () => {
    const fixture = readMateWireFixture()
    // The rev and both magics are pinned here as literals as well as through the
    // fixture, so a stale fixture cannot hide a constant that moved on one side.
    expect(fixture.rev).toBe(4)
    expect(fixture.magic).toBe(0x3453544D)
    expect(fixture.magic_out).toBe(0x3352544D)
    // One empty body, no mates: header 20 + bodies 4 + params 56 + mask 1 = 81 bytes
    const params = new Float64Array(7)
    const fixedMask = new Uint8Array([0])
    const encoded = encodeMateInput(1, params, fixedMask, [])
    expect(encoded.length).toBe(81)
    // The input magic is the version handshake; Rust rejects any other value.
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
    expect(view.getUint32(0, true)).toBe(fixture.magic)

    // One mate record adds exactly the fixture stride (212 bytes).
    const encodedWithMate = encodeMateInput(1, params, fixedMask, [{
      kindCode: 1,
      bodyA: 0, bodyB: 0,
      anchorKindA: 6, anchorKindB: 6,
      pointA: [0, 0, 0], axisA: [0, 0, 1],
      pointB: [1, 0, 0], axisB: [0, 0, 1],
      flip: false, offset: [0, 0, 0], ratio: 1, radius: 0, angle: 0,
      perpA: [0, 1, 0], perpB: [0, 1, 0], weight: 1,
    }])
    expect(encodedWithMate.length - encoded.length).toBe(fixture.record_bytes)
  })

  it('places angle at the documented offset in the mate record', () => {
    // Record layout after the 81-byte header+body+params+mask prefix (1 body):
    // kind(1) + bodyA(4) + bodyB(4) + anchorKinds(2) + pointA(24) + axisA(24)
    // + pointB(24) + axisB(24) + flags(1) + offset(24) + ratio(8) + radius(8) = 148,
    // then angle is the f64 at byte 148, followed by the two perp triples and
    // the weight.
    const params = new Float64Array(7)
    const fixedMask = new Uint8Array([0])
    const encoded = encodeMateInput(1, params, fixedMask, [{
      kindCode: 0,
      bodyA: 0, bodyB: 0,
      anchorKindA: 0, anchorKindB: 0,
      pointA: [0, 0, 0], axisA: [0, 0, 1],
      pointB: [0, 0, 0], axisB: [0, 0, 1],
      flip: false, offset: [0, 0, 0], ratio: 1, radius: 0, angle: Math.PI / 4,
      perpA: [0, 1, 0], perpB: [0, 1, 0], weight: 1,
    }])
    const recordStart = 81
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
    expect(view.getFloat64(recordStart + 148, true)).toBe(Math.PI / 4)
  })

  it('writes perp_a, perp_b then weight after angle, in that order', () => {
    // Distinct perps and a non-default weight, read back by their exact record
    // offsets: a swapped or mis-sized tail write is invisible when both sides
    // share the +Z default and weight 1 every real-WASM row uses.
    const params = new Float64Array(7)
    const fixedMask = new Uint8Array([0])
    const encoded = encodeMateInput(1, params, fixedMask, [{
      kindCode: 0,
      bodyA: 0, bodyB: 0,
      anchorKindA: 0, anchorKindB: 0,
      pointA: [0, 0, 0], axisA: [0, 0, 1],
      pointB: [0, 0, 0], axisB: [0, 0, 1],
      flip: false, offset: [0, 0, 0], ratio: 1, radius: 0, angle: 0,
      perpA: [1, 0, 0], perpB: [0, 0, 1], weight: 0.25,
    }])
    // angle ends at record byte 156; perp_a is 156..180, perp_b is 180..204,
    // and the weight f64 is the last field at 204..212.
    const recordStart = 81
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
    expect(view.getFloat64(recordStart + 156, true)).toBe(1)
    expect(view.getFloat64(recordStart + 164, true)).toBe(0)
    expect(view.getFloat64(recordStart + 172, true)).toBe(0)
    expect(view.getFloat64(recordStart + 180, true)).toBe(0)
    expect(view.getFloat64(recordStart + 188, true)).toBe(0)
    expect(view.getFloat64(recordStart + 196, true)).toBe(1)
    expect(view.getFloat64(recordStart + 204, true)).toBe(0.25)
  })
})
