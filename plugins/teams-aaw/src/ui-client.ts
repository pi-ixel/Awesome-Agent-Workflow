/**
 * Browser-side client for the bundle's business service.
 *
 * The mount context only carries `{bundleId, pageId, version}` — everything
 * else goes through same-origin HTTP.  Mutations require the local browser
 * session CSRF token, so port createBrowserFetch from the shell's
 * shared/browser-request.ts (kept self-contained: bundles must not import
 * host internals).
 */

type Fetcher = typeof fetch

export function createBrowserFetch(fetcher: Fetcher, now: () => number = Date.now) {
  let session: { csrfToken: string; expiresAt: number } | undefined
  let starting: Promise<void> | undefined

  async function ensureSession() {
    if (session && session.expiresAt > now() + 10_000) return
    if (!starting) {
      starting = (async () => {
        const response = await fetcher('/api/browser-session', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
        if (!response.ok) throw new Error('无法建立本地浏览器会话')
        const value = (await response.json()) as { csrfToken?: string; expiresAt?: number }
        if (
          !value ||
          !value.csrfToken ||
          !/^[A-Za-z0-9_-]{43}$/.test(value.csrfToken) ||
          !Number.isFinite(value.expiresAt) ||
          (value.expiresAt as number) <= now()
        ) {
          throw new Error('本地浏览器会话无效')
        }
        session = { csrfToken: value.csrfToken, expiresAt: value.expiresAt as number }
      })().finally(() => {
        starting = undefined
      })
    }
    await starting
  }

  return async (input: string, init: RequestInit = {}): Promise<Response> => {
    if (!input.startsWith('/api/') || ['GET', 'HEAD'].includes((init.method ?? 'GET').toUpperCase())) return fetcher(input, init)
    await ensureSession()
    const headers = new Headers(init.headers)
    headers.set('x-icode-csrf', session!.csrfToken)
    const response = await fetcher(input, { ...init, headers, credentials: 'same-origin', redirect: 'error' })
    if (response.status === 401) session = undefined
    // Never retry mutations automatically, including after a gateway restart.
    return response
  }
}

function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  } catch {
    /* non-secure context */
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export class AawClient {
  private readonly browserFetch: ReturnType<typeof createBrowserFetch>

  constructor(
    readonly bundleId: string,
    fetcher: Fetcher = fetch.bind(globalThis),
  ) {
    this.browserFetch = createBrowserFetch(fetcher)
  }

  async call<T = Record<string, unknown>>(operation: string, payload: Record<string, unknown> = {}): Promise<T> {
    const response = await this.browserFetch(`/api/bundles/${this.bundleId}/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schemaVersion: 1, requestId: randomId(), operation, payload }),
    })
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
    if (!response.ok) {
      const err = body['error']
      const message = typeof err === 'string' ? err : typeof err === 'object' && err !== null ? String((err as Record<string, unknown>)['message'] ?? '') : `请求失败 (${response.status})`
      throw new Error(message || `请求失败 (${response.status})`)
    }
    // The gateway wraps business results as `{ result: ... }`.
    const result = body['result']
    return (result !== undefined ? result : body) as T
  }
}
