/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { solverWs } from '@/hooks/solverWs'
import { useSolverStore } from '@/stores/solverStore'

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
  binaryType: string = 'arraybuffer'

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

  open(): void {
    this.readyState = WebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  receiveMessage(data: any): void {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
}

function getWs(index: number): MockWebSocket {
  return MockWebSocket.instances[index]
}

describe('SolverWs reconnect', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket as any)
    vi.useFakeTimers()
    // Advance clock so reconnectDeadline is in the future after connect()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
    solverWs.disconnect()
  })

  it('reconnects after unexpected close and retries pending solve', async () => {
    const promise = solverWs.solve({ test: 1 })
    const ws0 = getWs(0)
    ws0.open()

    // Server unexpectedly closes connection
    ws0.close()
    expect(useSolverStore.getState().wsStatus).toBe('reconnecting')
    expect(MockWebSocket.instances).toHaveLength(1)

    // Advance past first backoff delay (500ms)
    vi.advanceTimersByTime(600)
    expect(MockWebSocket.instances).toHaveLength(2)

    const ws1 = getWs(1)
    ws1.open()
    expect(useSolverStore.getState().wsStatus).toBe('open')

    // The message should be re-sent on the new connection
    const sentMsgs = ws1.sentMessages.filter(m => JSON.parse(m).type === 'solve')
    expect(sentMsgs).toHaveLength(1)

    // Resolve the re-sent message
    const msgId = JSON.parse(sentMsgs[0]).msgId
    ws1.receiveMessage({ type: 'solve_result', msgId, result: 'ok' })
    await expect(promise).resolves.toEqual(expect.objectContaining({ result: 'ok' }))
  })

  it('resets reconnect attempt counter on successful open', () => {
    solverWs.solve({ test: 1 }).catch(() => {})
    const ws0 = getWs(0)
    ws0.open()
    ws0.close()

    vi.advanceTimersByTime(600)
    const ws1 = getWs(1)
    ws1.open()
    // Second unexpected close should restart from first backoff delay
    ws1.close()

    vi.advanceTimersByTime(600)
    expect(MockWebSocket.instances).toHaveLength(3)
  })

  it('pauses reconnect when page is hidden and resumes on visible', () => {
    solverWs.solve({ test: 1 }).catch(() => {})
    const ws0 = getWs(0)
    ws0.open()
    ws0.close()

    // Hide the page while in 'reconnecting' state
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))

    // Even after the backoff delay passes, no new WS is created
    vi.advanceTimersByTime(600)
    expect(MockWebSocket.instances).toHaveLength(1)

    // Page becomes visible again; reconnect attempt count is 1, so delay is 1000ms
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))

    vi.advanceTimersByTime(1100)
    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it('stops reconnecting after deadline and rejects pending', async () => {
    const MAX_RECONNECT_MS = 30 * 60 * 1000
    const promise = solverWs.solve({ test: 1 }).catch((e: Error) => e)

    const ws0 = getWs(0)
    ws0.open()
    ws0.close()

    // Advance past the reconnect deadline
    vi.advanceTimersByTime(MAX_RECONNECT_MS + 10_000)

    const result = await promise
    expect(result).toBeInstanceOf(Error)
    expect((result as Error).message).toBe('WebSocket closed')
    expect(useSolverStore.getState().wsStatus).toBe('closed')
  })
})
