/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { solverWs } from '../solverWs'

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3
  static instances: MockWebSocket[] = []
  readyState: number = WebSocket.OPEN
  onopen: ((event: any) => void) | null = null
  onmessage: ((event: any) => void) | null = null
  onclose: ((event: any) => void) | null = null
  url: string
  sentMessages: string[] = []

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sentMessages.push(data)
  }

  close(): void {
    this.readyState = WebSocket.CLOSED
    this.onclose?.(new Event('close'))
  }

  receiveMessage(data: any): void {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
}

function getLastWs(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1]
}

function lastSentMessage(): any {
  const ws = getLastWs()
  return JSON.parse(ws.sentMessages[ws.sentMessages.length - 1])
}

describe('SolverWs', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket as any)
    vi.useRealTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    solverWs.disconnect()
  })

  describe('lifecycle', () => {
    it('connect() creates WebSocket with correct URL', () => {
      solverWs.connect()
      expect(MockWebSocket.instances).toHaveLength(1)
      expect(MockWebSocket.instances[0].url).toBe(`ws://${location.host}/api/solver-ws`)
    })

    it('connect() is no-op if already OPEN', () => {
      solverWs.connect()
      solverWs.connect()
      expect(MockWebSocket.instances).toHaveLength(1)
    })

    it('disconnect() closes WebSocket and nulls ref', () => {
      solverWs.connect()
      const ws = getLastWs()
      solverWs.disconnect()
      expect(ws.readyState).toBe(WebSocket.CLOSED)

      solverWs.connect()
      expect(MockWebSocket.instances).toHaveLength(2)
    })

    it('disconnect() clears resolveMap and rejectMap', async () => {
      const promise = solverWs.solve({ test: true })
      solverWs.disconnect()
      await expect(promise).rejects.toThrow('WebSocket closed')
    })
  })

  describe('solve()', () => {
    it('calls connect() implicitly', () => {
      solverWs.solve({}).catch(() => {})
      expect(MockWebSocket.instances).toHaveLength(1)
    })

    it('returns Promise resolving with server response', async () => {
      const promise = solverWs.solve({ foo: 'bar' })
      const msg = lastSentMessage()
      getLastWs().receiveMessage({ type: 'solve_result', msgId: msg.msgId, result: 'ok' })
      await expect(promise).resolves.toEqual({ type: 'solve_result', msgId: msg.msgId, result: 'ok' })
    })

    it('assigns unique message IDs', () => {
      solverWs.solve({ a: 1 }).catch(() => {})
      solverWs.solve({ b: 2 }).catch(() => {})
      const msgs = getLastWs().sentMessages.map(m => JSON.parse(m))
      expect(msgs[0].msgId).not.toBe(msgs[1].msgId)
      expect(msgs[1].msgId).toBe(msgs[0].msgId + 1)
    })
  })

  describe('message handling', () => {
    it('solve_result with matching id resolves correct promise', async () => {
      const p1 = solverWs.solve({ x: 1 })
      const p2 = solverWs.solve({ y: 2 })
      const msg2 = lastSentMessage()
      const msg1 = JSON.parse(getLastWs().sentMessages[0])

      const results: string[] = []
      p1.then(() => results.push('p1'))
      p2.then(() => results.push('p2'))

      getLastWs().receiveMessage({ type: 'solve_result', msgId: msg2.msgId, result: 'second' })

      await null
      expect(results).toEqual(['p2'])

      getLastWs().receiveMessage({ type: 'solve_result', msgId: msg1.msgId, result: 'first' })
      await expect(p1).resolves.toBeDefined()
    })

    it('solve_result with unknown id is silently ignored', async () => {
      const promise = solverWs.solve({ x: 1 })
      const msg = lastSentMessage()

      getLastWs().receiveMessage({ type: 'solve_result', msgId: 999, result: 'unknown' })

      let resolved = false
      promise.then(() => { resolved = true })
      await null
      expect(resolved).toBe(false)

      getLastWs().receiveMessage({ type: 'solve_result', msgId: msg.msgId, result: 'real' })
      await expect(promise).resolves.toBeDefined()
    })

    it('Non-solve_result messages are ignored', async () => {
      const promise = solverWs.solve({})
      const msg = lastSentMessage()

      getLastWs().receiveMessage({ type: 'pong', data: 'hello' })
      getLastWs().receiveMessage({ type: 'error', message: 'err' })

      let resolved = false
      promise.then(() => { resolved = true })
      await null
      expect(resolved).toBe(false)

      getLastWs().receiveMessage({ type: 'solve_result', msgId: msg.msgId, result: 'done' })
      await expect(promise).resolves.toBeDefined()
    })

    it('Invalid JSON response is handled gracefully', () => {
      solverWs.connect()
      const ws = getLastWs()
      expect(() => {
        ws.onmessage?.({ data: 'invalid json!!!' })
      }).not.toThrow()
    })
  })

  describe('reconnection', () => {
    it('WebSocket close rejects all pending promises', async () => {
      const p1 = solverWs.solve({ a: 1 })
      const p2 = solverWs.solve({ b: 2 })

      getLastWs().close()

      await expect(p1).rejects.toThrow('WebSocket closed')
      await expect(p2).rejects.toThrow('WebSocket closed')
    })

    it('After disconnect, next solve() triggers reconnect', () => {
      solverWs.solve({ first: true }).catch(() => {})
      expect(MockWebSocket.instances).toHaveLength(1)

      solverWs.disconnect()
      solverWs.solve({ second: true }).catch(() => {})
      expect(MockWebSocket.instances).toHaveLength(2)
      const msg = lastSentMessage()
      expect(msg.type).toBe('solve')
      expect(msg.msgId).toBeGreaterThan(0)
    })

    it('connect() rejects orphanned promises when replacing a CLOSED WS', async () => {
      const p1 = solverWs.solve({ a: 1 })
      const ws1 = getLastWs()

      // Simulate WS closing without firing onclose
      ws1.readyState = WebSocket.CLOSED

      // This solve() should detect CLOSED WS, reject pending promises,
      // and create a new connection
      solverWs.solve({ b: 2 }).catch(() => {})

      await expect(p1).rejects.toThrow('WebSocket closed')
      expect(MockWebSocket.instances).toHaveLength(2)
    })
  })

  describe('ping on open', () => {
    it('sends ping after draining queued messages on onopen', () => {
      const ws = new MockWebSocket('ws://test/')
      ws.readyState = WebSocket.CONNECTING
      const wsCtor = vi.fn(() => ws) as any
      wsCtor.CONNECTING = 0
      wsCtor.OPEN = 1
      wsCtor.CLOSED = 3
      vi.stubGlobal('WebSocket', wsCtor)

      solverWs.solve({ a: 1 }).catch(() => {})

      expect(ws.sentMessages).toHaveLength(0)

      ws.onopen?.(new Event('open'))

      expect(ws.sentMessages).toHaveLength(2)
      expect(JSON.parse(ws.sentMessages[0]).type).toBe('solve')
      expect(JSON.parse(ws.sentMessages[1]).type).toBe('ping')
    })
  })

  describe('connection timeout', () => {
    it('rejects pending promises when timeout fires', async () => {
      const ws = new MockWebSocket('ws://test/')
      ws.readyState = WebSocket.CONNECTING
      const wsCtor = vi.fn(() => ws) as any
      wsCtor.CONNECTING = 0
      wsCtor.OPEN = 1
      wsCtor.CLOSED = 3
      vi.stubGlobal('WebSocket', wsCtor)
      vi.useFakeTimers()

      const promise = solverWs.solve({ a: 1 })

      vi.advanceTimersByTime(15_000)

      await expect(promise).rejects.toThrow('WebSocket connection timed out')
      expect(ws.readyState).toBe(WebSocket.CLOSED)
    })
  })
})
