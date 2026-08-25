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

// Turn a thrown request error into a user-facing message: prefer the server's
// JSON `error` field on an HttpError, fall back to the given default, and
// stringify anything else (network errors, etc.). A body that isn't valid JSON
// (a proxy or load balancer returning an HTML error page instead of the app's
// JSON error format) falls back too, rather than throwing out of the caller's
// own catch block.
export function parseHttpError(e: unknown, fallback: string): string {
  if (e instanceof HttpError) {
    try {
      const parsed = JSON.parse(e.body || '{}') as { error?: string }
      return parsed.error || fallback
    } catch {
      return fallback
    }
  }
  return String(e)
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

// A 2xx body that is not JSON (a proxy interstitial, a captive portal) must
// surface as an HttpError carrying the raw text rather than escape as a bare
// SyntaxError: isConnectionError treats anything that is not an HttpError as
// "the cloud is unreachable", so an unclassified parse failure silently flips
// consumers like the document library into offline mode over what is really a
// misbehaving intermediary.
async function parseJsonBody<T>(res: Response): Promise<T> {
  const text = await res.text().catch(() => '')
  try {
    return JSON.parse(text) as T
  } catch {
    throw new HttpError(res.status, text)
  }
}

export const http = {
  async getJson<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await (init ? fetch(url, init) : fetch(url)).then(checkResponse)
    return parseJsonBody<T>(res)
  },

  async postJson<T>(url: string, body?: unknown, init?: RequestInit): Promise<T> {
    const res = await fetch(url, {
      ...init,
      method: 'POST',
      // init is spread FIRST and the merged headers set LAST: spreading init
      // after the headers used to let a caller's `headers` replace the whole
      // merged object, silently dropping the JSON Content-Type.
      headers: { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string>) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
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
      ...init,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string>) },
      body: JSON.stringify(body),
    }).then(checkResponse)
    const text = await res.text()
    return (text ? JSON.parse(text) : null) as T
  },

  async patchJson<T>(url: string, body: unknown, init?: RequestInit): Promise<T> {
    const res = await fetch(url, {
      ...init,
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string>) },
      body: JSON.stringify(body),
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
      ...init,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string>) },
      body: JSON.stringify(body),
    }).then(checkResponse)
    return res.blob()
  },
}
