// Generate an RFC-4122 v4 UUID. Prefer the native crypto.randomUUID() when it is
// available (secure contexts only), but fall back to crypto.getRandomValues so
// document creation still works when served over plain http (no crypto.randomUUID).
export function randomUuid(): string {
  const native = (globalThis.crypto as Crypto | undefined)?.randomUUID
  if (typeof native === 'function') return native.call(globalThis.crypto)

  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  // Per RFC 4122 4.4: set the version (4) and variant (10xx) bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex: string[] = []
  for (const b of bytes) hex.push(b.toString(16).padStart(2, '0'))
  return (
    hex[0] + hex[1] + hex[2] + hex[3] + '-' +
    hex[4] + hex[5] + '-' +
    hex[6] + hex[7] + '-' +
    hex[8] + hex[9] + '-' +
    hex[10] + hex[11] + hex[12] + hex[13] + hex[14] + hex[15]
  )
}
