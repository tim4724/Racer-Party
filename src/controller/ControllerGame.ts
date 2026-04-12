// ControllerGame — top-level state machine for the controller side.
//
// Screens: name → lobby → game → finished
//
// Owns ControllerConnection (Party-Sockets) and TouchInput, dispatches
// inbound display messages to the right screen, and renders the lobby UI
// (player identity card + start button + join URL hint).

import { ControllerConnection } from './ControllerConnection';
import { TouchInput } from './TouchInput';
import { ControllerHud } from './Hud';
import { MUTED_STORAGE_KEY, type InputState, type ErrorCode, type RaceEndStanding } from '@shared/protocol';

const SCREENS = {
  NAME: 'name-screen',
  LOBBY: 'lobby-screen',
  GAME: 'game-screen',
  RESULTS: 'results-screen',
} as const;
type ScreenId = (typeof SCREENS)[keyof typeof SCREENS];

export class ControllerGame {
  roomCode: string;
  connection: ControllerConnection;
  touch: TouchInput | null = null;
  hud: ControllerHud;
  carId: number | null = null;
  color: string | null = null;
  playerName: string | null = null;
  playerCount = 1;
  currentScreen: ScreenId = 'name-screen';
  private muted = false;
  // True when this controller joined while a race was already running. Stays
  // set until the display returns to the lobby; while set we ignore the
  // current race's COUNTDOWN/RACE_START broadcasts.
  private waitingForNextGame = false;

  constructor(roomCode: string) {
    this.roomCode = roomCode;
    this.connection = new ControllerConnection({
      roomCode,
      onWelcome: (carId, color, name, roomState) => this.onWelcome(carId, color, name, roomState),
      onLobbyUpdate: (players) => this.onLobbyUpdate(players),
      onReturnToLobby: () => this.onReturnToLobby(),
      onCountdown: (value) => this.onCountdown(value),
      onRaceStart: () => {
        if (this.waitingForNextGame) return;
        this.showGameScreen();
      },
      onLapUpdate: (_lap, _totalLaps) => {
        // Lap info received from display; no controller-side UI for it yet.
      },
      onRaceEnd: (standings) => {
        if (this.waitingForNextGame) return;
        this.showResults(standings);
      },
      onPaused: () => this.onPaused(),
      onResumed: () => this.onResumed(),
      onError: (code, message) => this.onError(code, message),
      onReconnecting: (attempt, max, exhausted) => this.onReconnecting(attempt, max, exhausted),
      onConnected: () => this.onConnected(),
    });
    this.hud = new ControllerHud();

    try {
      this.muted = localStorage.getItem(MUTED_STORAGE_KEY) === '1';
    } catch {
      /* ignore */
    }

    this.bindHandlers();
    this.bindGlobalEvents();
    this.showJoinUrlHint();
  }

