import { describe, it, expect, vi } from 'vitest'

// Static build: no server, so the cloud domain is structurally absent (null).
vi.mock('@/config/capabilities', () => ({ backend: 'static', hasBackend: false, resolveBackend: (v: string) => v }))

import 'fake-indexeddb/auto'
import { getLocalStore, getCloudStore } from '../index'
import { IndexedDbDocumentStore } from '../IndexedDbDocumentStore'

describe('backend selector (static build)', () => {
  it('getLocalStore is still the IndexedDB home', () => {
    expect(getLocalStore()).toBeInstanceOf(IndexedDbDocumentStore)
  })

  it('getCloudStore is null -- no server to host a cloud domain', () => {
    expect(getCloudStore()).toBeNull()
  })
})
