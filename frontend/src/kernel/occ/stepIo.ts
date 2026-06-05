// STEP read adapter for the import_step leaf (phase 2f). Writes the STEP bytes to
// the emscripten in-memory FS, reads them with STEPControl_Reader, and applies an
// optional uniform scale. STEP *export* (writing) is fragile under the headless
// test host and is deferred to phase 3 (server-side or Worker-side); reading
// externally-provided STEP bytes works here, which is all import needs.

import type { DisposeScope } from './disposeScope'
import type { OccModule, OccShape } from './occTypes'
import { makeScaleTrsf, transformCopy } from './transforms'

// A fixed short scratch path in the emscripten MEMFS. Two quirks of this OCC.js
// build forced both choices: STEPControl_Reader fails (RetError) on a long
// basename OR any path containing the substring "import", so the name is short
// and neutral. The kernel is single-threaded and each call writes -> reads ->
// unlinks synchronously, so reusing one path across calls is safe.
const STEP_SCRATCH_PATH = '/s.step'

/** Decode a base64 string to bytes (portable across Node + browser/Worker). */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Read STEP bytes into a shape, optionally scaled about the origin (mirrors
 * `step_file_to_shape`). The returned shape lives in `scope`; the caller owns it.
 */
export function stepBytesToShape(
  oc: OccModule,
  scope: DisposeScope,
  bytes: Uint8Array,
  scale = 1.0,
): OccShape {
  const path = STEP_SCRATCH_PATH
  oc.FS.writeFile(path, bytes)
  try {
    const reader = scope.track(new oc.STEPControl_Reader_1())
    const status = reader.ReadFile(path)
    // ReadFile may return a raw enum number or an embind enum object (.value).
    const enumVal = (e: unknown): number => (typeof e === 'number' ? e : (e as { value: number }).value)
    const statusVal = enumVal(status)
    const doneVal = enumVal(oc.IFSelect_ReturnStatus.IFSelect_RetDone)
    if (statusVal !== doneVal) {
      throw new Error(`import_step: STEP read failed (status ${statusVal})`)
    }
    reader.TransferRoots()
    const shape = reader.OneShape()
    if (scale !== 1.0) {
      return transformCopy(oc, scope, shape, makeScaleTrsf(oc, scope, [0, 0, 0], scale))
    }
    return shape
  } finally {
    try {
      oc.FS.unlink(path)
    } catch {
      // best-effort cleanup
    }
  }
}
