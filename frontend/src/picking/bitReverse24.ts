/**
 * Reverse the low 24 bits of `n`. Bit 0 ends up in position 23, bit 1 in 22,
 * and so on. Bijective over [0, 2^24).
 *
 * Used by the debug overlay to scramble sequential entity IDs into widely
 * separated values so neighbouring entities get visibly distinct colors.
 * The shader path (`IdDebugOverlay.frag`) duplicates this exact sequence;
 * keep the two in sync.
 */
export function bitReverse24(n: number): number {
  let v = (n & 0xFFFFFF) >>> 0
  // swap adjacent bits
  v = (((v & 0x555555) << 1) | ((v & 0xAAAAAA) >>> 1)) >>> 0
  // swap adjacent pairs
  v = (((v & 0x333333) << 2) | ((v & 0xCCCCCC) >>> 2)) >>> 0
  // swap nibbles within each byte
  v = (((v & 0x0F0F0F) << 4) | ((v & 0xF0F0F0) >>> 4)) >>> 0
  // reverse the three bytes
  v = (((v & 0x0000FF) << 16) | (v & 0x00FF00) | ((v & 0xFF0000) >>> 16)) >>> 0
  return v
}
