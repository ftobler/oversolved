import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { encodeMateInput, decodeMateOutput } from '../solveAssembly'
import { makeEchoSolver, readMateWireFixture, freshDb } from '../solveAssemblyTestUtils'

beforeEach(() => { freshDb() })

describe('mate wire format', () => {
  it('encode/decode round-trips params', () => {
    // Test the wire format indirectly: encode with known input,
    // decode the output from a fake solver that echoes params.
    const params = new Float32Array(14)
    for (let i = 0; i < 14; i++) params[i] = i * 0.1
    const fixedMask = new Uint8Array([0])
    const encoded = encodeMateInput(2, params, fixedMask, [])
    const solver = makeEchoSolver()
    const outputBytes = solver(encoded)
    const decoded = decodeMateOutput(outputBytes, 14)

    expect(decoded.paramsSolved).toHaveLength(14)
    for (let i = 0; i < 14; i++) {
      expect(decoded.paramsSolved[i]).toBeCloseTo(params[i])
    }
  })

  it('decode detects bad magic', () => {
    const bad = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0])
    expect(() => decodeMateOutput(bad, 0)).toThrow('bad mate output magic')
  })

  it('decode detects a params-count mismatch (short buffer, e.g. wrong bodyCount)', () => {
    const params = new Float32Array(7)
    const fixedMask = new Uint8Array([0])
    const encoded = encodeMateInput(1, params, fixedMask, [])
    const outputBytes = makeEchoSolver()(encoded)
    expect(() => decodeMateOutput(outputBytes, 14)).toThrow(/params/)
  })

  it('byte sizes align with Rust format', () => {
    const fixture = readMateWireFixture()
    // The rev and both magics are pinned here as literals as well as through the
    // fixture, so a stale fixture cannot hide a constant that moved on one side.
    expect(fixture.rev).toBe(3)
    expect(fixture.magic).toBe(0x3353544D)
    expect(fixture.magic_out).toBe(0x3252544D)
    // One empty body, no mates: header 20 + bodies 4 + params 28 + mask 1 = 53 bytes
    const params = new Float32Array(7)
    const fixedMask = new Uint8Array([0])
    const encoded = encodeMateInput(1, params, fixedMask, [])
    expect(encoded.length).toBe(53)
    // The input magic is the version handshake; Rust rejects any other value.
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
    expect(view.getUint32(0, true)).toBe(fixture.magic)

    // One mate record adds exactly the fixture stride (112 bytes).
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
    // Record layout after the 53-byte header+body+params+mask prefix (1 body):
    // kind(1) + bodyA(4) + bodyB(4) + anchorKinds(2) + pointA(12) + axisA(12)
    // + pointB(12) + axisB(12) + flags(1) + offset(12) + ratio(4) + radius(4) = 80,
    // then angle is the f32 at byte 80, followed by the two perp triples and the
    // weight. The offset is three f32s, so this is 8 bytes past where the scalar
    // form put it.
    const params = new Float32Array(7)
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
    const recordStart = 53
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
    expect(view.getFloat32(recordStart + 80, true)).toBeCloseTo(Math.PI / 4)
  })

  it('writes perp_a, perp_b then weight after angle, in that order', () => {
    // Distinct perps and a non-default weight, read back by their exact record
    // offsets: a swapped or mis-sized tail write is invisible when both sides
    // share the +Z default and weight 1 every real-WASM row uses.
    const params = new Float32Array(7)
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
    // angle ends at record byte 84; perp_a is 84..96, perp_b is 96..108, and the
    // weight f32 is the last field at 108..112.
    const recordStart = 53
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
    expect(view.getFloat32(recordStart + 84, true)).toBe(1)
    expect(view.getFloat32(recordStart + 88, true)).toBe(0)
    expect(view.getFloat32(recordStart + 92, true)).toBe(0)
    expect(view.getFloat32(recordStart + 96, true)).toBe(0)
    expect(view.getFloat32(recordStart + 100, true)).toBe(0)
    expect(view.getFloat32(recordStart + 104, true)).toBe(1)
    expect(view.getFloat32(recordStart + 108, true)).toBeCloseTo(0.25)
  })
})
