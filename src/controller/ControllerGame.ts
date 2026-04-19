// ControllerGame — top-level state machine for the controller side.
//
// Screens: name → lobby → game → finished
//
// Owns ControllerConnection (Party-Sockets) and TouchInput, dispatches
// inbound display messages to the right screen, and renders the lobby UI
// (player identity card + start button + join URL hint).

import { ControllerConnection } from './ControllerConnection';
import { TouchInput } from './TouchInput';
import { GyroInput, requestGyroPermission } from './GyroInput';
import { ControllerHud } from './Hud';
import {
  type InputMode,
  type InputSource,
  loadInputMode,
  saveInputMode,
  loadSensitivity,
  saveSensitivity,
  sensitivityToTouchRange,
  sensitivityToTiltRange,
} from './inputs';
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
  // Active input source (touchpad, slider, or gyro). Nulled between races.
  source: InputSource | null = null;
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
  // Merged-input state. The active source emits via onChange; the dedicated
  // BRAKE button overlays `brake=1` while held.
  private lastSourceInput: InputState = { steer: 0, brake: 0 };
  private buttonDown = false;
  private buttonDisposer: (() => void) | null = null;
  // User-selected settings (persisted to localStorage; picked on game screen).
  private inputMode: InputMode = loadInputMode();
  // Sensitivity is stored per input mode — touch and gyro have very
  // different "feel" envelopes.
  private sensitivity: number = loadSensitivity(loadInputMode());
  // Max-lock edge bump: armed while |steer| is below the re-arm point,
  // fires one pulse when steer reaches saturation (1.0).
  private hapticArmed = true;

  constructor(roomCode: string) {
    this.roomCode = roomCode;
    this.connection = new ControllerConnection({
      roomCode,
      onWelcome: (carId, color, name, roomState, inGame) => this.onWelcome(carId, color, name, roomState, inGame),
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
    this.disposeControls();
    // If we were in gyro/landscape, release the orientation lock and exit
    // fullscreen so the name screen is usable.
    this.exitLandscape();
    this.setGyroStatus('');
    this.carId = null;
    this.color = null;
    this.playerCount = 0;
    // Remove ?rejoin= from the URL so a stale rejoin param doesn't
    // auto-connect on the next page load.
    const params = new URLSearchParams(location.search);
    if (params.has('rejoin')) {
      params.delete('rejoin');
      const qs = params.toString();
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : ''));
    }
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
    this.bindPickers();

    const joinBtn = document.getElementById('join-btn') as HTMLButtonElement | null;
    const form = document.getElementById('name-form') as HTMLFormElement | null;
    const nameInput = document.getElementById('name-input') as HTMLInputElement | null;

    const submit = () => {
      const raw = nameInput?.value ?? '';
      const name = raw.trim().slice(0, 16);
      this.vibrate(10);
      // Gyro permission + landscape lock are handled on the lobby's
      // Steering picker tap (user gesture) — not here.
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
      this.vibrate(10);
      // Tap is a user gesture — use it to request fullscreen (+ landscape
      // lock for gyro) before asking the display to start the race.
      if (this.inputMode === 'gyro') void this.enterLandscape();
      else void this.enterFullscreen();
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

  // Wire up the game-screen Touch/Gyro picker. Tapping a mode persists the
  // choice, requests gyro permission + landscape lock on the fly (gyro only),
  // swaps the active InputSource, and loads that mode's stored sensitivity.
  private bindPickers(): void {
    const inputPicker = document.querySelector<HTMLElement>('.picker[data-picker="input-mode"]');
    if (!inputPicker) return;
    this.highlightInputMode();
    inputPicker.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('.picker-opt');
      if (!target || !target.dataset.value) return;
      const next = target.dataset.value as InputMode;
      if (next === this.inputMode) return;
      this.vibrate(8);
      void this.changeInputMode(next);
    });
  }

  private highlightInputMode(): void {
    const picker = document.querySelector<HTMLElement>('.picker[data-picker="input-mode"]');
    for (const opt of Array.from(picker?.querySelectorAll<HTMLElement>('.picker-opt') ?? [])) {
      opt.classList.toggle('selected', opt.dataset.value === this.inputMode);
    }
  }

  // Switch input modes at any point (including mid-race). Persists the
  // choice, handles gyro's permission/landscape side effects, then swaps
  // the live source if one is running.
  //
  // Order matters: side effects that need the browser's user-gesture token
  // (requestFullscreen, orientation.lock, iOS DeviceOrientationEvent
  // permission) must be kicked off BEFORE any `await` — otherwise the
  // gesture context is lost and they silently reject. We also swap the
  // source synchronously so the UI reflects the new mode immediately,
  // independent of how the async side effects resolve.
  private async changeInputMode(next: InputMode): Promise<void> {
    const prev = this.inputMode;
    this.inputMode = next;
    saveInputMode(next);
    this.highlightInputMode();

    // Load this mode's own sensitivity and push it to the slider.
    this.sensitivity = loadSensitivity(next);
    this.syncSensitivityUI();

    // Kick off gyro side effects inside the user-gesture window. Don't
    // await — we need the sync swap below to happen before any microtask.
    let permissionPromise: Promise<'granted' | 'denied' | 'unsupported'> | null = null;
    if (next === 'gyro' && prev !== 'gyro') {
      permissionPromise = requestGyroPermission();
      void this.enterLandscape();
    } else if (prev === 'gyro' && next !== 'gyro') {
      this.setGyroStatus('');
      this.exitLandscape();
    }

    // Swap the live source NOW (sync) so the UI flips to gyro/touch layout
    // immediately — regardless of permission or fullscreen outcome.
    if (this.source && this.currentScreen === 'game-screen') {
      this.source.dispose();
      this.source = null;
      this.initTouchInput();
    }

    // Surface the permission result once it resolves.
    if (permissionPromise) {
      const res = await permissionPromise;
      if (res === 'denied') {
        this.setGyroStatus('Motion permission denied — pick Touch to continue.');
      } else if (res === 'unsupported') {
        this.setGyroStatus('Gyro unsupported in this browser.');
      } else {
        this.setGyroStatus('Hold phone in landscape. Tilt to steer.');
      }
    }
  }

  private syncSensitivityUI(): void {
    const slider = document.getElementById('sensitivity-slider') as HTMLInputElement | null;
    if (slider) slider.value = String(this.sensitivity);
    this.source?.setSensitivity(this.sensitivity);
    this.updateSensitivityLabel();
  }

  private setGyroStatus(text: string): void {
    const el = document.getElementById('gyro-status');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('hidden', !text);
  }

  // Best-effort fullscreen request. Android Chrome honours it from a user
  // gesture. iOS Safari has no fullscreen API on the document element — the
  // call fails silently and the user stays in a browser chrome viewport.
  private async enterFullscreen(): Promise<void> {
    try {
      const el = document.documentElement;
      if (el.requestFullscreen && !document.fullscreenElement) {
        await el.requestFullscreen({ navigationUI: 'hide' });
      }
    } catch { /* ignore — not supported or denied */ }
  }

  // Fullscreen + landscape orientation lock. Used when switching into gyro
  // mode so the player is immediately holding the phone like a wheel.
  private async enterLandscape(): Promise<void> {
    await this.enterFullscreen();
    try {
      const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      if (orientation?.lock) await orientation.lock('landscape');
    } catch { /* ignore */ }
  }

  private exitLandscape(): void {
    try {
      const orientation = screen.orientation as ScreenOrientation & { unlock?: () => void };
      orientation?.unlock?.();
    } catch { /* ignore */ }
    try {
      if (document.fullscreenElement) void document.exitFullscreen();
    } catch { /* ignore */ }
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

  private onWelcome(carId: number, color: string, name: string, roomState: string, inGame: boolean): void {
    this.carId = carId;
    this.color = color;
    this.playerName = name || this.playerName;
    this.hud.setIdentity(this.playerName || `P${carId + 1}`, color);

    // Colour the in-game name pill.
    const gameName = document.getElementById('hud-name');
    if (gameName) gameName.style.setProperty('--player-color', color);

    // `inGame` is present only for players who are part of the active race
    // (mirrors Tetris's `alive` field). If present → rejoin immediately.
    // If absent during a race → late joiner, show "Game in progress".
    if (inGame) {
      this.waitingForNextGame = false;
      this.showGameScreen();
      return;
    }

    this.waitingForNextGame = roomState !== 'lobby';

    if (this.currentScreen === 'name-screen') this.showScreen('lobby-screen');

    this.refreshLobbyStatus();
  }

  private onLobbyUpdate(players: Array<{ id: string; name: string; color: string }>): void {
    this.playerCount = players.length;
    this.refreshLobbyStatus();
  }

  private refreshLobbyStatus(): void {
    const status = document.getElementById('lobby-status') as HTMLParagraphElement | null;
    const startBtn = document.getElementById('start-btn') as HTMLButtonElement | null;
    if (this.waitingForNextGame) {
      if (status) status.textContent = 'Game in progress — you\'ll join the next race.';
      startBtn?.classList.add('hidden');
    } else {
      if (status) status.textContent = 'Tap START to begin.';
      startBtn?.classList.remove('hidden');
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
    if (this.source) return;
    const pad = document.getElementById('touch-pad') as HTMLDivElement;
    const feedback = document.getElementById('touch-feedback') as HTMLDivElement;
    this.lastSourceInput = { steer: 0, brake: 0 };
    this.buttonDown = false;

    const onChange = (input: InputState) => {
      this.lastSourceInput = input;
      this.emitMergedInput(feedback);
    };

    // Tag the game screen with the active input mode so CSS can expand
    // the BRAKE button to full width in gyro mode.
    document.getElementById('game-screen')?.setAttribute('data-input', this.inputMode);

    if (this.inputMode === 'gyro') {
      this.source = new GyroInput({ onChange }, this.sensitivity);
    } else {
      // touch_a and touch_b share the same source — only CSS layout differs.
      this.source = new TouchInput(pad, { onChange }, this.sensitivity);
    }

    this.attachButton(feedback);
    this.bindSensitivitySlider();
    this.updateSensitivityLabel();
  }

  // Wire the sensitivity slider at the top of the game screen. Idempotent —
  // reattaching after a source reset is fine because we replace the handler.
  private bindSensitivitySlider(): void {
    const slider = document.getElementById('sensitivity-slider') as HTMLInputElement | null;
    if (!slider) return;
    slider.value = String(this.sensitivity);
    slider.oninput = () => {
      const v = parseInt(slider.value, 10) || 0;
      this.sensitivity = v;
      saveSensitivity(this.inputMode, v);
      this.source?.setSensitivity(v);
      this.updateSensitivityLabel();
    };
  }

  // Show the effective threshold (drag px or tilt °) next to the slider.
  private updateSensitivityLabel(): void {
    const el = document.getElementById('sensitivity-value');
    if (!el) return;
    if (this.inputMode === 'gyro') {
      el.textContent = `±${sensitivityToTiltRange(this.sensitivity).toFixed(0)}°`;
    } else {
      const pad = document.getElementById('touch-pad');
      const width = pad?.clientWidth ?? 360;
      el.textContent = `${Math.round(sensitivityToTouchRange(this.sensitivity, width))}px`;
    }
  }

  // Combines the active source's steer/brake with the dedicated BRAKE
  // button (held → brake=1 overrides the source's brake).
  private emitMergedInput(feedback: HTMLDivElement): void {
    const src = this.lastSourceInput;
    const merged: InputState = {
      steer: src.steer,
      brake: this.buttonDown ? 1 : src.brake,
    };
    this.connection.sendInput(merged);
    this.updateHaptics(merged.steer);

    const intensity = Math.max(Math.abs(merged.steer), merged.brake);
    const color = merged.brake > 0.05 ? 'rgba(239, 100, 97,' : 'rgba(255, 122, 24,';
    feedback.style.background = `radial-gradient(circle at center, ${color} ${intensity * 0.3}) 0%, rgba(0,0,0,0) 70%)`;
  }

  // Max-lock edge bump: a single firm pulse when |steer| reaches full lock.
  // Re-arms once steer drops below the hysteresis band so holding at the
  // limit (or jittering near it) doesn't spam vibration.
  private static readonly HAPTIC_MAX_PULSE_MS = 22;
  private static readonly HAPTIC_REARM_BELOW = 0.92;  // 1.0 − 0.08 hysteresis
  private updateHaptics(steer: number): void {
    const curr = Math.abs(steer);
    if (this.hapticArmed) {
      if (curr >= 1.0) {
        this.hapticArmed = false;
        this.vibrate(ControllerGame.HAPTIC_MAX_PULSE_MS);
      }
    } else if (curr < ControllerGame.HAPTIC_REARM_BELOW) {
      this.hapticArmed = true;
    }
  }

  private attachButton(feedback: HTMLDivElement): void {
    const btn = document.getElementById('brake-btn') as HTMLButtonElement | null;
    if (!btn) return;

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      try { btn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      this.buttonDown = true;
      btn.classList.add('active');
      this.source?.setBrakeButtonPressed(true);
      this.startBrakeVibration();
      this.emitMergedInput(feedback);
    };
    const onUp = (e: PointerEvent) => {
      if (!this.buttonDown) return;
      this.buttonDown = false;
      btn.classList.remove('active');
      try { btn.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      this.source?.setBrakeButtonPressed(false);
      this.stopBrakeVibration();
      this.emitMergedInput(feedback);
    };

    btn.addEventListener('pointerdown', onDown);
    btn.addEventListener('pointerup', onUp);
    btn.addEventListener('pointercancel', onUp);

    this.buttonDisposer = () => {
      btn.removeEventListener('pointerdown', onDown);
      btn.removeEventListener('pointerup', onUp);
      btn.removeEventListener('pointercancel', onUp);
      btn.classList.remove('active');
      this.buttonDown = false;
      this.stopBrakeVibration();
    };
  }

  // Continuous buzz while the BRAKE button is held. Each call issues an
  // 80 ms pulse; the interval re-fires every 60 ms so the next pulse
  // starts before the previous ends — no audible/tactile gap.
  private brakeVibrationTimer: ReturnType<typeof setInterval> | null = null;
  private startBrakeVibration(): void {
    this.stopBrakeVibration();
    if (!navigator.vibrate) return;
    navigator.vibrate(80);
    this.brakeVibrationTimer = setInterval(() => {
      navigator.vibrate(80);
    }, 60);
  }
  private stopBrakeVibration(): void {
    if (this.brakeVibrationTimer !== null) {
      clearInterval(this.brakeVibrationTimer);
      this.brakeVibrationTimer = null;
    }
    if (navigator.vibrate) navigator.vibrate(0);
  }

  private disposeControls(): void {
    this.source?.dispose();
    this.source = null;
    this.buttonDisposer?.();
    this.buttonDisposer = null;
  }

  // Display ended the race and went back to its lobby — bounce out of the
  // game / results screen so the player is ready for the next race. Also
  // clears the late-joiner waiting flag so the start button reappears.
  private onReturnToLobby(): void {
    this.disposeControls();
    this.waitingForNextGame = false;
    document.getElementById('pause-overlay')?.classList.add('hidden');
    if (this.currentScreen !== 'name-screen') {
      this.showScreen('lobby-screen');
      this.refreshLobbyStatus();
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
    this.disposeControls();
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
      if (status) status.textContent = max > 0 ? `Attempt ${Math.min(attempt, max)}/${max}…` : 'Connection lost…';
      rejoin?.classList.add('hidden');
    }
  }

  private onConnected(): void {
    document.getElementById('reconnect-overlay')?.classList.add('hidden');
  }

  private resultsBtnTimer: ReturnType<typeof setTimeout> | null = null;
  private showResults(standings: RaceEndStanding[]): void {
    this.disposeControls();
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

