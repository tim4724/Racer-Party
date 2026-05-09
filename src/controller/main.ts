// Controller entry point. Parses the room code from the URL and constructs
// ControllerGame — it wires up its own name / lobby / game / finished
// handlers internally.

import { ControllerGame } from './ControllerGame';

// Party-Sockets room codes are 6-char base58 (mixed case, no 0/O/I/l).
const ROOM_CODE_RE = /^\/([A-Za-z0-9]{6})$/;
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

  // Check for a prior session BEFORE constructing ControllerGame — its
  // constructor writes a fresh clientId to sessionStorage, so reading
  // after would always be truthy.
  let hadStoredId = false;
  try { hadStoredId = !!sessionStorage.getItem('racer_client_' + roomCode); } catch { /* ignore */ }

  // Construct the game — it binds handlers to form submit / buttons.
  const game = new ControllerGame(roomCode);

  // Auto-connect (skip name screen) when we have a stored clientId for this
  // room — that's how we recognise the same phone returning after a tab
  // eviction or reload, and the relay maps the clientId back to the slot.
  if (hadStoredId) {
    game.join(stored);
  }
}
