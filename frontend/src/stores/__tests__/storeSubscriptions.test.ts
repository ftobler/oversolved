/**
 * Asserts that the per-entity hook and Zustand store state follow the
 * low-overhead subscription patterns introduced in fix-frontend-store-subscriptions.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { useSketchEditorStore } from '../sketchEditorStore'

const SRC = join(__dirname, '../../')

// ── test_store_subscription_count ────

describe('test_store_subscription_count', () => {
  it('useToolClickDispatch uses fewer than 5 useSketchEditorStore calls', () => {
    const src = readFileSync(
      join(SRC, 'components/Geometry3D/useToolClickDispatch.ts'),
      'utf8'
    )
    // Count top-level hook call sites (the useShallow-combined selector pattern
    // should collapse 15+ subscriptions into 1).
    const matches = src.match(/useSketchEditorStore\(/g) ?? []
    expect(matches.length).toBeLessThan(5)
  })
})

// ── test_no_functions_in_store ────

describe('test_no_functions_in_store', () => {
  it('sketchEditorStore state does not contain onMutation, onRebuild, or onExitSketch', () => {
    const state = useSketchEditorStore.getState() as unknown as Record<string, unknown>
    expect('onMutation' in state).toBe(false)
    expect('onRebuild' in state).toBe(false)
    expect('onExitSketch' in state).toBe(false)
  })
})
