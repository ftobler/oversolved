import { describe, it, expect } from 'vitest'
import { createBackend } from '@/adapters/backend'
import type { DocumentStore } from '@/stores/documentStore'

// Throwaway stand-ins for the stores: createBackend just passes them through, so
// the methods never run in these tests.
const fakeLocal = {} as DocumentStore
const fakeCloud = {} as DocumentStore

describe('backend capability bundle', () => {
  it('HTTP build wires every server-facing capability + a cloud domain', () => {
    const bundle = createBackend('http', fakeLocal, fakeCloud)

    expect(bundle.documents).toBe(fakeLocal)      // local IndexedDB home
    expect(bundle.cloudDocuments).toBe(fakeCloud)  // additive cloud domain
    expect(bundle.telemetry).not.toBeNull()  // POST sink
    expect(bundle.docs).not.toBeNull()        // server-served markdown
    expect(bundle.sharing).not.toBeNull()     // user-to-user handover
  })

  it('static build keeps the always-present capabilities and drops the server-only ones', () => {
    const bundle = createBackend('static', fakeLocal, null)

    // The local home + telemetry survive offline (IndexedDB + file download).
    expect(bundle.documents).toBe(fakeLocal)
    expect(bundle.telemetry).not.toBeNull()
    // No server -> these are structurally absent, not broken branches.
    expect(bundle.cloudDocuments).toBeNull()
    expect(bundle.docs).toBeNull()
    expect(bundle.sharing).toBeNull()
  })
})
