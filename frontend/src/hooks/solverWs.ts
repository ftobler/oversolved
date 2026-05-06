import type { GeometryHeader } from '../utils/geometryUnpack'

export type GeometryListener = (msgId: number, header: GeometryHeader, buffer: ArrayBuffer, jsonHeaderLen: number) => void

/**
 * Singleton WebSocket solver client. One connection per document session.
 */
class SolverWs {
  private ws: WebSocket | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private resolveMap = new Map<number, (value: any) => void>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private rejectMap = new Map<number, (reason: any) => void>();
  private geometryListeners = new Set<GeometryListener>();
  private msgId = 0;
  private pendingMessages: string[] = []
  private connectTimeoutId: ReturnType<typeof setTimeout> | null = null;

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

  connect(): void {
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) return;
      if (this.ws.readyState === WebSocket.CONNECTING) return;
      this._rejectAll('WebSocket closed');
      this.ws = null;
    }
    this._clearConnectTimeout();
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
    }, 15_000);

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this._clearConnectTimeout();
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
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  solve(data: Record<string, unknown>): Promise<any> {
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
      const header = JSON.parse(jsonStr) as import('../utils/geometryUnpack').GeometryHeader;
      for (const listener of this.geometryListeners) {
        listener(header.msgId, header, buf, jsonHeaderLen);
      }
    } catch {
      // Ignore malformed binary frames
    }
  }

  disconnect(): void {
    this._clearConnectTimeout();
    this.ws?.close();
    this.ws = null;
    this._rejectAll('WebSocket closed');
  }
}

export const solverWs = new SolverWs();
