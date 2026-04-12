// PartyConnection — TypeScript port of Tetris's WebSocket relay wrapper.
// Public API matches the JS version 1:1.
//
// Party-Server protocol:
//   Client → PS:  create { clientId, maxClients }
//   Client → PS:  join   { clientId, room }
//   Client → PS:  send   { data, to? }
//   PS → Client:  created      { room }
//   PS → Client:  joined       { room, clients[] }
//   PS → Client:  peer_joined  { clientId }
//   PS → Client:  peer_left    { clientId }
//   PS → Client:  message      { from, data }
//   PS → Client:  error        { message }

export type ProtocolMessage =
  | { type: 'created'; room: string }
  | { type: 'joined'; room: string; clients: string[] }
  | { type: 'peer_joined'; clientId: string }
  | { type: 'peer_left'; clientId: string }
  | { type: 'error'; message: string };

export interface PartyConnectionOptions {
  clientId: string;
  maxReconnectAttempts?: number;
}

export class PartyConnection {
  readonly relayUrl: string;
  readonly clientId: string;
  ws: WebSocket | null = null;
  reconnectAttempt = 0;
  maxReconnectAttempts: number;

  onOpen: (() => void) | null = null;
  onClose: ((attempt: number, maxAttempts: number) => void) | null = null;
  onError: (() => void) | null = null;
  onMessage: ((from: string, data: unknown) => void) | null = null;
  onProtocol: ((type: ProtocolMessage['type'], msg: ProtocolMessage) => void) | null = null;

  private _shouldReconnect = true;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(relayUrl: string, options: PartyConnectionOptions) {
    this.relayUrl = relayUrl;
    this.clientId = options.clientId;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
  }

  connect(): void {
    this._discardOldWs();
    this._shouldReconnect = true;

    const ws = new WebSocket(this.relayUrl);
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return; // stale
      this.onOpen?.();
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      let msg: any;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'message') {
        this.onMessage?.(msg.from, msg.data);
      } else {
        this.onProtocol?.(msg.type, msg);
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.reconnectAttempt++;
      this.onClose?.(this.reconnectAttempt, this.maxReconnectAttempts);
      if (this._shouldReconnect && this.reconnectAttempt <= this.maxReconnectAttempts) {
        this._scheduleReconnect();
      }
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      this.onError?.();
    };
  }

  private _discardOldWs(): void {
    if (!this.ws) return;
    const old = this.ws;
    this.ws = null;
    old.onopen = old.onmessage = old.onclose = old.onerror = null;
    try {
      old.close();
    } catch {
      // ignore
    }
  }

  private _scheduleReconnect(): void {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    // Gentle backoff: 1s, 1.5s, 2.25s, 3.375s, capped at 5s
    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempt - 1), 5000);
    this._reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private _send(msg: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  create(maxClients: number, room?: string): void {
    const payload: any = { type: 'create', clientId: this.clientId, maxClients };
    if (room) payload.room = room;
    this._send(payload);
  }

  join(room: string): void {
    this._send({ type: 'join', clientId: this.clientId, room });
  }

  sendTo(to: string, data: unknown): void {
    this._send({ type: 'send', data, to });
  }

  broadcast(data: unknown): void {
    this._send({ type: 'send', data });
  }

  reconnectNow(): void {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this.connect();
  }

  resetReconnectCount(): void {
    this.reconnectAttempt = 0;
  }

  close(): void {
    this._shouldReconnect = false;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._discardOldWs();
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
