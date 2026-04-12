// Display entry point. Constructs the DisplayGame — it wires up its own
// welcome-screen / lobby / toolbar handlers internally. Audio context init
// is gated behind the welcome-screen button click (browser autoplay policy).

import { DisplayGame } from './DisplayGame';

const game = new DisplayGame();

// Allow ?debug=1 to skip the welcome screen for fast iteration.
if (new URLSearchParams(location.search).has('debug')) {
  queueMicrotask(() => {
    void game.start();
  });
}
