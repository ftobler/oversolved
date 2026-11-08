// @vitest-environment node
//
// Grep gate for the rev 3 wire: no f32 scalar may survive in either wire
// codec or in the byte cursor they share. The files are read from disk and
// their comments stripped first: history comments legitimately explain why f32
// was dropped, but no executable line may still select a 32-bit width.
// `solveAssembly.ts` keeps `Float32Array` for mesh vertices (render data, never
// the wire), so for that one only the DataView accessors are banned.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../../..')

/** Strip block and line comments so doc history mentioning f32 does not trip the gate. */
function codeOnly(relPath: string): string {
  const text = readFileSync(path.resolve(root, relPath), 'utf8')
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

const WIRE_CODEC_FILES = [
  'frontend/src/wasm-kernel/codec.ts',
  'sketch-solver/src/codec.rs',
  'mate-solver/src/codec.rs',
  'mate-solver/src/mate.rs',
  'sketch-solver/tests/node/flatCodec.mjs',
  // The shared little-endian cursor: a 32-bit accessor here would let a future
  // codec quietly reintroduce the width both wires deliberately dropped.
  'solver-core/src/bytes.rs',
]

describe('rev 3 wire codecs carry no f32', () => {
  for (const rel of WIRE_CODEC_FILES) {
    it(`${rel} has no f32 scalar left`, () => {
      const code = codeOnly(rel)
      expect(code).not.toMatch(/f32/i)
    })
  }

  it('solveAssembly.ts writes no 32-bit value on the mate wire', () => {
    // Float32Array legitimately remains for mesh vertices (render data, never
    // the wire), but no DataView accessor may select a 32-bit width.
    const code = codeOnly('frontend/src/kernel/solveAssembly.ts')
    expect(code).not.toMatch(/setFloat32|getFloat32/)
  })
})
