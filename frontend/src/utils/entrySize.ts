// The serialized payload length of a workspace entry: a document's UTF-8 text
// or a file's bytes. It is derived, never written to the manifest, so the
// payload-free projection can report sizes without materializing content (U1,
// U3). The manual counter avoids allocating a second copy of a large document
// on every write, which TextEncoder().encode would.
export function entrySizeOf(record: { kind: 'document' | 'file'; text?: string; bytes?: Uint8Array }): number {
  if (record.kind === 'file') return record.bytes?.byteLength ?? 0
  return record.text === undefined ? 0 : utf8ByteLength(record.text)
}

function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4  // a surrogate pair is one code point, four bytes
      i++
    } else bytes += 3
  }
  return bytes
}
