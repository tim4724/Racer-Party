// Playwright helpers — open the display, wait for a room code, then join
// controllers and assert basic state. Adapted from Tetris's e2e helpers.

import { type BrowserContext, type Page, expect } from '@playwright/test';

export interface DisplayHandles {
  page: Page;
  roomCode: string;
}

export async function openDisplay(context: BrowserContext): Promise<DisplayHandles> {
  const page = await context.newPage();
  await page.goto('/?debug=1');
  // ?debug=1 skips welcome screen and connects automatically.
  // Wait until the join URL element contains a 4-letter room code.
  const joinUrl = page.locator('#join-url');
  await expect(joinUrl).toHaveText(/^https?:\/\/[^/]+\/[A-Z0-9]{4}$/, { timeout: 30_000 });
  const url = (await joinUrl.textContent()) || '';
  const m = url.match(/\/([A-Z0-9]{4})$/);
  if (!m) throw new Error(`No room code in join URL: ${url}`);
  return { page, roomCode: m[1] };
}

export async function joinController(
  context: BrowserContext,
  roomCode: string,
  name: string,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/${roomCode}`);
  await page.locator('#name-input').fill(name);
  await page.locator('#join-btn').click();
  // After joining, the lobby screen should appear once WELCOME arrives.
  await expect(page.locator('#lobby-screen')).toBeVisible({ timeout: 15_000 });
  return page;
}

// Like joinController but doesn't assert lobby visibility — used by error
// tests that expect a rejection back to the name screen.
export async function attemptJoinController(
  context: BrowserContext,
  roomCode: string,
  name: string,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`/${roomCode}`);
  await page.locator('#name-input').fill(name);
  await page.locator('#join-btn').click();
  return page;
}

export async function waitForDisplayPlayers(display: Page, count: number): Promise<void> {
  await expect(display.locator('#player-list .player-card.filled')).toHaveCount(count, { timeout: 15_000 });
}
