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
  lastPingTime: number; // Date.now() of last PING received
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
  // Per-controller liveness. Called when a message arrives (alive) or when
  // no messages have been received within the timeout (dead).
  onPlayerAlive: (clientId: string) => void;
  onPlayerDead: (clientId: string) => void;
  // Returns true if new players are still allowed (i.e. lobby state, room not full).
  isAcceptingPlayers: () => boolean;
  // Current room state — echoed to the joining controller via WELCOME so it
  // can render a "Game in progress" wait state.
  getRoomState: () => RoomState;
}

const HEARTBEAT_INTERVAL_MS = 1000;
const HEARTBEAT_TIMEOUT_MS = 3000;

export class DisplayConnection {
  private party: PartyConnection | null = null;
  private state: DisplayState;
  private callbacks: DisplayConnectionCallbacks;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeatEcho = 0;
  private heartbeatDead = false;
  // Active racers whose peer_left fired mid-race. Cleaned up on return to lobby.
  private leftDuringRace = new Set<string>();

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
      if (from === 'display') {
        // Self-heartbeat echo — update timestamp to confirm relay is alive.
        if (data && typeof data === 'object' && (data as any).type === '_heartbeat') {
          this.lastHeartbeatEcho = Date.now();
        }
        return;
      }
      // Any message from a controller refreshes their liveness timestamp.
      const player = this.state.players.get(from);
      if (player) {
        player.lastPingTime = Date.now();
        this.callbacks.onPlayerAlive(from);
      }
      this.handleControllerMessage(from, data);
    };

    this.party.onClose = (attempt, max) => {
      console.warn(`[display] WS closed (attempt ${attempt}/${max})`);
      this.stopHeartbeat();
      const exhausted = attempt > max;
      this.callbacks.onRelayLost(attempt, max, exhausted);
    };

    this.party.connect();
  }

  private handleProtocol(type: ProtocolMessage['type'], msg: ProtocolMessage): void {
    switch (type) {
      case 'created':
        this.heartbeatDead = false;
        this.callbacks.onRelayRestored();
        this.startHeartbeat();
        this.onRoomCreated((msg as { type: 'created'; room: string }).room);
        break;
      case 'joined': {
        // Display rejoined an existing room (after reconnect).
        this.heartbeatDead = false;
        this.callbacks.onRelayRestored();
        this.startHeartbeat();
        // Resync with the relay's authoritative client list.
        const clients = (msg as { type: 'joined'; room: string; clients: string[] }).clients || [];
        this.onDisplayRejoined(clients);
        break;
      }
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

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastHeartbeatEcho = Date.now();
    this.heartbeatDead = false;
    this.heartbeatTimer = setInterval(() => {
      // Echo to self through the relay — if it comes back, the connection is alive.
      this.party?.sendTo('display', { type: '_heartbeat' });

      if (Date.now() - this.lastHeartbeatEcho > HEARTBEAT_TIMEOUT_MS) {
        if (!this.heartbeatDead) {
          this.heartbeatDead = true;
          // Surface as a reconnecting state. The actual WS onclose will fire
          // later with real attempt counts; this gives early feedback.
          this.callbacks.onRelayLost(0, 0, false);
        }
      } else if (this.heartbeatDead) {
        // Heartbeat resumed — connection is back.
        this.heartbeatDead = false;
        this.callbacks.onRelayRestored();
      }

      // Per-controller liveness check.
      const now = Date.now();
      for (const player of this.state.players.values()) {
        if (now - player.lastPingTime > HEARTBEAT_TIMEOUT_MS) {
          this.callbacks.onPlayerDead(player.id);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
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
    if (this.state.players.has(clientId)) {
      // Returning player (same clientId) — refresh their liveness so the
      // per-viewport disconnect overlay clears.
      const player = this.state.players.get(clientId)!;
      player.lastPingTime = Date.now();
      this.leftDuringRace.delete(clientId);
      this.callbacks.onPlayerAlive(clientId);
      return;
    }

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
      lastPingTime: Date.now(),
    };
    this.state.players.set(clientId, player);

    // Only add to playerOrder in the lobby. Late joiners (mid-race) sit in
    // the players Map and wait — they're absorbed into playerOrder when the
    // display returns to the lobby or starts a new race.
    if (this.callbacks.isAcceptingPlayers()) {
      this.state.playerOrder.push(clientId);
    }

    this.callbacks.onLobbyChanged();
    this.broadcastLobbyUpdate();
  }

  private sendError(clientId: string, code: ErrorCode, message: string): void {
    const payload: ErrorPayload = { type: MSG.ERROR, code, message };
    this.party?.sendTo(clientId, payload);
  }

  private onPeerLeft(clientId: string): void {
    const player = this.state.players.get(clientId);
    if (!player) return;

    // When a controller reconnects with the same clientId the relay may
    // deliver peer_joined (new conn) before peer_left (old conn teardown).
    // If liveness was refreshed very recently, this is a stale leave — ignore.
    if (Date.now() - player.lastPingTime < HEARTBEAT_INTERVAL_MS) return;

    const racing = this.callbacks.getRoomState() !== 'lobby';
    const isActiveRacer = this.state.playerOrder.includes(clientId);

    if (racing && isActiveRacer) {
      // Active racer — keep in state so the display can show a per-viewport
      // disconnect overlay. Cleaned up on return to lobby.
      this.leftDuringRace.add(clientId);
      this.callbacks.onPlayerDead(clientId);
      return;
    }

    // Lobby player or late joiner — remove fully.
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
        // Send WELCOME. For players who are part of the active race, include
        // `inGame` so the controller rejoins immediately. Late joiners (not in
        // playerOrder) get no `inGame` → controller shows "Game in progress".
        // This mirrors Tetris's `alive` field pattern.
        const roomState = this.callbacks.getRoomState();
        const isActivePlayer = roomState !== 'lobby' && this.state.playerOrder.includes(from);
        const welcome: WelcomePayload = {
          type: MSG.WELCOME,
          carId: player.carId,
          color: player.color,
          name: player.name,
          roomState,
          totalLaps: TOTAL_LAPS,
          ...(isActivePlayer && { inGame: true }),
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

  // Rebuild playerOrder from all connected players. Called when transitioning
  // back to the lobby so late joiners are included in the next race and
  // players who disconnected mid-race are dropped.
  absorbLateJoiners(): void {
    // Remove players who left during the race.
    for (const id of this.leftDuringRace) {
      this.state.players.delete(id);
    }
    this.leftDuringRace.clear();

    // Rebuild playerOrder from all remaining players, sorted by carId.
    this.state.playerOrder = [...this.state.players.keys()].sort((a, b) => {
      return this.state.players.get(a)!.carId - this.state.players.get(b)!.carId;
    });
  }

  // Called when the display reconnects and gets back the relay's authoritative
  // client list. Reconciles local state: marks missing controllers as gone,
  // refreshes liveness for present ones, re-sends WELCOME to all.
  private onDisplayRejoined(clients: string[]): void {
    const currentPeers = new Set(clients.filter((id) => id !== 'display'));

    // Mark controllers not in the relay's list as disconnected.
    for (const [id] of this.state.players) {
      if (!currentPeers.has(id)) {
        this.callbacks.onPlayerDead(id);
      } else {
        const player = this.state.players.get(id)!;
        player.lastPingTime = Date.now();
        this.callbacks.onPlayerAlive(id);
      }
    }

    // Re-send WELCOME so every controller resyncs its screen state.
    const roomState = this.callbacks.getRoomState();
    for (const id of currentPeers) {
      const player = this.state.players.get(id);
      if (!player) continue;
      const isActivePlayer = roomState !== 'lobby' && this.state.playerOrder.includes(id);
      const welcome: WelcomePayload = {
        type: MSG.WELCOME,
        carId: player.carId,
        color: player.color,
        name: player.name,
        roomState,
        totalLaps: TOTAL_LAPS,
        ...(isActivePlayer && { inGame: true }),
      };
      this.party?.sendTo(id, welcome);
    }

    this.broadcastLobbyUpdate();
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
    this.stopHeartbeat();
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

