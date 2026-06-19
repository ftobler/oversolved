import { describe, it, expect } from 'vitest'
import 'fake-indexeddb/auto'
import { resolveBackend, getLocalStore, getCloudStore } from '../index'
import { HttpDocumentStore } from '../HttpDocumentStore'
import { IndexedDbDocumentStore } from '../IndexedDbDocumentStore'

describe('backend selector', () => {
  it('resolveBackend opts into static only on the explicit flag', () => {
    expect(resolveBackend('static')).toBe('static')
    expect(resolveBackend('http')).toBe('http')
    expect(resolveBackend(undefined)).toBe('http')
    expect(resolveBackend('anything-else')).toBe('http')
  })

  it('getLocalStore is always the IndexedDB home and memoizes', () => {
    // Local is home on BOTH builds, independent of the backend flag.
    const a = getLocalStore()
    const b = getLocalStore()
    expect(a).toBeInstanceOf(IndexedDbDocumentStore)
    expect(a).toBe(b)
  })

  it('getCloudStore is the HTTP store on a server build and memoizes', () => {
    // Default test env = http, so the cloud domain is structurally available.
    const a = getCloudStore()
    const b = getCloudStore()
    expect(a).toBeInstanceOf(HttpDocumentStore)
    expect(a).toBe(b)
  })
})
