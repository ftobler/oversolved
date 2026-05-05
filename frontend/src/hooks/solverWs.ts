/**
 * Singleton WebSocket solver client. One connection per document session.
 */
class SolverWs {
  private ws: WebSocket | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private resolveMap = new Map<number, (value: any) => void>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private rejectMap = new Map<number, (reason: any) => void>();
  private msgId = 0;
  private pendingMessages: string[] = [];
  private connectTimeoutId: ReturnType<typeof setTimeout> | null = null;

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

  disconnect(): void {
    this._clearConnectTimeout();
    this.ws?.close();
    this.ws = null;
    this._rejectAll('WebSocket closed');
  }
}

export const solverWs = new SolverWs();
