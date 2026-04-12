// DisplayGame — top-level state machine for the display side.
//
// States:
//   WELCOME → LOBBY → COUNTDOWN → RACING → FINISHED → LOBBY (play again)
//
// Owns:
//   - Screen visibility
//   - DisplayConnection lifecycle
//   - RaceSim creation/teardown
//   - Countdown overlay
//   - Wake lock acquisition
//   - Toolbar (mute + fullscreen) wiring

import { ROOM_STATE, TOTAL_LAPS, MAX_PLAYERS, PLAYER_COLORS, MUTED_STORAGE_KEY, type RoomState } from '@shared/protocol';
import { DisplayConnection, type Player } from './DisplayConnection';
import { DisplayState } from './DisplayState';
import { RaceSim } from './RaceSim';
import { SplitScreen } from './SplitScreen';
import { KeyboardDebug } from './KeyboardDebug';
import { Hud } from './Hud';
import { Audio } from './Audio';
import { driftTuning } from './Car';

// Note: #results-screen is intentionally NOT in this list — it's an overlay
// that sits over the game screen and is toggled directly via the .hidden class.
const SCREENS = {
  WELCOME: 'welcome-screen',
  LOBBY: 'lobby-screen',
  GAME: 'game-screen',
} as const;
type ScreenId = (typeof SCREENS)[keyof typeof SCREENS];

const COUNTDOWN_INTERVAL_MS = 1000;

export class DisplayGame {
  state: DisplayState;
  connection: DisplayConnection;
  sim: RaceSim | null = null;
  splitScreen: SplitScreen | null = null;
  hud: Hud | null = null;
  keyboard: KeyboardDebug | null = null;
  audio: Audio = new Audio();
  roomState: RoomState = ROOM_STATE.LOBBY;
  currentScreen: ScreenId = 'welcome-screen';

  private wakeLock: WakeLockSentinel | null = null;
  private readonly debug: boolean;
  private muted = false;
  private started = false;

  constructor() {
    this.state = new DisplayState();
    this.connection = new DisplayConnection(this.state, {
      onLobbyChanged: () => this.renderLobby(),
      onPlayerInput: (clientId, input) => {
        // Inputs only matter once we have a sim. Late inputs in lobby ignored.
        this.sim?.applyHumanInput(clientId, input);
      },
      onStartRequested: () => {
        // Phone tapped "Start" — gate on current state and player count.
        if (this.roomState === ROOM_STATE.LOBBY) this.onStartRequested();
        else if (this.roomState === ROOM_STATE.FINISHED) this.returnToLobby();
      },
      onPauseRequested: () => this.pauseGame(),
      onResumeRequested: () => this.resumeGame(),
      onReturnToLobbyRequested: () => {
        this.resumeGame();
        this.returnToLobby();
      },
      onPlayAgainRequested: () => {
        if (this.roomState === ROOM_STATE.FINISHED) this.playAgain();
      },
      onRelayLost: (attempt, max, exhausted) => this.onRelayLost(attempt, max, exhausted),
      onRelayRestored: () => this.onRelayRestored(),
      onPlayerAlive: (clientId) => this.onPlayerAlive(clientId),
      onPlayerDead: (clientId) => this.onPlayerDead(clientId),
      isAcceptingPlayers: () => this.roomState === ROOM_STATE.LOBBY,
      getRoomState: () => this.roomState,
    });
    this.debug = new URLSearchParams(location.search).has('debug');

    // Restore persisted mute state.
    try {
      this.muted = localStorage.getItem(MUTED_STORAGE_KEY) === '1';
    } catch {
      /* ignore sandboxed iframe errors */
    }

    this.bindWelcomeHandlers();
    this.bindToolbarHandlers();
    this.bindMobileHint();
    this.bindHistoryNav();
    this.bindCursorAutoHide();
  }

