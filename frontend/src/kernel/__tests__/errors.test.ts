// A C++ throw crossing out of the OCC wasm module (built with wasm exception
// handling) arrives as a `WebAssembly.Exception`, which stringifies to nothing
// useful, and a kernel refusal once reached the user as a bare number. These pin
// the decode that turns it back into a name. No OCC: the two emscripten helpers
// the decoder needs (getExceptionMessage, decrementExceptionRefcount) are small
// enough to stand in for, over a real WebAssembly.Exception. The live module is
// probed in occ/__tests__/occt8SurfaceReal.test.ts.

import { describe, it, expect } from 'vitest'
import {
  extractErrorMessage,
  extractOccErrorMessage,
  isHeapCorruptionTrap,
  isKernelTrap,
  isWasmException,
  KernelFault,
  occThrowTypeName,
  releaseOccException,
} from '../errors'

const tag = new (WebAssembly as unknown as { Tag: new (t: { parameters: string[] }) => object })
  .Tag({ parameters: ['i32'] })

/** A thrown C++ object as JS receives it from a `-fwasm-exceptions` module. */
function cppThrow(): unknown {
  const Exception = (WebAssembly as unknown as { Exception: new (tag: object, payload: number[]) => unknown })
    .Exception
  return new Exception(tag, [1024])
}

/** Stand-in for the module's exception helpers, recording every release. */
function fakeGlue(type: string, what: string | undefined) {
  const released: unknown[] = []
  return {
    getExceptionMessage: (_e: unknown): [string, string | undefined] => [type, what],
    decrementExceptionRefcount: (e: unknown) => { released.push(e) },
    released,
  }
}

describe('extractErrorMessage', () => {
  it('keeps an Error message', () => {
    expect(extractErrorMessage(new Error('boom'))).toBe('boom')
  })

  it('says what a wasm exception is when the module is not in hand', () => {
    const msg = extractErrorMessage(cppThrow())
    expect(msg).toContain('C++ exception')
    expect(msg).not.toContain('[object')
  })

  it('names a bare number as a wasm exception pointer rather than printing it alone', () => {
    const msg = extractErrorMessage(6684320)
    expect(msg).toContain('6684320')
    expect(msg).toContain('C++ throw')
    expect(msg).not.toBe('6684320')
  })

  it('stringifies anything else unchanged', () => {
    expect(extractErrorMessage('plain')).toBe('plain')
    expect(extractErrorMessage(null)).toBe('null')
  })
})

describe('isWasmException', () => {
  it('tells a C++ throw from a JS error, a trap and a number', () => {
    expect(isWasmException(cppThrow())).toBe(true)
    expect(isWasmException(new Error('x'))).toBe(false)
    expect(isWasmException(new WebAssembly.RuntimeError('unreachable'))).toBe(false)
    expect(isWasmException(2048)).toBe(false)
  })
})

describe('occThrowTypeName', () => {
  it('reads the C++ class of a thrown exception', () => {
    expect(occThrowTypeName(fakeGlue('StdFail_NotDone', undefined), cppThrow())).toBe('StdFail_NotDone')
  })

  it('returns null for a throw that is not a wasm exception', () => {
    const glue = fakeGlue('StdFail_NotDone', undefined)
    expect(occThrowTypeName(glue, new Error('x'))).toBeNull()
    expect(occThrowTypeName(glue, 'x')).toBeNull()
    expect(occThrowTypeName(glue, 2048)).toBeNull()
  })

  it('returns null when the module does not expose the glue', () => {
    // The decode degrades, it never throws.
    expect(occThrowTypeName({}, cppThrow())).toBeNull()
    expect(occThrowTypeName(null, cppThrow())).toBeNull()
  })

  it('refuses an implausibly long name rather than splicing it into a message', () => {
    expect(occThrowTypeName(fakeGlue('x'.repeat(500), undefined), cppThrow())).toBeNull()
  })

  it('returns null instead of letting a decode failure mask the original error', () => {
    const glue = fakeGlue('StdFail_NotDone', undefined)
    glue.getExceptionMessage = () => { throw new Error('heap read failed') }
    expect(occThrowTypeName(glue, cppThrow())).toBeNull()
  })

  it('only reads: naming the type alone does not release the exception', () => {
    const glue = fakeGlue('StdFail_NotDone', undefined)
    occThrowTypeName(glue, cppThrow())
    expect(glue.released).toEqual([])
  })
})

