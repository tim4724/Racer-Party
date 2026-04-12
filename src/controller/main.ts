// Controller entry point. Parses the room code from the URL and constructs
// ControllerGame — it wires up its own name / lobby / game / finished
// handlers internally.

import { ControllerGame } from './ControllerGame';

// Party-Sockets room codes are 4 chars: uppercase letters + digits.
const ROOM_CODE_RE = /^\/([A-Z0-9]{4})$/;
const match = window.location.pathname.match(ROOM_CODE_RE);
const roomCode = match ? match[1] : null;

if (!roomCode) {
  document.body.innerHTML = '<p style="padding:32px;color:#fff">No room code in URL. Scan the QR on the display to join.</p>';
} else {
  // Prefill a previously-used name, if any.
  let stored = '';
  try {
    stored = localStorage.getItem('racer_player_name') || '';
  } catch {
    /* ignore */
  }
  const nameInput = document.getElementById('name-input') as HTMLInputElement | null;
  if (nameInput) {
    nameInput.value = stored;
    // Don't auto-focus on mobile — this would pop the keyboard unexpectedly.
    if (!('ontouchstart' in window)) nameInput.focus();
  }

  // Construct the game — it binds handlers to form submit / buttons.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const game = new ControllerGame(roomCode);
  void game;
}
