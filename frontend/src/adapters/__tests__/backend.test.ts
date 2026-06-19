import { describe, it, expect } from 'vitest'
import { createBackend } from '@/adapters/backend'
import type { DocumentStore } from '@/stores/documentStore'

// A throwaway stand-in for the document store: createBackend just passes it
// through, so the methods never run in these tests.
const fakeStore = {} as DocumentStore

describe('backend capability bundle', () => {
  it('HTTP build wires every server-facing capability', () => {
    const bundle = createBackend('http', fakeStore)

    expect(bundle.documents).toBe(fakeStore)
    expect(bundle.telemetry).not.toBeNull()  // POST sink
    expect(bundle.docs).not.toBeNull()        // server-served markdown
    expect(bundle.sharing).not.toBeNull()     // user-to-user handover
  })

  it('static build keeps the always-present capabilities and drops the server-only ones', () => {
    const bundle = createBackend('static', fakeStore)

    // documents + telemetry survive offline (IndexedDB + file download).
    expect(bundle.documents).toBe(fakeStore)
    expect(bundle.telemetry).not.toBeNull()
    // No server -> these are structurally absent, not broken branches.
    expect(bundle.docs).toBeNull()
    expect(bundle.sharing).toBeNull()
  })
})
