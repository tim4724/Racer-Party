import { test, expect } from '@playwright/test';
import { openDisplay, joinController, waitForDisplayPlayers } from './helpers';

// Mid-race: a player disconnects, then a different phone scans the
// disconnect-overlay QR (carrying ?rejoin=<carId>). The new peer should
// take over the orphaned slot rather than be rejected as a late joiner.
test('different phone reclaims orphaned slot via ?rejoin=<carId>', async ({ browser }) => {
  const ctx = await browser.newContext();
  const { page: display, roomCode } = await openDisplay(ctx);

  const alice = await joinController(ctx, roomCode, 'Alice');
  await waitForDisplayPlayers(display, 1);

  // Start the race so disconnects are tracked as orphans, not lobby leaves.
  await display.locator('#start-btn').click();
  await expect(display.locator('#game-screen')).toBeVisible({ timeout: 10_000 });
  // Wait until the countdown is over so we're firmly in the racing state —
  // peer_left during racing routes through the leftDuringRace path.
  await expect(display.locator('#countdown-overlay')).toBeHidden({ timeout: 10_000 });

  // Alice rage-quits. Her car becomes orphaned at carId 0.
  await alice.close();

  // Disconnect overlay shows on Alice's viewport once heartbeat times out.
  await expect(display.locator('.viewport-disconnect:not(.hidden)')).toBeVisible({ timeout: 10_000 });

  // A different phone scans the disconnect QR. Use a fresh context so its
  // sessionStorage is empty — the relay will hand it a new clientId, so the
  // only thing tying it to Alice's slot is the ?rejoin=0 URL hint.
  const reclaimerCtx = await browser.newContext();
  const reclaimer = await reclaimerCtx.newPage();
  await reclaimer.goto(`/${roomCode}?rejoin=0`);

  // The display's swap should clear the disconnect overlay within a few seconds.
  await expect(display.locator('.viewport-disconnect:not(.hidden)')).toHaveCount(0, { timeout: 15_000 });

  await reclaimerCtx.close();
  await ctx.close();
});
