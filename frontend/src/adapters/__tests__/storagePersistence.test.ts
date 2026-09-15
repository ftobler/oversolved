import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  checkStoragePersistence, requestStoragePersistence, durabilityNotice,
} from '../storagePersistence'
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

// Reading the grant and asking for it are separate calls because asking can put
// a permission prompt on screen. Boot reads; only a user gesture asks.
describe('checkStoragePersistence', () => {
  afterEach(() => { installStorage(undefined) })

  it('never asks for the grant', async () => {
    const persist = vi.fn(async () => true)
    installStorage({ persisted: async () => false, persist })
    expect(await checkStoragePersistence()).toBe('best-effort')
    expect(persist).not.toHaveBeenCalled()
  })

  it('reports a grant already in force', async () => {
    installStorage({ persisted: async () => true, persist: async () => true })
    expect(await checkStoragePersistence()).toBe('persisted')
  })

  it('reports unsupported when the API is absent or throws', async () => {
    installStorage(undefined)
    expect(await checkStoragePersistence()).toBe('unsupported')
    installStorage({ persist: async () => true, persisted: async () => { throw new Error('x') } })
    expect(await checkStoragePersistence()).toBe('unsupported')
  })
})

describe('useStoragePersistenceStore', () => {
  afterEach(() => {
    installStorage(undefined)
    resetStoragePersistenceRequest()
  })

  it('starts unknown and publishes what the browser already granted', async () => {
    installStorage({ persisted: async () => true, persist: async () => true })
    expect(useStoragePersistenceStore.getState().state).toBe('unknown')
    useStoragePersistenceStore.getState().ensureChecked()
    await vi.waitFor(() => expect(useStoragePersistenceStore.getState().state).toBe('persisted'))
  })

  // The boot check must not prompt, however many callers run it: the folder
  // handles follow the same rule, and a doorhanger in front of a visitor who
  // has not clicked anything is what both are avoiding.
  it('reads the grant at boot without ever asking for it', async () => {
    const persist = vi.fn(async () => true)
    installStorage({ persisted: async () => false, persist })
    const store = useStoragePersistenceStore.getState()
    store.ensureChecked()
    store.ensureChecked()
    store.ensureChecked()
    await vi.waitFor(() => expect(useStoragePersistenceStore.getState().state).toBe('best-effort'))
    expect(persist).not.toHaveBeenCalled()
  })

  it('asks on request and publishes the answer', async () => {
    const persist = vi.fn(async () => true)
    installStorage({ persisted: async () => false, persist })
    await useStoragePersistenceStore.getState().request()
    expect(persist).toHaveBeenCalledTimes(1)
    expect(useStoragePersistenceStore.getState().state).toBe('persisted')
  })
})