describe('extractOccErrorMessage', () => {
  it('names the OCC class and its message, and releases the exception', () => {
    const glue = fakeGlue('Standard_ConstructionError', 'gp_Circ() - radius should be positive number')
    const e = cppThrow()
    const msg = extractOccErrorMessage(glue, e)
    expect(msg).toBe('OCC threw Standard_ConstructionError: gp_Circ() - radius should be positive number')
    // Until it is released the C++ object stays allocated in the wasm heap.
    expect(glue.released).toEqual([e])
  })

  it('leaves out a message that only repeats the type', () => {
    expect(extractOccErrorMessage(fakeGlue('StdFail_NotDone', 'StdFail_NotDone'), cppThrow()))
      .toBe('OCC threw StdFail_NotDone')
    expect(extractOccErrorMessage(fakeGlue('StdFail_NotDone', undefined), cppThrow()))
      .toBe('OCC threw StdFail_NotDone')
  })

  it('falls back to the plain message when it does not decode', () => {
    expect(extractOccErrorMessage({}, new Error('makeWire: only 3 of 4 edges connected')))
      .toBe('makeWire: only 3 of 4 edges connected')
  })
})

describe('releaseOccException', () => {
  it('releases a wasm exception and ignores anything else', () => {
    const glue = fakeGlue('StdFail_NotDone', undefined)
    const e = cppThrow()
    releaseOccException(glue, e)
    releaseOccException(glue, new Error('x'))
    releaseOccException(glue, 2048)
    expect(glue.released).toEqual([e])
  })

  it('swallows a failing release so it cannot replace the error', () => {
    const glue = fakeGlue('StdFail_NotDone', undefined)
    glue.decrementExceptionRefcount = () => { throw new Error('double free') }
    expect(() => releaseOccException(glue, cppThrow())).not.toThrow()
  })
})

describe('isKernelTrap', () => {
  it('recognises the wasm trap kinds that leave the heap undefined', () => {
    expect(isKernelTrap(new WebAssembly.RuntimeError('memory access out of bounds'))).toBe(true)
    const exitStatus = new Error('Program terminated with exit(1)')
    exitStatus.name = 'ExitStatus'
    expect(isKernelTrap(exitStatus)).toBe(true)
    expect(isKernelTrap(new Error('abort(Assertion failed: x)'))).toBe(true)
    expect(isKernelTrap(new Error('Aborted(both async and sync calls)'))).toBe(true)
  })

  it('does not treat a C++ exception pointer or a build error as a trap', () => {
    // The OCC layer throws its C++ exceptions as numbers; the module is still
    // usable after one of those, so retrying/reloading would be wrong.
    expect(isKernelTrap(6684320)).toBe(false)
    expect(isKernelTrap(new Error('extrude: no closed profile found'))).toBe(false)
    expect(isKernelTrap('plain')).toBe(false)
    expect(isKernelTrap(null)).toBe(false)
  })

  it('words a KernelFault so solve.lastError names the recovery', () => {
    const fault = new KernelFault('memory access out of bounds')
    expect(fault).toBeInstanceOf(Error)
    expect(fault.name).toBe('KernelFault')
    expect(fault.detail).toBe('memory access out of bounds')
    expect(fault.reloaded).toBe(true)
    expect(fault.message).toBe('kernel fault: memory access out of bounds; the kernel was reloaded')
    // A fault raised because the reload did not happen must not claim it did.
    // The flag is what crosses the MCP thread, so the host respawns the worker
    // without matching on this wording (drive/kernelHost.ts).
    const unrecovered = new KernelFault('the sketch solver could not be reloaded', false)
    expect(unrecovered.reloaded).toBe(false)
    expect(unrecovered.message).toBe('kernel fault: the sketch solver could not be reloaded')
  })
})

describe('isHeapCorruptionTrap', () => {
  it('separates linear-memory faults from embind destructor bookkeeping', () => {
    expect(isHeapCorruptionTrap(new WebAssembly.RuntimeError('memory access out of bounds'))).toBe(true)
    expect(isHeapCorruptionTrap(new WebAssembly.RuntimeError('unreachable'))).toBe(true)
    // The non-RuntimeError trap forms are fatal too.
    const exitStatus = new Error('Program terminated with exit(1)')
    exitStatus.name = 'ExitStatus'
    expect(isHeapCorruptionTrap(exitStatus)).toBe(true)
    expect(isHeapCorruptionTrap(new Error('abort(Assertion failed: x)'))).toBe(true)
    // These are what delete() on a proxy whose class registry is gone throws; they
    // must stay best-effort so cleanup still runs.
    expect(isHeapCorruptionTrap(new WebAssembly.RuntimeError('table index is out of bounds'))).toBe(false)
    expect(isHeapCorruptionTrap(new WebAssembly.RuntimeError('null function or function signature mismatch'))).toBe(false)
    expect(isHeapCorruptionTrap(new Error('native delete failed'))).toBe(false)
  })
})
