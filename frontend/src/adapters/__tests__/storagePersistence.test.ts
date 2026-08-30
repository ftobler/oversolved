import { describe, it, expect, afterEach, vi } from 'vitest'
import { requestStoragePersistence, durabilityNotice } from '../storagePersistence'
import {
  useStoragePersistenceStore, resetStoragePersistenceRequest,
} from '@/stores/storagePersistenceStore'

// jsdom ships no StorageManager, so each case installs the shape it is about.
function installStorage(manager: unknown): void {
  Object.defineProperty(navigator, 'storage', {
    value: manager, configurable: true, writable: true,
  })
}

describe('requestStoragePersistence', () => {
  afterEach(() => {
    installStorage(undefined)
    resetStoragePersistenceRequest()
  })

  it('reports unsupported when the API is absent (Firefox/Safari private modes)', async () => {
    installStorage(undefined)
    expect(await requestStoragePersistence()).toBe('unsupported')
  })

  it('reports unsupported when only part of the API exists', async () => {
    installStorage({ persisted: async () => false })  // no persist()
    expect(await requestStoragePersistence()).toBe('unsupported')
  })

  // A grant already in force must not be re-requested: some browsers re-run
  // their heuristics on every persist() call, so asking again risks a prompt
  // for a permission the origin already holds.
  it('does not re-request when the grant is already held', async () => {
    const persist = vi.fn(async () => true)
    installStorage({ persisted: async () => true, persist })
    expect(await requestStoragePersistence()).toBe('persisted')
    expect(persist).not.toHaveBeenCalled()
  })

  it('reports persisted when the browser grants the request', async () => {
    installStorage({ persisted: async () => false, persist: async () => true })
    expect(await requestStoragePersistence()).toBe('persisted')
  })

  it('reports best-effort when the browser declines', async () => {
    installStorage({ persisted: async () => false, persist: async () => false })
    expect(await requestStoragePersistence()).toBe('best-effort')
  })

  // A throw here (storage disabled, private mode) tells us the same thing an
  // absent API does, and must never surface as an unhandled rejection at boot.
  it('reports unsupported when the request throws', async () => {
    installStorage({ persisted: async () => false, persist: async () => { throw new Error('denied') } })
    expect(await requestStoragePersistence()).toBe('unsupported')
  })
})

describe('durabilityNotice', () => {
  it('says nothing until the browser has answered', () => {
    expect(durabilityNotice('unknown')).toBeNull()
  })

  it('names the eviction risk when the grant was declined', () => {
    expect(durabilityNotice('best-effort')).toMatch(/may discard them/)
  })

  it('says the library is safe from eviction when granted', () => {
    expect(durabilityNotice('persisted')).toMatch(/will not discard/)
  })

  it('admits it does not know when the API is missing', () => {
    expect(durabilityNotice('unsupported')).toMatch(/does not report/)
  })
})

describe('useStoragePersistenceStore', () => {
  afterEach(() => {
    installStorage(undefined)
    resetStoragePersistenceRequest()
  })

  it('starts unknown and publishes the browser answer once asked', async () => {
    installStorage({ persisted: async () => false, persist: async () => true })
    expect(useStoragePersistenceStore.getState().state).toBe('unknown')
    useStoragePersistenceStore.getState().ensureRequested()
    await vi.waitFor(() => expect(useStoragePersistenceStore.getState().state).toBe('persisted'))
  })

  // StrictMode double-invokes effects and boot asks too, so the guard has to
  // hold across every caller or a granted origin gets asked twice.
  it('asks the browser only once however many callers ensure it', async () => {
    const persist = vi.fn(async () => true)
    installStorage({ persisted: async () => false, persist })
    const store = useStoragePersistenceStore.getState()
    store.ensureRequested()
    store.ensureRequested()
    store.ensureRequested()
    await vi.waitFor(() => expect(useStoragePersistenceStore.getState().state).toBe('persisted'))
    expect(persist).toHaveBeenCalledTimes(1)
  })
})
