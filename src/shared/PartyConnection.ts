// PartyConnection — TypeScript wrapper around the Party-Sockets WebSocket relay.
//
// Party-Sockets protocol (numeric slot indices):
//   Client → PS:  create { clientId, maxClients }
//   Client → PS:  join   { clientId, room }
//   Client → PS:  send   { data, to? }                          (to is a peer index)
//   PS → Client:  created      { room, instance, region, index }
//   PS → Client:  joined       { room, index, peers[] }         (peers is number[])
//   PS → Client:  peer_joined  { index }
//   PS → Client:  peer_left    { index }
//   PS → Client:  message      { from, data }                   (from is a peer index)
//   PS → Client:  error        { message }
//
// `clientId` is a server-side bearer secret used for slot reclaim — it never
// crosses the wire to other peers. The public peer identifier on the wire is
// the numeric slot index.

export type ProtocolMessage =
  | { type: 'created'; room: string; instance: string; region: string; index: number }
  | { type: 'joined'; room: string; index: number; peers: number[] }
  | { type: 'peer_joined'; index: number }
  | { type: 'peer_left'; index: number }
  | { type: 'error'; message: string };

export interface PartyConnectionOptions {
  clientId: string;
  maxReconnectAttempts?: number;
}

// Relay close code emitted when another connection presents the same clientId
// and reclaims this slot. Treat as terminal — the new connection owns the slot.
const CLOSE_CODE_REPLACED = 4000;

export class PartyConnection {
  readonly relayUrl: string;
  readonly clientId: string;
  ws: WebSocket | null = null;
  reconnectAttempt = 0;
  maxReconnectAttempts: number;

  // Our own slot index, populated from the first `created`/`joined` reply.
  // Null until the relay assigns a slot.
  ownIndex: number | null = null;

  onOpen: (() => void) | null = null;
  onClose: ((attempt: number, maxAttempts: number) => void) | null = null;
  onError: (() => void) | null = null;
  onMessage: ((from: number, data: unknown) => void) | null = null;
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
        if (msg.type === 'created' || msg.type === 'joined') {
          if (typeof msg.index === 'number') this.ownIndex = msg.index;
        }
        this.onProtocol?.(msg.type, msg);
      }
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      // Code 4000 = our slot was reclaimed by a newer connection presenting
      // the same clientId. Reconnecting would tear down whoever owns it now.
      if (event.code === CLOSE_CODE_REPLACED) {
        this._shouldReconnect = false;
        this.onClose?.(this.reconnectAttempt, this.maxReconnectAttempts);
        return;
      }
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

  create(maxClients: number): void {
    this._send({ type: 'create', clientId: this.clientId, maxClients });
  }

  join(room: string): void {
    this._send({ type: 'join', clientId: this.clientId, room });
  }

  sendTo(to: number, data: unknown): void {
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
