import { test, expect } from '@playwright/test';
import { openDisplay, joinController, attemptJoinController, waitForDisplayPlayers } from './helpers';

test('5th controller is rejected with room-full error', async ({ browser }) => {
  const ctx = await browser.newContext();
  const { page: display, roomCode } = await openDisplay(ctx);

  // Fill the room with the maximum 4 players.
  await joinController(ctx, roomCode, 'Alice');
  await joinController(ctx, roomCode, 'Bob');
  await joinController(ctx, roomCode, 'Carol');
  await joinController(ctx, roomCode, 'Dave');
  await waitForDisplayPlayers(display, 4);

  // The 5th joiner should be bounced back to the name screen with a
  // "Room is full" error visible in the room-gone block.
  const reject = await attemptJoinController(ctx, roomCode, 'Eve');
  await expect(reject.locator('#room-gone-message')).toBeVisible({ timeout: 10_000 });
  await expect(reject.locator('#room-gone-heading')).toHaveText(/full/i);
  // The lobby screen should not have been shown to this client.
  await expect(reject.locator('#lobby-screen')).toBeHidden();
  // The display should still show exactly 4 players.
  await waitForDisplayPlayers(display, 4);

  await ctx.close();
});
