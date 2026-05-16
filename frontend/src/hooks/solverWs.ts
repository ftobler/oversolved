import type { GeometryHeader } from '@/utils/geometryUnpack'
import { useSolverStore } from '@/stores/solverStore'

export type GeometryListener = (msgId: number, header: GeometryHeader, buffer: ArrayBuffer, jsonHeaderLen: number) => void

type PendingEntry = {
  msg: string
  sent: boolean
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

const BACKOFF_DELAYS = [500, 1000, 2000, 4000, 8000]
const MAX_RECONNECT_MS = 30 * 60 * 1000
const CONNECT_TIMEOUT_MS = 15_000

/**
 * Singleton WebSocket solver client. One connection per document session.
 * Auto-reconnects with exponential backoff on unexpected close.
 * In-flight solve requests are retried transparently on reconnect.
 */
class SolverWs {
  private ws: WebSocket | null = null
  private pending = new Map<number, PendingEntry>()
  private geometryListeners = new Set<GeometryListener>()
  private msgId = 0
  private connectTimeoutId: ReturnType<typeof setTimeout> | null = null
  private reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private reconnectDeadline = 0
  private intentionalClose = false

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          this._cancelReconnect()
        } else if (useSolverStore.getState().wsStatus === 'reconnecting') {
          this._scheduleReconnect()
        }
      })
    }
  }

  onGeometryUpdate(cb: GeometryListener): () => void {
    this.geometryListeners.add(cb)
    return () => this.geometryListeners.delete(cb)
  }

  private _rejectAll(reason: string): void {
    const entries = Array.from(this.pending.values())
    this.pending.clear()
    for (const { reject } of entries) {
      reject(new Error(reason))
    }
  }

  private _clearConnectTimeout(): void {
    if (this.connectTimeoutId !== null) {
      clearTimeout(this.connectTimeoutId)
      this.connectTimeoutId = null
    }
  }

  private _cancelReconnect(): void {
    if (this.reconnectTimeoutId !== null) {
      clearTimeout(this.reconnectTimeoutId)
      this.reconnectTimeoutId = null
    }
  }

  private _scheduleReconnect(): void {
    this._cancelReconnect()
    if (Date.now() > this.reconnectDeadline) {
      this._rejectAll('WebSocket closed')
      useSolverStore.getState().setWsStatus('closed')
      this.reconnectAttempts = 0
      return
    }
    const delay = BACKOFF_DELAYS[Math.min(this.reconnectAttempts, BACKOFF_DELAYS.length - 1)]
    this.reconnectAttempts++
    this.reconnectTimeoutId = setTimeout(() => {
      this.reconnectTimeoutId = null
      this._openWs()
    }, delay)
  }

  private _openWs(): void {
    useSolverStore.getState().setWsStatus('connecting')
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${proto}//${location.host}/api/solver-ws`)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    this.connectTimeoutId = setTimeout(() => {
      if (this.ws !== ws) return
      this._clearConnectTimeout()
      ws.close()
      this.ws = null
      if (!this.intentionalClose && this.pending.size > 0) {
        useSolverStore.getState().setWsStatus('reconnecting')
        this._scheduleReconnect()
      } else {
        this._rejectAll('WebSocket connection timed out')
        useSolverStore.getState().setWsStatus('closed')
      }
    }, CONNECT_TIMEOUT_MS)

    ws.onopen = () => {
      if (this.ws !== ws) return
      this._clearConnectTimeout()
      this.reconnectAttempts = 0
      useSolverStore.getState().setWsStatus('open')
      for (const entry of this.pending.values()) {
        if (!entry.sent) {
          ws.send(entry.msg)
          entry.sent = true
        }
      }
      ws.send(JSON.stringify({ type: 'ping' }))
    }

    ws.onmessage = (e) => {
      if (this.ws !== ws) return
      if (e.data instanceof ArrayBuffer) {
        this._handleBinaryFrame(e.data)
        return
      }
      try {
        const data = JSON.parse(e.data as string)
        if (data.type === 'solve_result' && data.msgId != null) {
          const entry = this.pending.get(data.msgId as number)
          if (entry) {
            entry.resolve(data)
            this.pending.delete(data.msgId as number)
          }
        }
      } catch {
        // Ignore invalid JSON from server
      }
    }

    ws.onerror = () => {
      // onclose follows; handled there
    }

    ws.onclose = () => {
      if (this.ws !== ws) return
      this._clearConnectTimeout()
      this.ws = null
      if (this.intentionalClose) {
        this._rejectAll('WebSocket closed')
        useSolverStore.getState().setWsStatus('closed')
      } else if (this.pending.size > 0) {
        // Mark all pending as unsent so they get re-sent on reconnect.
        for (const entry of this.pending.values()) entry.sent = false
        useSolverStore.getState().setWsStatus('reconnecting')
        this._scheduleReconnect()
      } else {
        useSolverStore.getState().setWsStatus('closed')
      }
    }
  }

  connect(): void {
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) return
      if (this.ws.readyState === WebSocket.CONNECTING) return
      this._rejectAll('WebSocket closed')
      this.ws = null
    }
    this._cancelReconnect()
    this.intentionalClose = false
    this.reconnectAttempts = 0
    this.reconnectDeadline = Date.now() + MAX_RECONNECT_MS
    this._openWs()
  }

  solve(data: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const msgId = ++this.msgId
      const msg = JSON.stringify({ type: 'solve', msgId, ...data })
      const entry: PendingEntry = { msg, sent: false, resolve, reject }
      this.pending.set(msgId, entry)
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
        this.connect()
      }
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(msg)
        entry.sent = true
      }
      // If connecting, message will be sent in onopen
    })
  }

  private _handleBinaryFrame(buf: ArrayBuffer): void {
    try {
      const view = new DataView(buf)
      const jsonHeaderLen = view.getUint32(0)
      const jsonBytes = new Uint8Array(buf, 4, jsonHeaderLen)
      let end = jsonHeaderLen
      while (end > 0 && jsonBytes[end - 1] === 0) end--
      const jsonStr = new TextDecoder().decode(new Uint8Array(buf, 4, end))
      const header = JSON.parse(jsonStr) as import('@/utils/geometryUnpack').GeometryHeader
      for (const listener of this.geometryListeners) {
        listener(header.msgId, header, buf, jsonHeaderLen)
      }
    } catch (e) {
      console.error('[SolverWS] Error handling binary frame:', e)
    }
  }

  disconnect(): void {
    this._cancelReconnect()
    this._clearConnectTimeout()
    this.intentionalClose = true
    this.ws?.close()
    this.ws = null
    this._rejectAll('WebSocket closed')
    useSolverStore.getState().setWsStatus('closed')
  }
}

export const solverWs = new SolverWs()
