// DisplayConnection — owns the Party-Sockets WebSocket on the display side.
//
// Responsibilities:
//   - Create the room and resolve the join URL
//   - Render the QR code into <canvas#qr-code>
//   - Track player join/leave + assign colors from PLAYER_COLORS
//   - Dispatch INPUT messages back to RaceSim via callback
//   - Broadcast lobby/countdown/race-start/race-end messages

import {
  PartyConnection,
  type ProtocolMessage,
} from '@shared/PartyConnection';
import {
  RELAY_URL,
  MSG,
  TOTAL_LAPS,
  MAX_PLAYERS,
  PLAYER_COLORS,
  type RoomState,
  type InputState,
  type WelcomePayload,
  type LobbyUpdatePayload,
  type CountdownPayload,
  type LapUpdatePayload,
  type RaceEndPayload,
  type RaceEndStanding,
  type ErrorCode,
  type ErrorPayload,
  clamp,
} from '@shared/protocol';
import type { DisplayState } from './DisplayState';

export interface Player {
  id: string;
  name: string;
  color: string;
  carId: number; // 0..3, slot in the race
}

export interface DisplayConnectionCallbacks {
  onLobbyChanged: () => void;
  onPlayerInput: (clientId: string, input: InputState) => void;
  onStartRequested: () => void;
  onPauseRequested: () => void;
  onResumeRequested: () => void;
  onReturnToLobbyRequested: () => void;
  onPlayAgainRequested: () => void;
  // Relay connection lifecycle for the display itself. attempt counts up
  // while reconnecting; exhausted=true means no more automatic retries.
  onRelayLost: (attempt: number, max: number, exhausted: boolean) => void;
  onRelayRestored: () => void;
  // Returns true if new players are still allowed (i.e. lobby state, room not full).
  isAcceptingPlayers: () => boolean;
  // Current room state — echoed to the joining controller via WELCOME so it
  // can render a "Game in progress" wait state.
  getRoomState: () => RoomState;
}

export class DisplayConnection {
  private party: PartyConnection | null = null;
  private state: DisplayState;
  private callbacks: DisplayConnectionCallbacks;

  constructor(state: DisplayState, callbacks: DisplayConnectionCallbacks) {
    this.state = state;
    this.callbacks = callbacks;
  }

  connectAndCreateRoom(): void {
    if (this.party) this.party.close();

    // Eagerly fetch the LAN base URL on localhost so the QR is reachable from phones.
    this.fetchBaseUrl();

    this.party = new PartyConnection(RELAY_URL, { clientId: 'display' });

    this.party.onOpen = () => {
      // Capacity is intentionally larger than MAX_PLAYERS so that late joiners
      // and over-capacity peers can still reach the display long enough to
      // receive a friendly MSG.ERROR rejection (otherwise the relay would
      // silently bounce them with a low-level error).
      this.party!.create(MAX_PLAYERS + 5);
    };

    this.party.onProtocol = (type, msg) => this.handleProtocol(type, msg);

    this.party.onMessage = (from, data) => {
      if (from === 'display') return; // shouldn't happen, but ignore self
      this.handleControllerMessage(from, data);
    };

    this.party.onClose = (attempt, max) => {
      console.warn(`[display] WS closed (attempt ${attempt}/${max})`);
      const exhausted = attempt > max;
      this.callbacks.onRelayLost(attempt, max, exhausted);
    };

    this.party.connect();
  }

  private handleProtocol(type: ProtocolMessage['type'], msg: ProtocolMessage): void {
    switch (type) {
      case 'created':
        this.callbacks.onRelayRestored();
        this.onRoomCreated((msg as { type: 'created'; room: string }).room);
        break;
      case 'joined':
        // Display rejoined an existing room (after reconnect).
        break;
      case 'peer_joined':
        this.onPeerJoined((msg as { type: 'peer_joined'; clientId: string }).clientId);
        break;
      case 'peer_left':
        this.onPeerLeft((msg as { type: 'peer_left'; clientId: string }).clientId);
        break;
      case 'error':
        console.warn('[display] Party-Server error:', (msg as { type: 'error'; message: string }).message);
        break;
    }
  }

  private onRoomCreated(roomCode: string): void {
    this.state.roomCode = roomCode;
    const baseUrl = this.state.baseUrlOverride || window.location.origin;
    this.state.joinUrl = `${baseUrl}/${roomCode}`;

    const urlEl = document.getElementById('join-url');
    if (urlEl) urlEl.textContent = this.state.joinUrl;

    this.fetchAndRenderQR(this.state.joinUrl);
  }

  private onPeerJoined(clientId: string): void {
    if (this.state.players.has(clientId)) return;

    // Late joiners during a race are admitted as "waiting" players —
    // they sit in their own lobby with a "Game in progress" message until
    // the next race begins (when they're picked up by RaceSim's snapshot).
    if (this.state.players.size >= MAX_PLAYERS) {
      this.sendError(clientId, 'room_full', 'Room is full');
      return;
    }

    const carId = this.nextAvailableSlot();
    if (carId < 0) {
      this.sendError(clientId, 'room_full', 'Room is full');
      return;
    }

    const player: Player = {
      id: clientId,
      name: `P${carId + 1}`,
      color: PLAYER_COLORS[carId % PLAYER_COLORS.length],
      carId,
    };
    this.state.players.set(clientId, player);
    this.state.playerOrder.push(clientId);
    this.callbacks.onLobbyChanged();
    this.broadcastLobbyUpdate();
  }

  private sendError(clientId: string, code: ErrorCode, message: string): void {
    const payload: ErrorPayload = { type: MSG.ERROR, code, message };
    this.party?.sendTo(clientId, payload);
  }

