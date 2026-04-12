import { test, expect } from '@playwright/test';
import { openDisplay, joinController, waitForDisplayPlayers } from './helpers';

// A full 3-lap race takes a real amount of wall-clock time. This test only
// asserts the lifecycle: lobby → countdown → racing → finished. The actual
// physics-driven completion is exercised in interactive play.
test('lobby → countdown → racing transitions cleanly', async ({ browser }) => {
  const ctx = await browser.newContext();
  const { page: display, roomCode } = await openDisplay(ctx);

  await joinController(ctx, roomCode, 'Alice');
  await waitForDisplayPlayers(display, 1);

  await display.locator('#start-btn').click();
  // Game canvas should appear within a few seconds.
  await expect(display.locator('#game-screen')).toBeVisible({ timeout: 10_000 });
  // Countdown overlay flashes briefly.
  await expect(display.locator('#countdown-overlay')).toBeVisible({ timeout: 5_000 });
  // Eventually it disappears and racing begins.
  await expect(display.locator('#countdown-overlay')).toBeHidden({ timeout: 10_000 });

  await ctx.close();
});
