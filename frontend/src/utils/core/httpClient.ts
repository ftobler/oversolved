export class HttpError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`HTTP ${status}`)
    this.name = 'HttpError'
    this.status = status
    this.body = body
  }
}

// A request that never reached a response -- server down, network lost, CORS --
// rejects with a TypeError, not an HttpError. This distinguishes "the cloud is
// unreachable" (go offline, fall back to local) from "the server answered with an
// error status" (a real HTTP failure we should surface). Used by the offline
// fallback in the document library (session-logout-offline).
export function isConnectionError(e: unknown): boolean {
  return !(e instanceof HttpError)
}

async function checkResponse(res: Response): Promise<Response> {
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new HttpError(res.status, body)
  }
  return res
}

export const http = {
  async getJson<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await (init ? fetch(url, init) : fetch(url)).then(checkResponse)
    return res.json() as Promise<T>
  },

  async postJson<T>(url: string, body?: unknown, init?: RequestInit): Promise<T> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string>) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...init,
    }).then(checkResponse)
    const text = await res.text()
    return (text ? JSON.parse(text) : null) as T
  },

  async postForm<T>(url: string, formData: FormData, init?: RequestInit): Promise<T> {
    const res = await fetch(url, { method: 'POST', body: formData, ...init }).then(checkResponse)
    return res.json() as Promise<T>
  },

  async putJson<T>(url: string, body: unknown, init?: RequestInit): Promise<T> {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string>) },
      body: JSON.stringify(body),
      ...init,
    }).then(checkResponse)
    const text = await res.text()
    return (text ? JSON.parse(text) : null) as T
  },

  async patchJson<T>(url: string, body: unknown, init?: RequestInit): Promise<T> {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string>) },
      body: JSON.stringify(body),
      ...init,
    }).then(checkResponse)
    const text = await res.text()
    return (text ? JSON.parse(text) : null) as T
  },

  async deleteJson<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, { method: 'DELETE', ...init }).then(checkResponse)
    const text = await res.text()
    return (text ? JSON.parse(text) : null) as T
  },

  async getBlob(url: string, init?: RequestInit): Promise<Blob> {
    const res = await (init ? fetch(url, init) : fetch(url)).then(checkResponse)
    return res.blob()
  },

  async postBlob(url: string, body: unknown, init?: RequestInit): Promise<Blob> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string>) },
      body: JSON.stringify(body),
      ...init,
    }).then(checkResponse)
    return res.blob()
  },
}
