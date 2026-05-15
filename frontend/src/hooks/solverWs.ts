import type { GeometryHeader } from '@/utils/geometryUnpack'
import { useSolverStore } from '@/stores/solverStore'

export type GeometryListener = (msgId: number, header: GeometryHeader, buffer: ArrayBuffer, jsonHeaderLen: number) => void

/**
 * Singleton WebSocket solver client. One connection per document session.
 */
class SolverWs {
  private ws: WebSocket | null = null;
  private resolveMap = new Map<number, (value: unknown) => void>();
  private rejectMap = new Map<number, (reason: unknown) => void>();
  private geometryListeners = new Set<GeometryListener>();
  private msgId = 0;
  private pendingMessages: string[] = []
  private connectTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private intentionallyClosed = false;
  private reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;

  onGeometryUpdate(cb: GeometryListener): () => void {
    this.geometryListeners.add(cb)
    return () => this.geometryListeners.delete(cb)
  }

  private _rejectAll(reason: string): void {
    this.pendingMessages = [];
    const rejects = Array.from(this.rejectMap.values());
    this.resolveMap.clear();
    this.rejectMap.clear();
    rejects.forEach(reject => reject(new Error(reason)));
  }

  private _clearConnectTimeout(): void {
    if (this.connectTimeoutId !== null) {
      clearTimeout(this.connectTimeoutId);
      this.connectTimeoutId = null;
    }
  }

  private _clearReconnectTimeout(): void {
    if (this.reconnectTimeoutId !== null) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }
  }

  connect(): void {
    this._clearReconnectTimeout();
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) return;
      if (this.ws.readyState === WebSocket.CONNECTING) return;
      this._rejectAll('WebSocket closed');
      this.ws = null;
    }
    this._clearConnectTimeout();
    this.intentionallyClosed = false;
    useSolverStore.getState().setWsStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/api/solver-ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    this.connectTimeoutId = setTimeout(() => {
      if (this.ws !== ws) return;
      this._clearConnectTimeout();
      this._rejectAll('WebSocket connection timed out');
      this.ws = null;
      ws.close();
      useSolverStore.getState().setWsStatus('closed');
    }, 15_000);

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this._clearConnectTimeout();
      useSolverStore.getState().setWsStatus('open');
      this.reconnectDelay = 1000;
      for (const msg of this.pendingMessages) {
        ws.send(msg);
      }
      this.pendingMessages = [];
      ws.send(JSON.stringify({ type: 'ping' }));
    };

    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      if (e.data instanceof ArrayBuffer) {
        this._handleBinaryFrame(e.data);
        return;
      }
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'solve_result' && data.msgId != null) {
          this.resolveMap.get(data.msgId)?.(data);
          this.resolveMap.delete(data.msgId);
          this.rejectMap.delete(data.msgId);
        }
      } catch {
        // Ignore invalid JSON from server
      }
    };

    ws.onerror = () => {
      // onclose follows, which will reject pending promises
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this._clearConnectTimeout();
      this._rejectAll('WebSocket closed');
      this.ws = null;
      useSolverStore.getState().setWsStatus(this.intentionallyClosed ? 'closed' : 'reconnecting');
      if (!this.intentionallyClosed) {
        this.reconnectTimeoutId = setTimeout(() => {
          this.reconnectTimeoutId = null;
          this.connect();
        }, this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      }
    };
  }

  solve(data: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const msgId = ++this.msgId;
      this.connect();
      this.resolveMap.set(msgId, resolve);
      this.rejectMap.set(msgId, reject);
      const msg = JSON.stringify({ type: 'solve', msgId, ...data });
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(msg);
      } else {
        this.pendingMessages.push(msg);
      }
    });
  }

  private _handleBinaryFrame(buf: ArrayBuffer): void {
    try {
      const view = new DataView(buf);
      const jsonHeaderLen = view.getUint32(0);
      const jsonBytes = new Uint8Array(buf, 4, jsonHeaderLen);
      // Trim null padding before parsing.
      let end = jsonHeaderLen;
      while (end > 0 && jsonBytes[end - 1] === 0) end--;
      const jsonStr = new TextDecoder().decode(new Uint8Array(buf, 4, end));
      const header = JSON.parse(jsonStr) as import('@/utils/geometryUnpack').GeometryHeader;
      for (const listener of this.geometryListeners) {
        listener(header.msgId, header, buf, jsonHeaderLen);
      }
    } catch (e) {
      console.error('[SolverWS] Error handling binary frame:', e);
    }
  }

  disconnect(): void {
    this.intentionallyClosed = true;
    this._clearReconnectTimeout();
    this._clearConnectTimeout();
    this.ws?.close();
    this.ws = null;
    this._rejectAll('WebSocket closed');
    useSolverStore.getState().setWsStatus('closed');
  }
}

export const solverWs = new SolverWs();
