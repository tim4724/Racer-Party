import { test, expect } from '@playwright/test';
import { openDisplay, joinController, waitForDisplayPlayers } from './helpers';

test('display creates a room and 2 controllers join', async ({ browser }) => {
  const ctx = await browser.newContext();
  const { page: display, roomCode } = await openDisplay(ctx);
  expect(roomCode).toMatch(/^[A-Z0-9]{4}$/);

  await joinController(ctx, roomCode, 'Alice');
  await joinController(ctx, roomCode, 'Bob');

  await waitForDisplayPlayers(display, 2);

  const names = await display.locator('#player-list .player-card.filled').allTextContents();
  const joined = names.join(' ');
  expect(joined).toContain('Alice');
  expect(joined).toContain('Bob');

  await ctx.close();
});
