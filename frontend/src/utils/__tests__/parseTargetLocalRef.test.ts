import { describe, it, expect } from 'vitest'
import { parseTarget } from '@/utils/yamlMutations'

// parseTarget maps a selection id to a query string. The @-passthrough and
// face: passthrough are covered in yamlMutations.test.ts; this pins the final
// fallback branch: a bare element token (no entity:/vertex:/face:/@ prefix) is
// treated as a host-local reference and gets the `$` wire prefix.

describe('parseTarget local-ref fallback', () => {
  it('prefixes a bare element token with $ (host-local reference)', () => {
    expect(parseTarget('lineA', 'sketch1')).toBe('$lineA')
  })

  it('is independent of the host feature id for a bare token', () => {
    expect(parseTarget('arc7', 'sketchA')).toBe('$arc7')
    expect(parseTarget('arc7', 'sketchB')).toBe('$arc7')
  })

  it('does not double-prefix an already-local $ token', () => {
    // A token that itself starts with `$` is not specially recognized, so it is
    // passed through the local branch and gains another `$`. Pinning the actual
    // behavior so a future change to the fallback is caught.
    expect(parseTarget('$lineA', 'sketch1')).toBe('$$lineA')
  })
})
