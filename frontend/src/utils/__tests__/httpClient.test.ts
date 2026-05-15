import { describe, it, expect, vi, beforeEach } from 'vitest'
import { http, HttpError } from '../httpClient'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => mockFetch.mockReset())

function mockResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json', ...headers }),
    json: () => Promise.resolve(typeof body === 'string' ? JSON.parse(body) : body),
    text: () => Promise.resolve(text),
    blob: () => Promise.resolve(new Blob([text])),
  } as Response)
}

describe('http.getJson', () => {
  it('handles 200 success with JSON body', async () => {
    mockResponse(200, { user: 'alice' })
    const result = await http.getJson<{ user: string }>('/api/test')
    expect(result).toEqual({ user: 'alice' })
    expect(mockFetch).toHaveBeenCalledWith('/api/test')
  })

  it('throws HttpError on non-2xx response', async () => {
    mockResponse(404, 'not found')
    await expect(http.getJson('/api/missing')).rejects.toBeInstanceOf(HttpError)
    mockResponse(404, 'not found')
    await expect(http.getJson('/api/missing')).rejects.toMatchObject({ status: 404 })
  })

  it('throws HttpError on 500', async () => {
    mockResponse(500, 'internal error')
    const err = await http.getJson('/api/fail').catch(e => e) as HttpError
    expect(err).toBeInstanceOf(HttpError)
    expect(err.status).toBe(500)
    expect(err.body).toBe('internal error')
  })
})

describe('http.postJson', () => {
  it('sends JSON body and parses response', async () => {
    mockResponse(200, { id: 1 })
    const result = await http.postJson<{ id: number }>('/api/items', { name: 'test' })
    expect(result).toEqual({ id: 1 })
    expect(mockFetch).toHaveBeenCalledWith('/api/items', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ name: 'test' }),
    }))
  })

  it('throws HttpError on non-2xx', async () => {
    mockResponse(422, 'validation error')
    await expect(http.postJson('/api/items', {})).rejects.toBeInstanceOf(HttpError)
  })
})

describe('network error', () => {
  it('propagates network errors', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(http.getJson('/api/test')).rejects.toThrow('Failed to fetch')
  })
})

describe('HttpError', () => {
  it('has correct name and status', () => {
    const err = new HttpError(403, 'forbidden')
    expect(err.name).toBe('HttpError')
    expect(err.status).toBe(403)
    expect(err.body).toBe('forbidden')
    expect(err.message).toBe('HTTP 403')
  })
})