  private bindGlobalEvents(): void {
    // Browser back / swipe-back from lobby/game/results → leave gracefully.
    window.addEventListener('popstate', () => {
      if (
        this.currentScreen === 'lobby-screen' ||
        this.currentScreen === 'game-screen' ||
        this.currentScreen === 'results-screen'
      ) {
        this.performDisconnect();
      }
    });

    // Tab regained focus — restart pings or reconnect if the WS died while
    // the page was backgrounded (lock screen, app switcher, etc.).
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (this.currentScreen === 'name-screen') return;
      this.connection.refreshOnFocus();
    });
  }

  // Tetris-style explicit leave: send LEAVE, close the party, reset all
  // local state, return to the name screen.
  performDisconnect(): void {
    this.connection.performDisconnect();
    this.touch?.dispose();
    this.touch = null;
    this.carId = null;
    this.color = null;
    this.playerCount = 0;
    document.getElementById('pause-overlay')?.classList.add('hidden');
    document.getElementById('reconnect-overlay')?.classList.add('hidden');
    document.getElementById('room-gone-message')?.classList.add('hidden');
    document.getElementById('name-form')?.classList.remove('hidden');
    document.getElementById('join-btn')?.classList.remove('hidden');
    this.resetJoinButton();
    this.clearNameScreenErrors();
    this.showScreen('name-screen');
  }

  join(name: string): void {
    this.playerName = name || null;
    // Persist only non-empty names so the stale value doesn't get refilled.
    try {
      if (name) localStorage.setItem('racer_player_name', name);
      else localStorage.removeItem('racer_player_name');
    } catch {
      /* ignore */
    }
    this.clearNameScreenErrors();
    const joinBtn = document.getElementById('join-btn') as HTMLButtonElement | null;
    if (joinBtn) {
      joinBtn.disabled = true;
      joinBtn.textContent = 'CONNECTING…';
    }
    const status = document.getElementById('status-text') as HTMLParagraphElement | null;
    if (status) status.textContent = 'Connecting…';

    this.connection.connect(name);
  }

  // -------------------------------------------------------------------------
  // Screen handlers
  // -------------------------------------------------------------------------

  private bindHandlers(): void {
    const joinBtn = document.getElementById('join-btn') as HTMLButtonElement | null;
    const form = document.getElementById('name-form') as HTMLFormElement | null;
    const nameInput = document.getElementById('name-input') as HTMLInputElement | null;

    const submit = () => {
      const raw = nameInput?.value ?? '';
      const name = raw.trim().slice(0, 16);
      this.vibrate(10);
      this.join(name);
    };

    joinBtn?.addEventListener('click', submit);
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      submit();
    });
    nameInput?.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        e.preventDefault();
        submit();
      }
    });

    const startBtn = document.getElementById('start-btn') as HTMLButtonElement | null;
    startBtn?.addEventListener('click', () => {
      if (startBtn.disabled) return;
      this.vibrate(10);
      this.connection.requestStart();
    });

    const backBtn = document.getElementById('lobby-back-btn') as HTMLButtonElement | null;
    backBtn?.addEventListener('click', () => {
      this.vibrate(10);
      this.performDisconnect();
    });

    const muteBtns = [
      document.getElementById('lobby-mute-btn'),
      document.getElementById('game-mute-btn'),
    ];
    for (const btn of muteBtns) {
      if (!btn) continue;
      btn.classList.toggle('muted', this.muted);
      btn.addEventListener('click', () => this.toggleMute());
    }

    const pauseBtn = document.getElementById('game-pause-btn') as HTMLButtonElement | null;
    pauseBtn?.addEventListener('click', () => {
      this.vibrate(10);
      this.connection.requestPause();
    });

    const resumeBtn = document.getElementById('pause-resume-btn') as HTMLButtonElement | null;
    resumeBtn?.addEventListener('click', () => {
      this.vibrate(10);
      this.connection.requestResume();
    });

    const newGameBtn = document.getElementById('pause-newgame-btn') as HTMLButtonElement | null;
    newGameBtn?.addEventListener('click', () => {
      this.vibrate(10);
      this.connection.requestReturnToLobby();
    });

    const resultsPlayAgainBtn = document.getElementById('results-play-again-btn') as HTMLButtonElement | null;
    resultsPlayAgainBtn?.addEventListener('click', () => {
      this.vibrate(10);
      this.connection.requestPlayAgain();
    });
    const resultsNewGameBtn = document.getElementById('results-new-game-btn') as HTMLButtonElement | null;
    resultsNewGameBtn?.addEventListener('click', () => {
      this.vibrate(10);
      this.connection.requestReturnToLobby();
    });

    const rejoinBtn = document.getElementById('reconnect-rejoin-btn') as HTMLButtonElement | null;
    rejoinBtn?.addEventListener('click', () => {
      this.vibrate(10);
      const heading = document.getElementById('reconnect-heading');
      const status = document.getElementById('reconnect-status');
      if (heading) heading.textContent = 'RECONNECTING';
      if (status) status.textContent = 'Connecting…';
      rejoinBtn.classList.add('hidden');
      this.connection.reconnectNow();
    });

    // Typing in the name input clears any prior room-gone error so the user
    // doesn't have to look at it after they've started a new attempt.
    const nameInputEl = document.getElementById('name-input') as HTMLInputElement | null;
    nameInputEl?.addEventListener('input', () => this.clearNameScreenErrors());
  }

  private clearNameScreenErrors(): void {
    document.getElementById('room-gone-message')?.classList.add('hidden');
    const status = document.getElementById('status-text');
    const detail = document.getElementById('status-detail');
    if (status) status.textContent = '';
    if (detail) detail.textContent = '';
  }

  private toggleMute(): void {
    this.muted = !this.muted;
    try {
      localStorage.setItem(MUTED_STORAGE_KEY, this.muted ? '1' : '0');
    } catch {
      /* ignore */
    }
    for (const id of ['lobby-mute-btn', 'game-mute-btn']) {
      document.getElementById(id)?.classList.toggle('muted', this.muted);
    }
    // The controller has no audio engine yet; the flag is persisted for
    // future SFX and to let the icon reflect the user's choice.
  }

  private showJoinUrlHint(): void {
    const el = document.getElementById('lobby-join-url');
    if (el) el.textContent = `${location.origin}/${this.roomCode}`;
  }

  // -------------------------------------------------------------------------
  // Message handlers
  // -------------------------------------------------------------------------

  private onWelcome(carId: number, color: string, name: string, roomState: string): void {
    this.carId = carId;
    this.color = color;
    this.playerName = name || this.playerName;
    this.hud.setIdentity(this.playerName || `P${carId + 1}`, color);

    // Reflect identity on the lobby card.
    const identity = document.getElementById('player-identity');
    if (identity) identity.style.setProperty('--player-color', color);
    const nameEl = document.getElementById('player-identity-name');
    if (nameEl) nameEl.textContent = this.playerName || `P${carId + 1}`;

    // Also colour the in-game name pill.
    const gameName = document.getElementById('hud-name');
    if (gameName) gameName.style.setProperty('--player-color', color);

    // If we joined mid-race, sit in the lobby with a "Game in progress"
    // message until the display returns to its lobby for the next race.
    this.waitingForNextGame = roomState !== 'lobby';

    if (this.currentScreen === 'name-screen') this.showScreen('lobby-screen');

    this.refreshStartButton();
  }

  private onLobbyUpdate(players: Array<{ id: string; name: string; color: string }>): void {
    this.playerCount = players.length;
    this.refreshStartButton();
  }

  private refreshStartButton(): void {
    const startBtn = document.getElementById('start-btn') as HTMLButtonElement | null;
    const status = document.getElementById('lobby-status') as HTMLParagraphElement | null;
    if (!startBtn) return;

    if (this.waitingForNextGame) {
      startBtn.classList.add('hidden');
      startBtn.disabled = true;
      if (status) status.textContent = 'Game in progress — you\'ll join the next race.';
      return;
    }

    startBtn.classList.remove('hidden');
    const ready = this.playerCount > 0;
    startBtn.disabled = !ready;
    if (ready) {
      startBtn.textContent =
        this.playerCount > 1 ? `START (${this.playerCount})` : 'START RACE';
      if (status) status.textContent = 'Any player can tap start.';
    } else {
      startBtn.textContent = 'WAITING…';
      if (status) status.textContent = 'Waiting for the display…';
    }
  }

  private onCountdown(value: 1 | 2 | 3 | 'GO'): void {
    // Late joiners stay in their lobby through the current race.
    if (this.waitingForNextGame) return;

    if (typeof value === 'number') this.vibrate(20);
    else this.vibrate(40);

    // Switch to the game screen as soon as the countdown starts and enable
    // touch input immediately — the player can pre-steer (the display
    // applies steering during the freeze) but the car stays braked until GO.
    if (this.currentScreen !== 'game-screen') {
      this.showGameScreen();
    }
  }

  private showGameScreen(): void {
    this.showScreen('game-screen');
    document.getElementById('pause-overlay')?.classList.add('hidden');
    this.initTouchInput();
  }

  private initTouchInput(): void {
    if (this.touch) return;
    const pad = document.getElementById('touch-pad') as HTMLDivElement;
    const feedback = document.getElementById('touch-feedback') as HTMLDivElement;
    this.touch = new TouchInput(pad, {
      onChange: (input: InputState) => {
        this.connection.sendInput(input);
        const intensity = Math.max(Math.abs(input.steer), input.brake);
        const color = input.brake > 0.05 ? 'rgba(239, 100, 97,' : 'rgba(255, 122, 24,';
        feedback.style.background = `radial-gradient(circle at center, ${color} ${intensity * 0.3}) 0%, rgba(0,0,0,0) 70%)`;
      },
    });
  }

  // Display ended the race and went back to its lobby — bounce out of the
  // game / results screen so the player is ready for the next race. Also
  // clears the late-joiner waiting flag so the start button reappears.
  private onReturnToLobby(): void {
    this.touch?.dispose();
    this.touch = null;
    this.waitingForNextGame = false;
    document.getElementById('pause-overlay')?.classList.add('hidden');
    if (this.currentScreen !== 'name-screen') {
      this.showScreen('lobby-screen');
      this.refreshStartButton();
    }
  }

  private onPaused(): void {
    if (this.waitingForNextGame) return;
    document.getElementById('pause-overlay')?.classList.remove('hidden');
  }

  private onResumed(): void {
    if (this.waitingForNextGame) return;
    document.getElementById('pause-overlay')?.classList.add('hidden');
  }

  // -------------------------------------------------------------------------
  // Error / reconnect lifecycle
  // -------------------------------------------------------------------------

  private onError(code: ErrorCode, message: string): void {
    // Tear down any in-game UI and bounce the user back to the name screen
    // with the right error chrome.
    this.touch?.dispose();
    this.touch = null;
    document.getElementById('pause-overlay')?.classList.add('hidden');
    document.getElementById('reconnect-overlay')?.classList.add('hidden');

    if (code === 'room_full' || code === 'race_in_progress' || code === 'room_not_found') {
      const heading =
        code === 'room_full' ? 'Room is full'
        : code === 'race_in_progress' ? 'Race in progress'
        : 'Room not found';
      this.showRoomGone(heading);
    } else {
      this.showErrorState(message);
    }
  }

  // Tetris-style "room is gone" page: hide the name form + join button so the
  // user sees a dedicated message screen (not the regular join screen with a
  // banner). The only way out is to scan a fresh QR / reload.
  private showRoomGone(heading: string): void {
    // Drop any saved per-room session state — the room is gone, the stored
    // clientId would just collide if a new room with the same code appears.
    try { sessionStorage.removeItem('racer_client_' + this.roomCode); } catch { /* ignore */ }

    const block = document.getElementById('room-gone-message');
    const headingEl = document.getElementById('room-gone-heading');
    const detailEl = document.getElementById('room-gone-detail');
    if (headingEl) headingEl.textContent = heading;
    if (detailEl) detailEl.textContent = 'Scan the QR on the display to join a new race.';
    block?.classList.remove('hidden');

    // Hide the name form + join button so the screen reads as a dedicated
    // "this room is gone" page.
    document.getElementById('name-form')?.classList.add('hidden');
    document.getElementById('join-btn')?.classList.add('hidden');

    const status = document.getElementById('status-text');
    const statusDetail = document.getElementById('status-detail');
    if (status) status.textContent = '';
    if (statusDetail) statusDetail.textContent = '';

    this.showScreen('name-screen');
  }

  // Soft error: the room is still reachable, the user just got rejected once
  // (e.g. transient relay error). Keep the form visible so they can retry.
  private showErrorState(message: string): void {
    document.getElementById('room-gone-message')?.classList.add('hidden');
    document.getElementById('name-form')?.classList.remove('hidden');
    document.getElementById('join-btn')?.classList.remove('hidden');
    this.resetJoinButton();
    const status = document.getElementById('status-text');
    const detail = document.getElementById('status-detail');
    if (status) status.textContent = 'Could not join';
    if (detail) detail.textContent = message;
    this.showScreen('name-screen');
  }

  private resetJoinButton(): void {
    const joinBtn = document.getElementById('join-btn') as HTMLButtonElement | null;
    if (joinBtn) {
      joinBtn.disabled = false;
      joinBtn.textContent = 'JOIN';
    }
  }

  private onReconnecting(attempt: number, max: number, exhausted: boolean): void {
    // Don't show a reconnect overlay before we ever made it past the name
    // screen — the user just sees the join button reappear via showErrorState.
    if (this.currentScreen === 'name-screen') return;

    const overlay = document.getElementById('reconnect-overlay');
    const heading = document.getElementById('reconnect-heading');
    const status = document.getElementById('reconnect-status');
    const rejoin = document.getElementById('reconnect-rejoin-btn');
    overlay?.classList.remove('hidden');
    if (exhausted) {
      if (heading) heading.textContent = 'DISCONNECTED';
      if (status) status.textContent = 'Could not reconnect.';
      rejoin?.classList.remove('hidden');
    } else {
      if (heading) heading.textContent = 'RECONNECTING';
      if (status) status.textContent = `Attempt ${Math.min(attempt, max)}/${max}…`;
      rejoin?.classList.add('hidden');
    }
  }

  private onConnected(): void {
    document.getElementById('reconnect-overlay')?.classList.add('hidden');
  }

  private resultsBtnTimer: ReturnType<typeof setTimeout> | null = null;
  private showResults(standings: RaceEndStanding[]): void {
    this.touch?.dispose();
    this.touch = null;
    document.getElementById('pause-overlay')?.classList.add('hidden');

    // 2 s activation delay so a still-finishing player can't accidentally
    // tap PLAY AGAIN / NEW GAME the moment they cross the line.
    const playAgainBtn = document.getElementById('results-play-again-btn') as HTMLButtonElement | null;
    const newGameBtn = document.getElementById('results-new-game-btn') as HTMLButtonElement | null;
    if (playAgainBtn) playAgainBtn.disabled = true;
    if (newGameBtn) newGameBtn.disabled = true;
    if (this.resultsBtnTimer) clearTimeout(this.resultsBtnTimer);
    this.resultsBtnTimer = setTimeout(() => {
      if (playAgainBtn) playAgainBtn.disabled = false;
      if (newGameBtn) newGameBtn.disabled = false;
    }, 2000);

    const list = document.getElementById('results-list') as HTMLOListElement | null;
    if (list) {
      list.innerHTML = '';
      const ordered = standings.slice().sort((a, b) => a.placement - b.placement);
      for (const s of ordered) {
        const li = document.createElement('li');
        if (this.carId !== null && s.carId === this.carId) li.classList.add('is-me');
        const rank = document.createElement('span');
        rank.className = 'rank';
        rank.textContent = `${s.placement}.`;
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = s.name;
        const time = document.createElement('span');
        time.className = 'time';
        time.textContent = s.totalTime > 0 ? `${(s.totalTime / 1000).toFixed(2)}s` : '—';
        li.appendChild(rank);
        li.appendChild(name);
        li.appendChild(time);
        list.appendChild(li);
      }
    }

    this.showScreen('results-screen');
  }

  private showScreen(id: ScreenId): void {
    this.currentScreen = id;
    for (const sid of Object.values(SCREENS)) {
      const el = document.getElementById(sid);
      if (el) el.classList.toggle('hidden', sid !== id);
    }
  }

  private vibrate(pattern: number | number[]): void {
    if (navigator.vibrate) navigator.vibrate(pattern);
  }
}

