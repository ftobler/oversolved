import { describe, it, expect } from 'vitest'
import 'fake-indexeddb/auto'
import { resolveBackend, createDocumentStore, getDocumentStore } from '../index'
import { HttpDocumentStore } from '../HttpDocumentStore'
import { IndexedDbDocumentStore } from '../IndexedDbDocumentStore'

describe('backend selector', () => {
  it('resolveBackend opts into static only on the explicit flag', () => {
    expect(resolveBackend('static')).toBe('static')
    expect(resolveBackend('http')).toBe('http')
    expect(resolveBackend(undefined)).toBe('http')
    expect(resolveBackend('anything-else')).toBe('http')
  })

  it('createDocumentStore returns the matching implementation', () => {
    expect(createDocumentStore('static')).toBeInstanceOf(IndexedDbDocumentStore)
    expect(createDocumentStore('http')).toBeInstanceOf(HttpDocumentStore)
  })

  it('getDocumentStore defaults to the HTTP store and memoizes', () => {
    // The test env does not set VITE_OVERSOLVED_BACKEND, so default = http.
    const a = getDocumentStore()
    const b = getDocumentStore()
    expect(a).toBeInstanceOf(HttpDocumentStore)
    expect(a).toBe(b)
  })
})
