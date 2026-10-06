// A C++ throw crossing out of the OCC wasm module arrives as a raw number, so a
// kernel refusal used to reach the user as a red feature reading `6684320`.
// These pin the decode that turns it back into a name. No OCC: the emscripten
// glue the decoder needs (HEAP32, ___getTypeName, UTF8ToString) is small enough
// to stand in for, and standing in for it is what makes the offset arithmetic
// testable at all.

import { describe, it, expect } from 'vitest'
import { extractErrorMessage, extractOccErrorMessage, occThrowTypeName } from '../errors'

/**
 * Minimal stand-in for the emscripten module. Lays out one ExceptionInfo the way
 * opencascade.js@1.1.1 does: a 16-byte header immediately BEFORE the thrown
 * pointer, with the std::type_info* at +8, and an Itanium-ABI length-prefixed
 * type name.
 */
function fakeGlue(excPtr: number, typeInfoPtr: number, mangled: string) {
  const heap = new Int32Array(4096)
  heap[(excPtr - 16 + 8) >> 2] = typeInfoPtr
  const freed: number[] = []
  return {
    HEAP32: heap,
    ___getTypeName: (t: number) => (t === typeInfoPtr ? 900 : 0),
    UTF8ToString: (p: number) => (p === 900 ? mangled : ''),
    _free: (p: number) => { freed.push(p) },
    freed,
  }
}

describe('extractErrorMessage', () => {
  it('keeps an Error message', () => {
    expect(extractErrorMessage(new Error('boom'))).toBe('boom')
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

describe('occThrowTypeName', () => {
  it('demangles the C++ class of a thrown exception pointer', () => {
    // The real value observed from BRepBuilderAPI_MakeWire on an empty builder.
    expect(occThrowTypeName(fakeGlue(2048, 850708, '15StdFail_NotDone'), 2048))
      .toBe('StdFail_NotDone')
  })

  it('leaves a name alone when the length prefix does not match', () => {
    expect(occThrowTypeName(fakeGlue(2048, 7, '99Weird'), 2048)).toBe('99Weird')
  })

  it('returns null for a throw that is not a pointer', () => {
    const glue = fakeGlue(2048, 7, '5Thing')
    expect(occThrowTypeName(glue, new Error('x'))).toBeNull()
    expect(occThrowTypeName(glue, 'x')).toBeNull()
    expect(occThrowTypeName(glue, -1)).toBeNull()
    expect(occThrowTypeName(glue, 1.5)).toBeNull()
  })

  it('returns null when the module does not expose the glue', () => {
    // opencascade.js@1.1.1 ships no getExceptionMessage, and a future build may
    // ship none of these either: the decode degrades, it never throws.
    expect(occThrowTypeName({}, 2048)).toBeNull()
    expect(occThrowTypeName(null, 2048)).toBeNull()
    expect(occThrowTypeName({ HEAP32: new Int32Array(8) }, 2048)).toBeNull()
  })

  it('frees the name the module malloc\'d for us', () => {
    // ___getTypeName hands back a fresh copy; a dirty feature re-runs the failing
    // build on every edit, so not freeing it leaks per keystroke.
    const glue = fakeGlue(2048, 850708, '15StdFail_NotDone')
    occThrowTypeName(glue, 2048)
    expect(glue.freed).toEqual([900])
  })

  it('refuses an implausibly long name rather than splicing heap text into a message', () => {
    const glue = fakeGlue(2048, 7, 'x'.repeat(500))
    expect(occThrowTypeName(glue, 2048)).toBeNull()
    expect(glue.freed).toEqual([900])  // still freed on the reject path
  })

  it('decodes without _free when the module does not export it', () => {
    const { _free: _unused, ...noFree } = fakeGlue(2048, 850708, '15StdFail_NotDone')
    expect(occThrowTypeName(noFree, 2048)).toBe('StdFail_NotDone')
  })

  it('returns null when the header holds no type info', () => {
    const glue = fakeGlue(2048, 0, '5Thing')
    expect(occThrowTypeName(glue, 2048)).toBeNull()
  })

  it('returns null when the type-name lookup yields no pointer', () => {
    const glue = fakeGlue(2048, 7, '5Thing')
    glue.___getTypeName = () => 0
    expect(occThrowTypeName(glue, 2048)).toBeNull()
  })

  it('keeps a name that carries no Itanium length prefix', () => {
    // A demangler must not mangle a name that is already human-readable.
    expect(occThrowTypeName(fakeGlue(2048, 7, 'StdFail_NotDone'), 2048)).toBe('StdFail_NotDone')
  })

  it('returns null instead of letting a decode failure mask the original error', () => {
    // The decode is a diagnostic: a heap read that throws must degrade to null,
    // never replace the failure it was trying to describe.
    const glue = fakeGlue(2048, 850708, '15StdFail_NotDone')
    glue.UTF8ToString = () => { throw new Error('heap read failed') }
    expect(occThrowTypeName(glue, 2048)).toBeNull()
  })
})

describe('extractOccErrorMessage', () => {
  it('names the OCC class when the pointer decodes', () => {
    const msg = extractOccErrorMessage(fakeGlue(2048, 850708, '15StdFail_NotDone'), 2048)
    expect(msg).toContain('StdFail_NotDone')
    expect(msg).toContain('2048')
  })

  it('falls back to the plain message when it does not', () => {
    expect(extractOccErrorMessage({}, new Error('makeWire: only 3 of 4 edges connected')))
      .toBe('makeWire: only 3 of 4 edges connected')
  })
})
