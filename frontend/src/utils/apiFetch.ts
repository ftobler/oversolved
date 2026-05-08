const _origFetch = globalThis.fetch.bind(globalThis)

globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const req = typeof input === 'string' ? new Request(input) : input instanceof URL ? new Request(input) : input
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const method = (init?.method ?? req.method ?? 'GET').toUpperCase()

  if (method !== 'GET' && method !== 'HEAD' && url.startsWith(location.origin + '/api/')) {
    const csrfCookie = document.cookie
      .split('; ')
      .find(row => row.startsWith('XSRF-TOKEN='))
    if (csrfCookie) {
      const token = csrfCookie.split('=')[1]
      init = init ?? {}
      init.headers = init.headers ?? {}
      if (init.headers instanceof Headers) {
        init.headers.set('X-XSRF-TOKEN', token)
      } else if (Array.isArray(init.headers)) {
        init.headers.push(['X-XSRF-TOKEN', token])
      } else {
        ;(init.headers as Record<string, string>)['X-XSRF-TOKEN'] = token
      }
    }
  }

  return _origFetch(input, init)
}