  // Hide the cursor + game toolbar after 3 s of no mouse movement on the
  // game screen. Mirrors Tetris's couch-mode behavior.
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;
  private bindCursorAutoHide(): void {
    const showCursor = () => {
      document.body.classList.remove('cursor-hidden');
      document.getElementById('game-toolbar')?.classList.remove('toolbar-autohide');
      if (this.cursorTimer) clearTimeout(this.cursorTimer);
      this.cursorTimer = setTimeout(() => {
        document.body.classList.add('cursor-hidden');
        if (this.currentScreen === 'game-screen') {
          document.getElementById('game-toolbar')?.classList.add('toolbar-autohide');
        }
      }, 3000);
    };
    document.addEventListener('mousemove', showCursor);
    showCursor();
  }

  // Called from welcome-screen click handler (or auto in debug mode).
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.audio.init();
    this.audio.setMuted(this.muted);
    await this.acquireWakeLock();
    this.connection.connectAndCreateRoom();
    this.showScreen('lobby-screen');
    this.renderLobby();
    this.bindLobbyHandlers();
    this.bindResultsHandlers();
    // Push a history entry so browser back returns to the welcome screen.
    history.pushState({ screen: 'lobby' }, '');
  }

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  private bindWelcomeHandlers(): void {
    const newGameBtn = document.getElementById('new-game-btn') as HTMLButtonElement | null;
    newGameBtn?.addEventListener('click', () => {
      void this.start();
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => { /* ignore */ });
      }
    });
  }

  private bindLobbyHandlers(): void {
    const startBtn = document.getElementById('start-btn') as HTMLButtonElement | null;
    if (startBtn) startBtn.onclick = () => this.onStartRequested();
  }

  // Push a history entry when leaving the welcome screen so the browser
  // back button (or swipe-back gesture) returns to it. Mirrors Tetris's
  // popstate handling.
  private bindHistoryNav(): void {
    window.addEventListener('popstate', () => {
      // Welcome → lobby pushed an entry; popping it should reset to welcome
      // regardless of the current screen.
      if (this.currentScreen !== 'welcome-screen') {
        this.resetToWelcome();
      }
    });

    // Browsers drop the wake lock on tab hide. Re-acquire it on return when
    // we're actually mid-race so the screen doesn't dim during play.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (this.wakeLock !== null) return;
      if (this.roomState === ROOM_STATE.RACING || this.roomState === ROOM_STATE.COUNTDOWN) {
        void this.acquireWakeLock();
      }
    });
  }

  private bindResultsHandlers(): void {
    const playAgainBtn = document.getElementById('play-again-btn') as HTMLButtonElement | null;
    if (playAgainBtn) playAgainBtn.onclick = () => this.playAgain();
    const newGameResultsBtn = document.getElementById('new-game-results-btn') as HTMLButtonElement | null;
    if (newGameResultsBtn) newGameResultsBtn.onclick = () => this.returnToLobby();
  }

  private bindToolbarHandlers(): void {
    const muteBtn = document.getElementById('mute-btn') as HTMLButtonElement | null;
    const fullscreenBtn = document.getElementById('fullscreen-btn') as HTMLButtonElement | null;
    const pauseBtn = document.getElementById('pause-btn') as HTMLButtonElement | null;
    if (muteBtn) {
      muteBtn.classList.toggle('muted', this.muted);
      muteBtn.addEventListener('click', () => this.toggleMute());
    }
    if (fullscreenBtn) {
      fullscreenBtn.addEventListener('click', () => {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen().catch(() => { /* ignore */ });
        } else {
          document.exitFullscreen().catch(() => { /* ignore */ });
        }
      });
    }
    if (pauseBtn) {
      pauseBtn.addEventListener('click', () => this.pauseGame());
    }
    const reconnectBtn = document.getElementById('display-reconnect-btn') as HTMLButtonElement | null;
    reconnectBtn?.addEventListener('click', () => {
      // Display-side reconnect rebuilds a fresh room (the relay GCs the
      // original room when the creator disconnects). Cleanest path is a
      // full reload — controllers will hit room-gone and re-scan.
      location.reload();
    });
    const continueBtn = document.getElementById('pause-continue-btn') as HTMLButtonElement | null;
    const newGameBtn = document.getElementById('pause-newgame-btn') as HTMLButtonElement | null;
    continueBtn?.addEventListener('click', () => this.resumeGame());
    newGameBtn?.addEventListener('click', () => {
      this.resumeGame();
      this.returnToLobby();
    });
  }

  private bindMobileHint(): void {
    const btn = document.getElementById('mobile-hint-btn');
    btn?.addEventListener('click', () => {
      document.getElementById('mobile-hint')?.remove();
    });
  }

  private toggleMute(): void {
    this.muted = !this.muted;
    this.audio.setMuted(this.muted);
    try {
      localStorage.setItem(MUTED_STORAGE_KEY, this.muted ? '1' : '0');
    } catch {
      /* ignore */
    }
    const muteBtn = document.getElementById('mute-btn');
    muteBtn?.classList.toggle('muted', this.muted);
  }

  // -------------------------------------------------------------------------
  // Lobby / race start
  // -------------------------------------------------------------------------

  private renderLobby(): void {
    const startBtn = document.getElementById('start-btn') as HTMLButtonElement | null;
    const list = document.getElementById('player-list') as HTMLDivElement | null;
    if (!list) return;

    // Render 4 slots: filled ones show name + color, empty ones are dashed.
    const playersById = this.state.playerOrder
      .map((id) => this.state.players.get(id))
      .filter((p): p is Player => !!p);

    // Track which slots existed before so new joins can pop-in.
    const existing = new Set<number>();
    list.querySelectorAll('.player-card.filled').forEach((el) => {
      const slot = el.getAttribute('data-slot');
      if (slot != null) existing.add(Number(slot));
    });

    list.innerHTML = '';
    const byCarId = new Map<number, Player>();
    for (const p of playersById) byCarId.set(p.carId, p);

    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      const card = document.createElement('div');
      card.className = 'player-card';
      card.dataset.slot = String(slot);
      const player = byCarId.get(slot);
      if (player) {
        card.classList.add('filled');
        if (!existing.has(slot)) card.classList.add('join-pop');
        card.style.setProperty('--player-color', player.color);
        const dot = document.createElement('span');
        dot.className = 'player-dot';
        const name = document.createElement('span');
        name.className = 'player-name';
        name.textContent = player.name;
        card.appendChild(dot);
        card.appendChild(name);
      } else {
        card.classList.add('empty');
        card.style.setProperty('--player-color', PLAYER_COLORS[slot] || '');
        const name = document.createElement('span');
        name.className = 'player-name';
        name.textContent = `P${slot + 1}`;
        card.appendChild(name);
      }
      list.appendChild(card);
    }

    if (startBtn) {
      const hasPlayers = playersById.length > 0;
      const ready = this.debug || hasPlayers;
      startBtn.disabled = !ready;
      startBtn.textContent = ready
        ? hasPlayers
          ? `START RACE (${playersById.length})`
          : 'START RACE'
        : 'WAITING FOR PLAYERS…';
    }
  }

  private onStartRequested(): void {
    if (this.roomState !== ROOM_STATE.LOBBY) return;
    if (this.currentScreen !== 'lobby-screen') return;
    const hasHumans = this.state.playerOrder.length > 0;
    if (!this.debug && !hasHumans) return;
    void this.startRace();
  }

  private async startRace(): Promise<void> {
    this.roomState = ROOM_STATE.COUNTDOWN;
    this.showScreen('game-screen');
    await this.initSim();
    // The race actually unfreezes the moment "GO" appears (inside
    // runCountdown), not after it disappears.
    await this.runCountdown();
  }

  // -------------------------------------------------------------------------
  // Pause / resume / reset-to-welcome
  // -------------------------------------------------------------------------

  pauseGame(): void {
    if (!this.sim || this.sim.isPaused()) return;
    if (this.roomState !== ROOM_STATE.RACING) return;
    this.sim.pause();
    this.connection.broadcastPaused();
    document.getElementById('pause-overlay')?.classList.remove('hidden');
  }

  resumeGame(): void {
    if (!this.sim || !this.sim.isPaused()) return;
    this.sim.resume();
    this.connection.broadcastResumed();
    document.getElementById('pause-overlay')?.classList.add('hidden');
  }

  // Skip the lobby and immediately start a new race with the same players.
  playAgain(): void {
    if (this.roomState !== ROOM_STATE.FINISHED) return;
    document.getElementById('results-screen')?.classList.add('hidden');
    this.teardownSim();
    this.roomState = ROOM_STATE.LOBBY;
    // Absorb late joiners and drop disconnected racers so the next race
    // includes everyone who's currently connected.
    this.connection.absorbLateJoiners();
    if (this.state.playerOrder.length === 0 && !this.debug) return;
    void this.startRace();
  }

  // -------------------------------------------------------------------------
  // Relay reconnect lifecycle
  // -------------------------------------------------------------------------

  private onRelayLost(attempt: number, max: number, exhausted: boolean): void {
    if (this.currentScreen === 'welcome-screen') return;
    const overlay = document.getElementById('display-reconnect-overlay');
    const heading = document.getElementById('display-reconnect-heading');
    const status = document.getElementById('display-reconnect-status');
    const btn = document.getElementById('display-reconnect-btn');
    overlay?.classList.remove('hidden');
    if (exhausted) {
      if (heading) heading.textContent = 'DISCONNECTED';
      if (status) status.textContent = 'Could not reconnect to the relay.';
      btn?.classList.remove('hidden');
    } else {
      if (heading) heading.textContent = 'RECONNECTING';
      if (status) status.textContent = max > 0 ? `Attempt ${Math.min(attempt, max)}/${max}…` : 'Connection lost…';
      btn?.classList.add('hidden');
    }
  }

  private onRelayRestored(): void {
    document.getElementById('display-reconnect-overlay')?.classList.add('hidden');
  }

  private onPlayerAlive(clientId: string): void {
    const player = this.state.players.get(clientId);
    if (player && this.hud) this.hud.setDisconnected(player.carId, false);
  }

  private onPlayerDead(clientId: string): void {
    if (this.roomState !== ROOM_STATE.RACING && this.roomState !== ROOM_STATE.COUNTDOWN) return;
    const player = this.state.players.get(clientId);
    if (player && this.hud) this.hud.setDisconnected(player.carId, true, clientId);
  }

  resetToWelcome(): void {
    this.teardownSim();
    this.connection.close();
    this.state.players.clear();
    this.state.playerOrder = [];
    this.state.roomCode = null;
    this.state.joinUrl = null;
    this.roomState = ROOM_STATE.LOBBY;
    document.getElementById('pause-overlay')?.classList.add('hidden');
    document.getElementById('results-screen')?.classList.add('hidden');
    this.started = false;
    this.showScreen('welcome-screen');
  }

  // -------------------------------------------------------------------------
  // Sim / render lifecycle
  // -------------------------------------------------------------------------

  private teardownSim(): void {
    this.sim?.dispose();
    this.sim = null;
    this.splitScreen?.dispose();
    this.splitScreen = null;
    this.hud = null;
    this.keyboard?.dispose();
    this.keyboard = null;
  }

  private async initSim(): Promise<void> {
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    const hudLayer = document.getElementById('hud-layer') as HTMLDivElement;

    // Snapshot human players (slots 0..N-1); AI fills 4-N seats.
    const humans = [...this.state.playerOrder]
      .map((id) => this.state.players.get(id))
      .filter((p): p is Player => !!p);
    const totalCars = 4;
    const aiCount = this.debug ? 0 : Math.max(0, totalCars - humans.length);

    this.sim = new RaceSim({
      canvas,
      humans,
      aiCount,
      totalLaps: TOTAL_LAPS,
      onLapCompleted: (carId, lap) => {
        this.connection.sendLapUpdate(carId, lap);
        this.audio.lapBell();
      },
      onRaceFinished: (standings) => this.onRaceFinished(standings),
    });
    await this.sim.init();
    for (const car of this.sim.cars) this.audio.attachCar(car);

    // Debug keyboard takeover MUST run before constructing SplitScreen.
    // SplitScreen filters by `!c.isAI` to decide which cars get a chase-cam
    // viewport; if we leave the target car as AI, the keyboard input is
    // overwritten by the AI driver every tick AND there's no viewport for it
    // (the spectator-camera fallback kicks in instead).
    if (this.debug && humans.length === 0) {
      const target = this.sim.takeOverAiCar(0);
      if (target) this.keyboard = new KeyboardDebug(target);
    }
    if (this.debug) this.createDriftSliders();

    this.splitScreen = new SplitScreen(canvas, hudLayer, this.sim.renderer, this.sim.cars.filter((c) => !c.isAI));
    this.hud = new Hud(hudLayer, this.splitScreen);
    if (this.state.joinUrl) this.hud.setJoinUrl(this.state.joinUrl);
    this.splitScreen.recalcLayout();

    // Start render loop.
    this.sim.startRenderLoop((dt) => {
      this.keyboard?.tick(dt);
      this.splitScreen?.render(this.sim!.scene);
      this.hud?.update(this.sim!);
      // Engine audio: only the local viewport's car is audible.
      for (const car of this.sim!.cars) {
        const audible = !car.isAI && this.sim!.cars.indexOf(car) === 0; // first human only, for now
        this.audio.setCarSpeed(car.carId, car.speed, audible);
      }
    });
  }

  private createDriftSliders(): void {
    // Remove existing panel if present (play-again).
    document.getElementById('drift-debug')?.remove();

    const panel = document.createElement('div');
    panel.id = 'drift-debug';
    Object.assign(panel.style, {
      position: 'fixed', top: '12px', left: '12px', zIndex: '99999',
      background: 'rgba(0,0,0,0.85)', color: '#fff', padding: '12px 16px',
      borderRadius: '8px', fontFamily: 'monospace', fontSize: '14px',
      display: 'flex', flexDirection: 'column', gap: '8px',
      border: '2px solid #ff0', pointerEvents: 'auto',
    } as CSSStyleDeclaration);

    const makeSlider = (label: string, key: keyof typeof driftTuning, min: number, max: number, step: number) => {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '8px';

      const lbl = document.createElement('span');
      lbl.style.width = '100px';
      lbl.textContent = label;

      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(driftTuning[key]);
      input.style.width = '120px';

      const val = document.createElement('span');
      val.style.width = '40px';
      val.textContent = String(driftTuning[key]);

      input.addEventListener('input', () => {
        driftTuning[key] = parseFloat(input.value);
        val.textContent = input.value;
      });

      row.append(lbl, input, val);
      return row;
    };

    panel.appendChild(makeSlider('extraRadius', 'extraRadius', 30, 200, 5));
    // Append to game-screen so it survives screen transitions.
    const target = document.getElementById('game-screen') || document.body;
    target.appendChild(panel);
  }

  private async runCountdown(): Promise<void> {
    const overlay = document.getElementById('countdown-overlay')!;
    const value = document.getElementById('countdown-value')!;
    overlay.classList.remove('hidden');

    // 3 → 2 → 1 (cars frozen).
    for (const tick of ['3', '2', '1'] as const) {
      value.textContent = tick;
      this.connection.broadcastCountdown(parseInt(tick) as 1 | 2 | 3);
      this.audio.countdownTick();
      await new Promise((r) => setTimeout(r, COUNTDOWN_INTERVAL_MS));
    }

    // GO! — show + sound + start the race in the same frame so cars
    // accelerate at the very moment "GO" appears, not after it disappears.
    value.textContent = 'GO';
    this.connection.broadcastCountdown('GO');
    this.audio.countdownGo();
    this.roomState = ROOM_STATE.RACING;
    this.connection.broadcastRaceStart();
    this.sim?.startRace();

    // Keep "GO" visible briefly so players can see it; cars are already moving.
    await new Promise((r) => setTimeout(r, COUNTDOWN_INTERVAL_MS));
    overlay.classList.add('hidden');
  }

  private resultsBtnTimer: ReturnType<typeof setTimeout> | null = null;
  private onRaceFinished(standings: { carId: number; name: string; placement: number; totalTime: number }[]): void {
    this.roomState = ROOM_STATE.FINISHED;
    this.connection.broadcastRaceEnd(standings);
    // Results sit as an overlay over the still-rendering game screen so the
    // race world stays visible behind the standings.
    document.getElementById('results-screen')?.classList.remove('hidden');

    // Disable both buttons for 2 s so a player still finishing isn't yanked
    // by an accidental tap into a new race.
    const playAgainBtn = document.getElementById('play-again-btn') as HTMLButtonElement | null;
    const newGameBtn = document.getElementById('new-game-results-btn') as HTMLButtonElement | null;
    if (playAgainBtn) playAgainBtn.disabled = true;
    if (newGameBtn) newGameBtn.disabled = true;
    if (this.resultsBtnTimer) clearTimeout(this.resultsBtnTimer);
    this.resultsBtnTimer = setTimeout(() => {
      if (playAgainBtn) playAgainBtn.disabled = false;
      if (newGameBtn) newGameBtn.disabled = false;
    }, 2000);
    const ol = document.getElementById('standings') as HTMLOListElement;
    ol.innerHTML = '';
    for (const s of standings) {
      const li = document.createElement('li');
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
      ol.appendChild(li);
    }
  }

  private returnToLobby(): void {
    document.getElementById('results-screen')?.classList.add('hidden');
    this.teardownSim();
    this.roomState = ROOM_STATE.LOBBY;
    // Absorb late joiners and drop disconnected racers before rebuilding
    // the lobby. Must happen after roomState is LOBBY so isAcceptingPlayers
    // returns true for any new peer_joined events during the transition.
    this.connection.absorbLateJoiners();
    // Broadcast a fresh lobby snapshot so controllers re-render their list
    // and bounce out of the game/finished screens.
    this.connection.broadcastReturnToLobby();
    this.connection.broadcastLobbyUpdate();
    this.showScreen('lobby-screen');
    this.renderLobby();
  }

  // -------------------------------------------------------------------------
  // Utility
  // -------------------------------------------------------------------------

  private showScreen(id: ScreenId): void {
    this.currentScreen = id;
    for (const sid of Object.values(SCREENS)) {
      const el = document.getElementById(sid);
      if (el) el.classList.toggle('hidden', sid !== id);
    }
    // Toolbar is hidden on welcome, visible everywhere else.
    const toolbar = document.getElementById('game-toolbar');
    if (toolbar) toolbar.classList.toggle('hidden', id === 'welcome-screen');
    // Pause button only makes sense on the game screen.
    const pauseBtn = document.getElementById('pause-btn');
    if (pauseBtn) pauseBtn.classList.toggle('hidden', id !== 'game-screen');
  }

  private async acquireWakeLock(): Promise<void> {
    try {
      const wl = (navigator as Navigator & { wakeLock?: { request(type: string): Promise<WakeLockSentinel> } }).wakeLock;
      if (!wl) return;
      const sentinel = await wl.request('screen');
      this.wakeLock = sentinel;
      sentinel.addEventListener('release', () => {
        if (this.wakeLock === sentinel) this.wakeLock = null;
      });
    } catch {
      // Best-effort; not all browsers support it.
    }
  }
}
