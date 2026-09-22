// The invariant layer is a dev/test-only harness by design (user decision
// 2026-08-05, Option B): the store validates only at explicit gates, all gated
// `devOnly || testMode`, and production carries a violating write silently
// until a later gate or a test catches it. A store subscription that validated
// every mutation would silently turn the harness into a production guard.
//
// The gate is driven directly (mocked, like kernel/isDevBuild.test.ts) instead
// of counting source lines: with the gate off a gated transition must not
// validate, with it on the same transition must repair. The source scan below
// stays as the structural guard against ever wiring a subscription.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { useSketchEditorStore } from '../sketchEditorStore'

const STORE = join(__dirname, '../sketchEditorStore.ts')

const gate = vi.hoisted(() => ({ on: true }))

vi.mock('../stateInvariants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stateInvariants')>()
  return {
    ...actual,
    get devOnly() { return gate.on },
    get testMode() { return gate.on },
  }
})

function liveText(): string {
  const text = readFileSync(STORE, 'utf8')
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, '')
  return noBlock.replace(/(?:^|\s)\/\/[^\n]*/g, '')
}

// An id no declared prefix recognizes: repairSelectionState filters it out
// whenever a gate runs, so its survival proves no gate ran on this write.
function seedUnrecognizedSelection(): void {
  useSketchEditorStore.setState({
    normalSelection: new Set(['not-a-known-prefix']),
    selectedPicks: new Map(),
    chipOwnedSelection: new Set(),
    selectionDomain: 'sketch_2d',
    modeStack: [],
    activeTool: null,
    activePickField: null,
  })
}

const hasUnrecognized = () => useSketchEditorStore.getState().normalSelection.has('not-a-known-prefix')

describe('invariant layer stays a dev/test-only harness', () => {
  beforeEach(() => { gate.on = true })

  it('the store never wires a subscription that runs validation', () => {
    expect(liveText()).not.toMatch(/\.subscribe\(/)
  })

  it('every validateWithRepair call site is devOnly || testMode gated', () => {
    // The behavioral tests below drive one gate; this scan covers the rest:
    // a new gate added without the guard would slip through a count check but
    // not this per-call check.
    const lines = liveText().split('\n')
    const callLines = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.includes('validateWithRepair(get, set)'))
    expect(callLines.length).toBeGreaterThanOrEqual(4)
    for (const { index } of callLines) {
      const here = lines[index]
      const previous = lines[index - 1] ?? ''
      expect(here.includes('devOnly || testMode') || previous.includes('devOnly || testMode')).toBe(true)
    }
  })

  it('an ordinary write is carried untouched, so no subscription validates it', () => {
    seedUnrecognizedSelection()
    useSketchEditorStore.getState().setIsPointerDown(true)
    expect(hasUnrecognized()).toBe(true)
  })

  it('a gated transition does not validate while the dev/test gate is off', () => {
    gate.on = false
    seedUnrecognizedSelection()
    useSketchEditorStore.getState().clearDraw()
    expect(hasUnrecognized()).toBe(true)
  })

  it('a gated transition repairs the same violating write while the gate is on', () => {
    gate.on = true
    seedUnrecognizedSelection()
    useSketchEditorStore.getState().clearDraw()
    expect(hasUnrecognized()).toBe(false)
  })
})
