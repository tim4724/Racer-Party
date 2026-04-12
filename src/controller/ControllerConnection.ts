// ControllerConnection — Party-Sockets wrapper for the controller side.
//
// Sends HELLO + INPUT to the display, handles WELCOME / LOBBY_UPDATE /
// COUNTDOWN / RACE_START / LAP_UPDATE / RACE_END / PONG. Tracks ping RTT
// for the corner readout.

import { PartyConnection } from '@shared/PartyConnection';
import {
  RELAY_URL,
  MSG,
  type InputState,
  type ErrorCode,
  type RaceEndStanding,
} from '@shared/protocol';

const PING_INTERVAL_MS = 1000;
const PONG_TIMEOUT_MS = 4000;
const INPUT_KEEPALIVE_MS = 50; // ~20 Hz max

export interface ControllerConnectionCallbacks {
  onWelcome: (carId: number, color: string, name: string, roomState: string) => void;
  onLobbyUpdate: (players: Array<{ id: string; name: string; color: string }>) => void;
  onReturnToLobby: () => void;
  onCountdown: (value: 1 | 2 | 3 | 'GO') => void;
  onRaceStart: () => void;
  onLapUpdate: (lap: number, totalLaps: number) => void;
  onRaceEnd: (standings: RaceEndStanding[]) => void;
  onPaused: () => void;
  onResumed: () => void;
  onError: (code: ErrorCode, message: string) => void;
  // Reconnect lifecycle. attempt counts up while reconnecting; max is the
  // configured ceiling. exhausted=true means no more automatic retries.
  onReconnecting: (attempt: number, max: number, exhausted: boolean) => void;
  onConnected: () => void;
}

export class ControllerConnection {
  roomCode: string;
  callbacks: ControllerConnectionCallbacks;
  party: PartyConnection | null = null;
  clientId: string;

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongTime = 0;
  private lastInputSent = 0;
  private lastInputState: InputState = { steer: 0, brake: 0 };
  // gameCancelled is set when the display rejects this client (room full,
  // race in progress). It causes inbound game broadcasts to be ignored so
  // a kicked player doesn't get yanked back into a game by stale messages.
  private gameCancelled = false;
  private lastPlayerName = '';

  constructor(opts: { roomCode: string } & ControllerConnectionCallbacks) {
    const { roomCode, ...callbacks } = opts;
    this.roomCode = roomCode;
    this.callbacks = callbacks;

    // Stable per-room client id, restored across reloads.
    let id: string | null = null;
    try {
      id = sessionStorage.getItem('racer_client_' + this.roomCode);
    } catch { /* ignore */ }
    if (!id) {
      id = (crypto as any).randomUUID ? crypto.randomUUID() : 'cli-' + Math.random().toString(36).slice(2, 12);
      try { sessionStorage.setItem('racer_client_' + this.roomCode, id); } catch { /* ignore */ }
    }
    this.clientId = id;
  }

  connect(playerName: string): void {
    if (this.party) this.party.close();

    // A fresh connect attempt clears the cancelled flag — the user explicitly
    // wants to rejoin. The display will reject again if the room is still
    // full / racing.
    this.gameCancelled = false;
    this.lastPlayerName = playerName;

    this.party = new PartyConnection(RELAY_URL, { clientId: this.clientId });

    this.party.onOpen = () => {
      this.party!.join(this.roomCode);
    };

    this.party.onProtocol = (type, msg) => {
      if (type === 'joined') {
        this.startPing();
        this.callbacks.onConnected();
        this.party!.sendTo('display', { type: MSG.HELLO, name: this.lastPlayerName });
      } else if (type === 'error') {
        const message = (msg as { type: 'error'; message: string }).message || 'Connection error';
        // Party-Server level error (room not found, etc.) — surface as
        // a final-state error so the user can retry.
        this.gameCancelled = true;
        this.stopPing();
        this.callbacks.onError(
          message.toLowerCase().includes('not found') ? 'room_not_found' : 'unknown',
          message,
        );
      }
    };

    this.party.onMessage = (from, data: any) => {
      if (from !== 'display') return;
      this.handleDisplayMessage(data);
    };

    this.party.onClose = (attempt, max) => {
      this.stopPing();
      if (this.gameCancelled) return;
      const exhausted = attempt > max;
      this.callbacks.onReconnecting(attempt, max, exhausted);
    };

    this.party.connect();
  }

  // Manually retry after the auto-reconnect budget is exhausted.
  reconnectNow(): void {
    if (!this.party) {
      this.connect(this.lastPlayerName);
      return;
    }
    this.gameCancelled = false;
    this.party.resetReconnectCount();
    this.party.reconnectNow();
  }

  // Called from visibilitychange → restart pings if alive, reconnect otherwise.
  refreshOnFocus(): void {
    if (this.gameCancelled) return;
    if (this.party?.connected) {
      this.startPing();
    } else if (this.party) {
      this.party.resetReconnectCount();
      this.party.reconnectNow();
    } else {
      this.connect(this.lastPlayerName);
    }
  }