  private onPeerLeft(clientId: string): void {
    if (!this.state.players.has(clientId)) return;
    this.state.players.delete(clientId);
    this.state.playerOrder = this.state.playerOrder.filter((id) => id !== clientId);
    this.callbacks.onLobbyChanged();
    this.broadcastLobbyUpdate();
  }

  private nextAvailableSlot(): number {
    const used = new Set<number>();
    for (const p of this.state.players.values()) used.add(p.carId);
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (!used.has(i)) return i;
    }
    return -1;
  }

  private handleControllerMessage(from: string, data: any): void {
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;

    switch (data.type) {
      case MSG.HELLO: {
        const player = this.state.players.get(from);
        if (!player) {
          // Peer was rejected at peer_joined (room full) — echo so they
          // leave the "Connecting…" state cleanly.
          this.sendError(from, 'room_full', 'Room is full');
          break;
        }
        if (typeof data.name === 'string' && data.name.trim()) {
          player.name = data.name.trim().slice(0, 16);
          this.callbacks.onLobbyChanged();
          this.broadcastLobbyUpdate();
        }
        // Send WELCOME with the assigned car id and color.
        const welcome: WelcomePayload = {
          type: MSG.WELCOME,
          carId: player.carId,
          color: player.color,
          name: player.name,
          roomState: this.callbacks.getRoomState(),
          totalLaps: TOTAL_LAPS,
        };
        this.party?.sendTo(from, welcome);
        break;
      }
      case MSG.INPUT: {
        const steer = clamp(Number(data.steer) || 0, -1, 1);
        const brake = clamp(Number(data.brake) || 0, 0, 1);
        this.callbacks.onPlayerInput(from, { steer, brake });
        break;
      }
      case MSG.PING: {
        this.party?.sendTo(from, { type: MSG.PONG, t: data.t });
        break;
      }
      case MSG.LEAVE: {
        this.onPeerLeft(from);
        break;
      }
      case MSG.START_RACE: {
        // Any connected player can request race start — DisplayGame gates
        // on room state and minimum-player count.
        this.callbacks.onStartRequested();
        break;
      }
      case MSG.PAUSE_GAME: {
        this.callbacks.onPauseRequested();
        break;
      }
      case MSG.RESUME_GAME: {
        this.callbacks.onResumeRequested();
        break;
      }
      case MSG.RETURN_TO_LOBBY: {
        this.callbacks.onReturnToLobbyRequested();
        break;
      }
      case MSG.PLAY_AGAIN: {
        this.callbacks.onPlayAgainRequested();
        break;
      }
    }
  }

  // ---- Outbound ----

  broadcastLobbyUpdate(): void {
    const payload: LobbyUpdatePayload = {
      type: MSG.LOBBY_UPDATE,
      players: this.state.playerOrder
        .map((id) => this.state.players.get(id))
        .filter((p): p is Player => !!p)
        .map((p) => ({ id: p.id, name: p.name, color: p.color })),
    };
    this.party?.broadcast(payload);
  }

  broadcastCountdown(value: 1 | 2 | 3 | 'GO'): void {
    const payload: CountdownPayload = { type: MSG.COUNTDOWN, value };
    this.party?.broadcast(payload);
  }

  broadcastRaceStart(): void {
    this.party?.broadcast({ type: MSG.RACE_START });
  }

  broadcastPaused(): void {
    this.party?.broadcast({ type: MSG.GAME_PAUSED });
  }

  broadcastResumed(): void {
    this.party?.broadcast({ type: MSG.GAME_RESUMED });
  }

  broadcastReturnToLobby(): void {
    this.party?.broadcast({ type: MSG.RETURN_TO_LOBBY });
  }

  broadcastRaceEnd(standings: RaceEndStanding[]): void {
    const payload: RaceEndPayload = { type: MSG.RACE_END, standings };
    this.party?.broadcast(payload);
  }

  close(): void {
    if (this.party) {
      this.party.close();
      this.party = null;
    }
  }

  sendLapUpdate(carId: number, lap: number): void {
    // Find the controller whose car matches carId
    for (const p of this.state.players.values()) {
      if (p.carId === carId) {
        const payload: LapUpdatePayload = {
          type: MSG.LAP_UPDATE,
          lap,
          totalLaps: TOTAL_LAPS,
          position: 0,
          lapTime: 0,
        };
        this.party?.sendTo(p.id, payload);
        return;
      }
    }
  }

  // ---- QR helpers ----

  private fetchBaseUrl(): void {
    const host = window.location.hostname;
    if (host !== 'localhost' && host !== '127.0.0.1') return;
    fetch('/api/baseurl')
      .then((r) => r.json())
      .then((data) => {
        if (data.baseUrl) this.state.baseUrlOverride = data.baseUrl;
      })
      .catch(() => {
        /* fall back to window.location.origin */
      });
  }

  private fetchAndRenderQR(text: string): void {
    fetch('/api/qr?text=' + encodeURIComponent(text))
      .then((r) => r.json())
      .then((data: { size: number; modules: number[] }) => {
        this.renderQRMatrix(data);
      })
      .catch((err) => console.error('[display] QR fetch failed:', err));
  }

  private renderQRMatrix(qr: { size: number; modules: number[] }): void {
    const canvas = document.getElementById('qr-code') as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const scale = Math.floor(Math.min(w, h) / qr.size);
    const offset = Math.floor((w - scale * qr.size) / 2);

    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'black';
    for (let row = 0; row < qr.size; row++) {
      for (let col = 0; col < qr.size; col++) {
        if (qr.modules[row * qr.size + col]) {
          ctx.fillRect(offset + col * scale, offset + row * scale, scale, scale);
        }
      }
    }
  }
}

