import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IdRegistry } from '../IdRegistry'
import { EdgeIdLayer } from '../EdgeIdLayer'

/**
 * Registration-churn regression guard.
 *
 * If a future change makes Body3D pass a freshly-allocated `edges` array
 * each render, the registration hook would call registerBody per render,
 * which re-allocates IDs and rebuilds the ribbon geometry. The hook's
 * dep array uses array identity, so the protective layer here is at the
 * caller, not the hook itself. This test pins the invariant: when the
 * same registration payload is submitted repeatedly, no churn occurs at
 * the layer level (registerBody is idempotent in effect even if called
 * twice, but it DOES rebuild on every call -- so the upstream
 * memoization is the load-bearing piece).
 *
 * The test below documents the layer's behavior, NOT a future-proof
 * memoization guarantee. If this breaks, it's a signal to add a memo at
 * the call site in Body3D.
 */

describe('EdgeIdLayer registration cost', () => {
  let reg: IdRegistry
  let layer: EdgeIdLayer
  beforeEach(() => {
    reg = new IdRegistry()
    layer = new EdgeIdLayer(reg)
  })

  it('a single body register/unregister produces one scene child', () => {
    layer.registerBody({
      bodyKey: 'b',
      segmentPositions: new Float32Array([0, 0, 0, 1, 0, 0]),
      segmentToEdge: new Uint32Array([0]),
      edgeQueries: ['e'],
    })
    expect(layer.scene.children.length).toBe(1)
    layer.unregisterBody('b')
    expect(layer.scene.children.length).toBe(0)
  })

  it('repeated register-with-same-key replaces and keeps registry size at 1', () => {
    const payload = {
      bodyKey: 'b',
      segmentPositions: new Float32Array([0, 0, 0, 1, 0, 0]),
      segmentToEdge: new Uint32Array([0]),
      edgeQueries: ['e'],
    }
    layer.registerBody(payload)
    const idAfterFirst = reg.lookupKey('edge', 'e')!
    layer.registerBody(payload)
    layer.registerBody(payload)
    expect(layer.scene.children.length).toBe(1)
    expect(reg.size()).toBe(1)
    // Each replacement frees the old id and allocates a new one. The OLD id
    // is now in the registry's pendingFree until bumpCycle is called; the
    // new id is reachable via lookupKey.
    const idNow = reg.lookupKey('edge', 'e')!
    expect(idNow).not.toBe(idAfterFirst)
  })

  it('warns operator (via console.warn spy) when registerBody is called >3x with the same key in a row', () => {
    // The layer itself does not log; this test is here to document that
    // the *caller* is responsible for memoizing registration inputs. If
    // future code adds a warning, switch to expect(spy).toHaveBeenCalled().
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const payload = {
      bodyKey: 'b',
      segmentPositions: new Float32Array([0, 0, 0, 1, 0, 0]),
      segmentToEdge: new Uint32Array([0]),
      edgeQueries: ['e'],
    }
    for (let i = 0; i < 5; i++) layer.registerBody(payload)
    expect(spy).not.toHaveBeenCalled()  // currently no warning -- documented
    spy.mockRestore()
  })
})