  private handleDisplayMessage(data: any): void {
    if (!data || typeof data !== 'object') return;
    // ERROR is always allowed through (re-admission/categorization). Other
    // game broadcasts are dropped when this controller has been cancelled.
    if (this.gameCancelled && data.type !== MSG.ERROR && data.type !== MSG.WELCOME) return;
    switch (data.type) {
      case MSG.WELCOME:
        // A WELCOME after a rejection means the display has re-admitted us
        // (e.g. a slot opened up while we were on the room-gone screen).
        this.gameCancelled = false;
        this.callbacks.onWelcome(
          data.carId ?? 0,
          data.color ?? '#fff',
          data.name ?? '',
          data.roomState ?? 'lobby',
        );
        break;
      case MSG.ERROR: {
        const code = (data.code as ErrorCode) || 'unknown';
        const message = typeof data.message === 'string' ? data.message : 'Error';
        this.gameCancelled = true;
        this.stopPing();
        this.callbacks.onError(code, message);
        break;
      }
      case MSG.LOBBY_UPDATE:
        this.callbacks.onLobbyUpdate(Array.isArray(data.players) ? data.players : []);
        break;
      case MSG.RETURN_TO_LOBBY:
        this.callbacks.onReturnToLobby();
        break;
      case MSG.COUNTDOWN:
        this.callbacks.onCountdown(data.value);
        break;
      case MSG.RACE_START:
        this.callbacks.onRaceStart();
        break;
      case MSG.LAP_UPDATE:
        this.callbacks.onLapUpdate(data.lap, data.totalLaps);
        break;
      case MSG.GAME_PAUSED:
        this.callbacks.onPaused();
        break;
      case MSG.GAME_RESUMED:
        this.callbacks.onResumed();
        break;
      case MSG.RACE_END: {
        const standings: RaceEndStanding[] = Array.isArray(data.standings) ? data.standings : [];
        this.callbacks.onRaceEnd(standings);
        break;
      }
      case MSG.PONG:
        this.lastPongTime = Date.now();
        if (typeof data.t === 'number') this.updatePingDisplay(Date.now() - data.t);
        break;
    }
  }

  // Sent when the player taps START in the lobby. The display decides
  // whether to honor it (based on its own state machine + player count).
  requestStart(): void {
    this.party?.sendTo('display', { type: MSG.START_RACE });
  }

  requestPause(): void {
    this.party?.sendTo('display', { type: MSG.PAUSE_GAME });
  }

  requestResume(): void {
    this.party?.sendTo('display', { type: MSG.RESUME_GAME });
  }

  requestReturnToLobby(): void {
    this.party?.sendTo('display', { type: MSG.RETURN_TO_LOBBY });
  }

  requestPlayAgain(): void {
    this.party?.sendTo('display', { type: MSG.PLAY_AGAIN });
  }

  // Synchronous LEAVE + close — used when the player explicitly backs out
  // (lobby back button, browser back, performDisconnect on the game side).
  // Sending LEAVE first lets the display drop the player without waiting for
  // the relay's peer_left timeout.
  performDisconnect(): void {
    this.gameCancelled = true;
    this.stopPing();
    if (this.party) {
      try { this.party.sendTo('display', { type: MSG.LEAVE }); } catch { /* ignore */ }
      this.party.close();
      this.party = null;
    }
  }

  // ---- Input streaming ----

  sendInput(input: InputState): void {
    if (!this.party) return;
    const now = performance.now();
    const changed =
      Math.abs(input.steer - this.lastInputState.steer) > 0.02 ||
      Math.abs(input.brake - this.lastInputState.brake) > 0.02;
    const overdue = now - this.lastInputSent > INPUT_KEEPALIVE_MS;
    if (!changed && !overdue) return;
    this.lastInputState = { steer: input.steer, brake: input.brake };
    this.lastInputSent = now;
    this.party.sendTo('display', { type: MSG.INPUT, steer: input.steer, brake: input.brake });
  }

  // ---- Ping / Pong ----

  private startPing(): void {
    this.stopPing();
    this.lastPongTime = Date.now();
    this.pingTimer = setInterval(() => {
      this.party?.sendTo('display', { type: MSG.PING, t: Date.now() });
      if (Date.now() - this.lastPongTime > PONG_TIMEOUT_MS) {
        this.updatePingDisplay(-1);
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private updatePingDisplay(ms: number): void {
    for (const id of ['ping-display', 'ping-display-game']) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.classList.remove('ping-good', 'ping-bad');
      if (ms < 0) {
        el.textContent = 'bad connection';
        el.classList.add('ping-bad');
      } else {
        el.textContent = `${ms} ms`;
        el.classList.add(ms < 80 ? 'ping-good' : 'ping-bad');
      }
    }
  }
}
