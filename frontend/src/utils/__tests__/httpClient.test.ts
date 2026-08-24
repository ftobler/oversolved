import { describe, it, expect, vi, beforeEach } from 'vitest'
import { http, HttpError } from '@/utils/core/httpClient'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

beforeEach(() => mockFetch.mockReset())

function mockResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': headers['content-type'] ?? 'application/json', ...headers }),
    json: () => Promise.resolve(typeof body === 'string' ? JSON.parse(body) : body),
    text: () => Promise.resolve(text),
    blob: () => Promise.resolve(new Blob([text])),
  } as Response)
}

describe('HttpError', () => {
  it('creates with correct name, message, status, and body', () => {
    const err = new HttpError(500, 'Server Error')
    expect(err.name).toBe('HttpError')
    expect(err.message).toBe('HTTP 500')
    expect(err.status).toBe(500)
    expect(err.body).toBe('Server Error')
  })

  it('is instanceof HttpError', () => {
    const err = new HttpError(500, 'Server Error')
    expect(err).toBeInstanceOf(HttpError)
  })

  it('is instanceof Error', () => {
    const err = new HttpError(500, 'Server Error')
    expect(err).toBeInstanceOf(Error)
  })

  it('handles status 404 with empty body', () => {
    const err = new HttpError(404, '')
    expect(err.status).toBe(404)
    expect(err.body).toBe('')
    expect(err.message).toBe('HTTP 404')
    expect(err).toBeInstanceOf(HttpError)
  })
})

describe('http.getJson', () => {
  it('parses JSON response on 200 success', async () => {
    mockResponse(200, { user: 'alice' })
    const result = await http.getJson<{ user: string }>('/api/test')
    expect(result).toEqual({ user: 'alice' })
    expect(mockFetch).toHaveBeenCalledWith('/api/test')
  })

  it('throws HttpError on 500 non-ok response', async () => {
    mockResponse(500, 'internal error')
    const err = await http.getJson('/api/fail').catch(e => e) as HttpError
    expect(err).toBeInstanceOf(HttpError)
    expect(err.status).toBe(500)
    expect(err.body).toBe('internal error')
  })

  it('throws HttpError on 404 with correct status', async () => {
    mockResponse(404, 'not found')
    await expect(http.getJson('/api/missing')).rejects.toBeInstanceOf(HttpError)
    mockResponse(404, 'not found')
    await expect(http.getJson('/api/missing')).rejects.toMatchObject({ status: 404 })
  })

  it('passes init options to fetch', async () => {
    mockResponse(200, { ok: true })
    const init = { headers: { Authorization: 'Bearer token' } }
    await http.getJson('/api/test', init)
    expect(mockFetch).toHaveBeenCalledWith('/api/test', init)
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

  it('throws HttpError on 500 server error', async () => {
    mockResponse(500, 'server error')
    const err = await http.postJson('/api/items', {}).catch(e => e) as HttpError
    expect(err).toBeInstanceOf(HttpError)
    expect(err.status).toBe(500)
    expect(err.body).toBe('server error')
  })

  // Regression: init was spread AFTER the merged headers, so a caller passing
  // `headers` replaced the whole object and silently dropped Content-Type --
  // a JSON body arriving at the server as an unparseable payload.
  it('merges caller headers with Content-Type instead of letting them replace it', async () => {
    mockResponse(200, { ok: true })
    await http.postJson('/api/x', {}, { headers: { 'X-A': '1' } })
    const init = mockFetch.mock.calls[0][1] as RequestInit
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/json', 'X-A': '1' })
    // method/body survive the merge too.
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({}))
  })

  it.each([
    ['putJson', 'PUT'],
    ['patchJson', 'PATCH'],
    ['postBlob', 'POST'],
  ] as const)('http.%s keeps Content-Type when the caller passes headers', async (method, verb) => {
    mockResponse(200, { ok: true })
    await http[method]('/api/x', {})
    const bare = mockFetch.mock.calls[0][1] as RequestInit
    expect((bare.headers as Record<string, string>)['Content-Type']).toBe('application/json')

    mockResponse(200, { ok: true })
    await http[method]('/api/x', {}, { headers: { 'X-A': '1' } })
    const merged = mockFetch.mock.calls[1][1] as RequestInit
    expect(merged.headers).toMatchObject({ 'Content-Type': 'application/json', 'X-A': '1' })
    expect(merged.method).toBe(verb)
    expect(merged.body).toBe(JSON.stringify({}))
  })
})

describe('http.postBlob', () => {
  it('returns Blob on success', async () => {
    mockResponse(200, { exported: true })
    const result = await http.postBlob('/api/export', { format: 'stl' })
    expect(result).toBeInstanceOf(Blob)
  })

  it('throws HttpError on non-ok response', async () => {
    mockResponse(500, 'export failed')
    await expect(http.postBlob('/api/export', { format: 'stl' })).rejects.toBeInstanceOf(HttpError)
    mockResponse(500, 'export failed')
    await expect(http.postBlob('/api/export', { format: 'stl' })).rejects.toMatchObject({ status: 500 })
  })
})

describe('http.postForm', () => {
  it('sends FormData and parses response', async () => {
    mockResponse(200, { imported: true })
    const formData = new FormData()
    formData.append('file', new Blob(['content']), 'model.step')
    const result = await http.postForm<{ imported: boolean }>('/api/import', formData)
    expect(result).toEqual({ imported: true })
    expect(mockFetch).toHaveBeenCalledWith('/api/import', expect.objectContaining({
      method: 'POST',
      body: formData,
    }))
  })

  it('throws HttpError on upload failure', async () => {
    mockResponse(500, 'upload failed')
    const formData = new FormData()
    formData.append('file', new Blob(['content']), 'model.step')
    await expect(http.postForm('/api/import', formData)).rejects.toBeInstanceOf(HttpError)
    mockResponse(500, 'upload failed')
    await expect(http.postForm('/api/import', formData)).rejects.toMatchObject({ status: 500 })
  })
})

describe('network error', () => {
  it('propagates TypeError for failed fetch (not caught as HttpError)', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(http.getJson('/api/test')).rejects.toThrow('Failed to fetch')
    const err = await http.getJson('/api/test').catch(e => e)
    expect(err).toBeInstanceOf(TypeError)
    expect(err).not.toBeInstanceOf(HttpError)
  })
})
