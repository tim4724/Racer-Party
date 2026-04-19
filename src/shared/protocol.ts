// Wire protocol for Racer messages, transported via Party-Sockets.

export const RELAY_URL = 'wss://ws.couch-games.com';

export const MSG = {
  // Controller → Display
  HELLO: 'hello',           // { name }
  INPUT: 'input',           // { steer: -1..1, brake: 0..1 }
  START_RACE: 'start_race', // any player can request — display gates
  PAUSE_GAME: 'pause_game',
  RESUME_GAME: 'resume_game',
  RETURN_TO_LOBBY: 'return_to_lobby',
  PLAY_AGAIN: 'play_again',
  LEAVE: 'leave',
  PING: 'ping',             // { t }

  // Display → specific Controller
  WELCOME: 'welcome',       // { carId, color, roomState }
  LAP_UPDATE: 'lap_update', // { lap, position, lapTime }
  PONG: 'pong',             // { t }

  // Display → all Controllers (broadcast)
  LOBBY_UPDATE: 'lobby_update', // { players: [{name, color}] }
  COUNTDOWN: 'countdown',       // { value: 3|2|1|"GO" }
  RACE_START: 'race_start',
  RACE_END: 'race_end',         // { standings: [...] }
  GAME_PAUSED: 'game_paused',
  GAME_RESUMED: 'game_resumed',
  ERROR: 'error',
} as const;

export type MsgType = (typeof MSG)[keyof typeof MSG];

export const ROOM_STATE = {
  LOBBY: 'lobby',
  COUNTDOWN: 'countdown',
  RACING: 'racing',
  FINISHED: 'finished',
} as const;

export type RoomState = (typeof ROOM_STATE)[keyof typeof ROOM_STATE];

// Continuous input — controller streams to display. Drift is derived on the
// display from steer + brake + speed, so we don't carry it on the wire.
export interface InputState {
  steer: number;  // -1..1
  brake: number;  // 0..1
}

// Per-player welcome payload.
export interface WelcomePayload {
  type: typeof MSG.WELCOME;
  carId: number;
  color: string;
  name: string;
  roomState: RoomState;
  totalLaps: number;
  // Present only for players who are part of the active race. Omitted for
  // late joiners so the controller can distinguish "rejoin" from "wait".
  // Mirrors Tetris's `alive` field pattern.
  inGame?: boolean;
}

export interface LobbyUpdatePayload {
  type: typeof MSG.LOBBY_UPDATE;
  players: Array<{ id: string; name: string; color: string }>;
}

export interface CountdownPayload {
  type: typeof MSG.COUNTDOWN;
  value: 1 | 2 | 3 | 'GO';
}

export interface LapUpdatePayload {
  type: typeof MSG.LAP_UPDATE;
  lap: number;
  totalLaps: number;
  position: number;
  lapTime: number;
}

export interface RaceEndStanding {
  carId: number;
  name: string;
  placement: number;
  totalTime: number;
}

export interface RaceEndPayload {
  type: typeof MSG.RACE_END;
  standings: RaceEndStanding[];
}

// Sent display→controller when a join is rejected (room full, race in
// progress) or any other unrecoverable error. Carries a stable `code` for
// dispatching plus a human-readable `message` for display.
export type ErrorCode = 'room_full' | 'race_in_progress' | 'room_not_found' | 'unknown';

export interface ErrorPayload {
  type: typeof MSG.ERROR;
  code: ErrorCode;
  message: string;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export const MUTED_STORAGE_KEY = 'racer_muted';
export const TOTAL_LAPS = 3;
export const MAX_PLAYERS = 4;

// Visible color palette for assigning to phone players.
export const PLAYER_COLORS = [
  '#ff7a18', // orange
  '#5dd39e', // green
  '#4cc9f0', // blue
  '#f72585', // pink
];
