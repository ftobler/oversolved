// Normalize an unknown thrown value into a human-readable message. Errors keep
// their message; anything else is stringified.
//
// The "anything else" case is not hypothetical here: a C++ throw crossing out of
// the OCC wasm module arrives as a raw NUMBER (the emscripten exception
// pointer), so a kernel refusal used to reach the user as a red feature reading
// `6684320`. `extractOccErrorMessage` recovers the C++ type name from it; plain
// `extractErrorMessage` at least says what the number is.
export function extractErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'number') return describeThrownPointer(e)
  return String(e)
}

function describeThrownPointer(e: number): string {
  return `wasm exception pointer ${e} (a C++ throw with no JS message)`
}

/**
 * The emscripten glue members the type-name decode needs, as a structural type
 * so this module stays free of any OCC import.
 *
 * Probed against the installed opencascade.js@1.1.1 (OCC 7.5): the module
 * exports `HEAP32`, `___getTypeName` and `UTF8ToString`. It does NOT export
 * `getExceptionMessage` -- emscripten only emits that helper under ASSERTIONS,
 * and this build ships without it -- so the mangled type name is the most that
 * can be recovered, and `Face()` on a not-done builder does not even throw (it
 * returns a null shape), which is why the IsDone guards matter more than this.
 */
interface EmscriptenExceptionGlue {
  HEAP32: Int32Array
  ___getTypeName(typeInfo: number): number
  UTF8ToString(ptr: number): string
  // `___getTypeName` returns a freshly malloc'd copy of the name; the bundle's
  // own helper frees it right after reading. Optional so a build that stops
  // exporting `_free` degrades to a small leak instead of a decode failure.
  _free?(ptr: number): void
}

// A C++ class name is short. Anything longer means the ExceptionInfo offsets
// moved under us and we are reading arbitrary heap bytes, which must never be
// spliced into a message shown to the user.
const MAX_TYPE_NAME_LENGTH = 128

// Emscripten stores a 16-byte ExceptionInfo header immediately BEFORE the
// pointer it throws, with the std::type_info* at +8 inside it. Read out of the
// shipped 1.1.1 bundle (`ExceptionInfoAttrs`), not guessed.
const EXCEPTION_INFO_SIZE = 16
const EXCEPTION_TYPE_OFFSET = 8

function isExceptionGlue(oc: unknown): oc is EmscriptenExceptionGlue {
  if (typeof oc !== 'object' || oc === null) return false
  const m = oc as Record<string, unknown>
  return (
    ArrayBuffer.isView(m.HEAP32) &&
    typeof m.___getTypeName === 'function' &&
    typeof m.UTF8ToString === 'function'
  )
}

/** Itanium ABI length-prefixed name (`15StdFail_NotDone`) -> `StdFail_NotDone`. */
function demangle(name: string): string {
  const m = /^(\d+)(.+)$/.exec(name)
  if (m === null) return name
  return m[2].length === Number(m[1]) ? m[2] : name
}

/**
 * The C++ class of a thrown emscripten exception pointer (e.g.
 * `StdFail_NotDone`), or null when `e` is not such a pointer or the module does
 * not expose the glue. Never throws: a diagnostic must not become the failure.
 */
export function occThrowTypeName(oc: unknown, e: unknown): string | null {
  if (typeof e !== 'number' || !Number.isInteger(e) || e <= 0) return null
  if (!isExceptionGlue(oc)) return null
  try {
    const typeInfo = oc.HEAP32[(e - EXCEPTION_INFO_SIZE + EXCEPTION_TYPE_OFFSET) >> 2]
    if (!typeInfo) return null
    const namePtr = oc.___getTypeName(typeInfo)
    if (!namePtr) return null
    let raw: string
    try {
      raw = oc.UTF8ToString(namePtr)
    } finally {
      oc._free?.(namePtr)
    }
    if (!raw || raw.length > MAX_TYPE_NAME_LENGTH) return null
    return demangle(raw)
  } catch {
    return null
  }
}

/**
 * `extractErrorMessage` for a throw that came out of the OCC layer, where the
 * module is in hand and the C++ type name can be recovered.
 */
export function extractOccErrorMessage(oc: unknown, e: unknown): string {
  const typeName = occThrowTypeName(oc, e)
  if (typeName === null) return extractErrorMessage(e)
  return `OCC threw ${typeName} (${describeThrownPointer(e as number)})`
}
