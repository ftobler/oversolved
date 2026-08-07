// The invariant layer is a dev/test-only harness by design (user decision
// 2026-08-05, Option B): it runs only at the validateWithRepair gates, all
// gated `devOnly || testMode`, and production carries a violating write
// silently until a later gate or a test catches it. A store subscription that
// validated every mutation would silently turn the harness into a production
// guard, so this source scan pins the contract, the same way the other noDead*
// guards pin theirs: comments are stripped so prose cannot trip it.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const STORE = join(__dirname, '../sketchEditorStore.ts')

function liveText(): string {
  const text = readFileSync(STORE, 'utf8')
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, '')
  return noBlock.replace(/(?:^|\s)\/\/[^\n]*/g, '')
}

describe('invariant layer stays a dev/test-only harness', () => {
  it('the store never wires a subscription that runs validation', () => {
    expect(liveText()).not.toMatch(/\.subscribe\(/)
  })

  it('every validateWithRepair gate is devOnly || testMode gated', () => {
    const text = liveText()
    const calls = text.match(/validateWithRepair\(get, set\)/g) ?? []
    const gates = text.match(/devOnly \|\| testMode/g) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(4)
    expect(calls.length).toBe(gates.length)
  })
})
